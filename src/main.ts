import {App, MarkdownView, Modal, Notice, Plugin, Setting, TAbstractFile, TFile} from "obsidian";
import {EditorView, ViewUpdate} from "@codemirror/view";
import {EditorState, Transaction, Extension} from "@codemirror/state";
import {DEFAULT_SETTINGS, ExternalDiffSettings, ExternalDiffSettingTab, manualEditorEvents} from "./settings";
import {DiffView, DIFF_VIEW_TYPE, PendingDiff} from "./DiffView";
import {PersistedDiffEntry, restoreReview} from "./reviewDraft";
import {EXPORT_TEXT_VIEW, ExportTextView} from "./export/ExportTextView";
import {formatExportFilename} from "./export/filename";
import {validContextLines} from "./export/unifiedDiff";
import {RenameMatcher} from "./renameMatcher";
import {RenameReviewModal} from "./renameReviewModal";
import {InternalOperations} from "./internalOperations";
import {checkpoint, readCheckpoint} from "./checkpoint";
import {markDeleted, markPresent} from "./reviewTransitions";
import {CreationQueue} from "./creationQueue";
import {ReviewOperations} from "./reviewOperations";
import {FileLifecycle} from "./fileLifecycle";
import {ProgrammaticEdits} from "./programmaticEdits";
import {DebugLog} from "./debugLog";
import {EditorSaves} from "./editorSaves";

interface PersistedData {
	settings?: Partial<ExternalDiffSettings>;
	pendingDiffs?: PersistedDiffEntry[];
	baselines?: [string, string][];
}

/** How long an internal-write mark stays valid before the CM6 "set" it announces must have arrived. */
const INTERNAL_WRITE_MARK_TTL_MS = 2000;

/** Prefer explicit typing/history annotations over the route through Editor API. */
function isManualEditorTransaction(tr: Transaction, events: readonly string[]): boolean {
	return events.some(event => tr.isUserEvent(event));
}

/** Extract the CM6 EditorView from a MarkdownView (internal Obsidian API). */
function getCmEditor(mdView: MarkdownView): EditorView | undefined {
	const editor: unknown = (mdView as unknown as Record<string, unknown>).editor;
	if (editor && typeof editor === "object") {
		const cm: unknown = (editor as Record<string, unknown>).cm;
		if (cm instanceof EditorView) return cm;
	}
	return undefined;
}

export default class ExternalDiffPlugin extends Plugin {
	settings: ExternalDiffSettings;
	private manualEvents = manualEditorEvents(DEFAULT_SETTINGS.manualEditorEvents);
	private pendingDiffs = new Map<string, PendingDiff>();
	private baselines = new Map<string, string>();
	private selfModifyPaths = new Set<string>();
	private typingContents = new EditorSaves();
	debugLog = new DebugLog(() => !!this.settings?.debug, () => ({
		detection: this.settings.enabled,
		otherEditor: this.settings.trackInAppChanges,
		editorApi: this.settings.trackProgrammaticChanges,
		fileApi: this.settings.trackApiChanges,
		manualEvents: this.manualEvents,
	}), message => { new Notice(message, 12000); });
	private programmaticEdits = new ProgrammaticEdits((event, details) => this.debugLog.write(event, details), () => !!this.settings?.debug);
	private internalWritePaths = new Map<string, number>();
	private pendingEditWarning = new Set<string>();
	private savedBaselines: [string, string][] | undefined;
	private initializing = false;
	private disposed = false;
	private startupEvents: (() => void)[] = [];
	private saveQueue: Promise<void> = Promise.resolve();
	private restoredDiffs: PersistedDiffEntry[] = [];
	private saveTimer: ReturnType<typeof activeWindow.setTimeout> | null = null;
	private applying = new Set<string>();
	private lifecycle: FileLifecycle;
	private renameMatcher: RenameMatcher;
	private baselineReady = false;
	private internalOperations: InternalOperations;
	private restoringPath: string | null = null;
	private reviewOperations?: ReviewOperations;
	private creationQueue = new CreationQueue((file, internal) => this.handleCreate(file, internal, true));

	private get operations(): ReviewOperations {
		return this.reviewOperations ??= new ReviewOperations({
			app: this.app, reviews: this.pendingDiffs, baselines: this.baselines,
			applying: this.applying, selfModifyPaths: this.selfModifyPaths,
			refreshMissing: () => this.refreshMissingReviews(), view: () => this.getExistingDiffView(),
			changed: () => { this.persistState(); this.renameMatcher?.schedule(); },
			make: (path, original, result) => this.makeDiffCallbacks(path, original, result),
			setRestoringPath: path => { this.restoringPath = path; },
		});
	}

	startDebugMonitoring(): void {
		this.debugLog.monitor(document, () => this.app.workspace.getActiveFile()?.path);
	}

	async onload() {
		await this.loadSettings();
		this.register(() => { void this.debugLog.stop(); });
		if (this.settings.debug) this.startDebugMonitoring();
		this.debugLog.write("plugin.loaded");

		this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, this.settings, () => this.renameMatcher?.status ?? ""));
		this.registerView(EXPORT_TEXT_VIEW, leaf => new ExportTextView(leaf));

		const syncEditors = () => this.programmaticEdits.sync(
			this.app.workspace.getLeavesOfType("markdown").flatMap(leaf => {
				const view = leaf.view as MarkdownView;
				return view.editor ? [{editor: view.editor, path: () => view.file?.path}] : [];
			}));
		this.register(() => this.programmaticEdits.dispose());
		this.registerEvent(this.app.workspace.on("layout-change", syncEditors));
		this.registerEvent(this.app.workspace.on("file-open", syncEditors));
		this.app.workspace.onLayoutReady(syncEditors);
		syncEditors();

		// CM6 detection: register updateListener on all editors
		this.registerEditorExtension(this.createDetectionExtension());

		// Classify Vault-API writes as internal; detect external changes to files
		// not open in any editor (CM6 handles files that are open)
		this.registerEvent(this.app.vault.on("modify", this.handleModify));

		this.renameMatcher = new RenameMatcher({vault: this.app.vault, settings: this.settings,
			reviews: this.pendingDiffs, baselines: this.baselines, busy: path => this.applying.has(path),
			changed: () => { this.persistState(); this.getExistingDiffView()?.syncFiles(this.pendingDiffs); },
		});
		this.register(() => this.renameMatcher.dispose());
		this.lifecycle = new FileLifecycle({vault: this.app.vault, settings: this.settings,
			baselines: this.baselines, reviews: this.pendingDiffs,
			make: (path, original, result) => this.makeDiffCallbacks(path, original, result),
			changed: () => {
				this.renameMatcher.schedule();
				this.refreshMissingReviews();
				this.persistState();
				this.getExistingDiffView()?.syncFiles(this.pendingDiffs);
				if (this.pendingDiffs.size && !this.getExistingDiffView()) void this.ensureDiffTab();
			},
		});
		this.register(() => this.lifecycle.dispose());

		this.internalOperations = new InternalOperations(this.app.vault);
		this.register(() => this.internalOperations.dispose());

		// Baseline housekeeping
		this.registerEvent(this.app.vault.on("create", this.handleCreate));
		this.registerEvent(this.app.vault.on("delete", file => {
			this.typingContents.delete(file.path);
			const internal = this.internalOperations.isInternal(file.path);
			const event = () => { if (!this.applying.has(file.path)) this.lifecycle.deleted(file, internal); };
			if (this.initializing) this.startupEvents.push(event); else event();
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			this.typingContents.delete(oldPath);
			const internal = this.internalOperations.isInternal(oldPath);
			const event = () => { if (this.restoringPath !== oldPath) this.lifecycle.rename(file, oldPath, internal); };
			if (this.initializing) this.startupEvents.push(event); else event();
		}));

		this.addCommand({
			id: "toggle-external-change-detection",
			name: "Toggle external change detection",
			callback: () => {
				this.settings.enabled = !this.settings.enabled;
				void this.saveSettings();
			},
		});

		this.addCommand({
			id: "open-diff-viewer",
			name: "Open diff viewer",
			callback: () => void this.openDiffTab(),
		});

		this.addSettingTab(new ExternalDiffSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			void this.initializeBaselinesAndRestore();
		});
	}

	onunload() {
		this.disposed = true;
		this.typingContents.clear();
		this.creationQueue.dispose();
		if (this.saveTimer) {
			activeWindow.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		void this.saveState();
	}

	async loadSettings() {
		const data: PersistedData = ((await this.loadData()) as PersistedData | null) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {});
		if (typeof this.settings.manualEditorEvents !== "string") this.settings.manualEditorEvents = DEFAULT_SETTINGS.manualEditorEvents;
		this.manualEvents = manualEditorEvents(this.settings.manualEditorEvents);
		this.settings.trackFileRenames = this.settings.trackFileDeletions = !!(this.settings.trackFileRenames || this.settings.trackFileDeletions);
		try { formatExportFilename(this.settings.exportFilenameTemplate); }
		catch { this.settings.exportFilenameTemplate = DEFAULT_SETTINGS.exportFilenameTemplate; }
		if (!validContextLines(this.settings.exportContextLines)) this.settings.exportContextLines = 3;
		this.restoredDiffs = data.pendingDiffs ?? [];
		this.savedBaselines = data.baselines;
	}

	async saveSettings() {
		this.manualEvents = manualEditorEvents(this.settings.manualEditorEvents);
		this.debugLog.write("settings.changed");
		this.renameMatcher?.schedule();
		for (const leaf of this.app.workspace.getLeavesOfType(DIFF_VIEW_TYPE)) {
			if (leaf.view instanceof DiffView) leaf.view.updateSettings();
		}
		await this.saveState();
	}

	/** Reconcile the existing startup scan against the last observed local checkpoint. */
	private async initializeBaselinesAndRestore(): Promise<void> {
		this.initializing = true;
		const previous = new Map(this.savedBaselines);
		const {contents, unavailable} = await readCheckpoint(this.app.vault);
		if (this.disposed) return;
		this.baselines.clear();
		for (const [path, text] of contents) this.baselines.set(path, text);
		for (const path of unavailable) {
			const text = previous.get(path);
			if (text !== undefined) this.baselines.set(path, text);
		}
		const restoredPaths = new Set(this.restoredDiffs.map(entry => entry.path));
		await this.restorePendingDiffs(this.restoredDiffs);
		if (this.disposed) return;
		this.restoredDiffs = [];
		if (this.settings.enabled && this.settings.reviewWhileClosed && this.savedBaselines !== undefined) {
			for (const [path, text] of contents) {
				if (restoredPaths.has(path)) continue;
				const before = previous.get(path);
				if (before !== text && (before !== undefined || this.settings.reviewNewFiles)) this.handleExternalChange(path, before ?? "", text, false, before === undefined);
			}
			for (const [path, text] of previous) {
				if (contents.has(path) || unavailable.has(path)) continue;
				const existing = this.pendingDiffs.get(path);
				if (!existing && !this.settings.trackFileRenames) continue;
				const diff = existing ?? this.makeDiffCallbacks(path, text, text);
				markDeleted(diff, existing ? !!existing.deletionOnly : true);
				this.pendingDiffs.set(path, diff);
			}
			for (const [path, text] of contents) {
				if (!previous.has(path)) this.renameMatcher.observe(path, text, true);
			}
		}
		this.baselineReady = true;
		this.initializing = false;
		for (const event of this.startupEvents.splice(0)) event();
		if (this.pendingDiffs.size) {
			const view = await this.ensureDiffTab();
			view.syncFiles(this.pendingDiffs);
		}
		await this.renameMatcher?.restore();
		if (unavailable.size) new Notice(`Drift could not read ${unavailable.size} files. Their previous checkpoints were kept; reload Drift to retry.`, 10000);
		await this.saveState();
	}

	private saveState(): Promise<void> {
		const data: PersistedData = {
			settings: {...this.settings},
			pendingDiffs: this.baselineReady ? this.serializePendingDiffs() : this.restoredDiffs,
			baselines: this.settings.reviewWhileClosed ? this.baselineReady ? checkpoint(this.baselines, this.pendingDiffs) : this.savedBaselines : undefined,
		};
		// Serialize writes so an earlier, slower save cannot replace newer state.
		this.saveQueue = this.saveQueue.then(() => this.saveData(data)).catch(error => {
			console.error("Drift: could not save review state", error);
			new Notice("Drift could not save reviews. Keep this session open and check storage before restarting.", 10000);
		});
		return this.saveQueue;
	}

	/** Mark a path as being modified by the plugin itself (suppresses detection). */
	markAsSelfModify(path: string): void {
		this.selfModifyPaths.add(path);
	}

	/** Consume a pending internal-write mark for a path; true if one exists and is fresh. */
	private consumeInternalWriteMark(path: string): boolean {
		const markedAt = this.internalWritePaths.get(path);
		if (markedAt === undefined) return false;
		this.internalWritePaths.delete(path);
		return Date.now() - markedAt < INTERNAL_WRITE_MARK_TTL_MS;
	}

	/** Serialize pending diffs to a persistable format. */
	private serializePendingDiffs(): PersistedDiffEntry[] {
		return Array.from(this.pendingDiffs.entries()).map(([path, diff]) => ({
			path,
			created: diff.created,
			oldContent: diff.oldContent,
			newContent: diff.newContent,
			draftContent: diff.draftContent,
			originalPath: diff.originalPath,
			deleted: diff.deleted,
			deletionOnly: diff.deletionOnly,
			matchContent: diff.matchContent,
			renameCandidates: diff.renameCandidates,
			renameSources: diff.renameSources,
			renameDismissed: diff.renameDismissed,
			internalReview: diff.internalReview,
		}));
	}

	/** Schedule a debounced save of state to disk. */
	private persistState(): void {
		if (this.saveTimer || this.initializing) return;
		this.saveTimer = activeWindow.setTimeout(() => {
			this.saveTimer = null;
			void this.saveState();
		}, 500);
	}

	/** Restore pending diffs from persisted data, discarding stale entries. */
	private async restorePendingDiffs(entries: PersistedDiffEntry[]): Promise<void> {
		for (const entry of entries) {
			const file = this.app.vault.getAbstractFileByPath(entry.path);
			if (!(file instanceof TFile)) {
				if (entry.deleted || entry.originalPath || entry.draftContent !== undefined && entry.draftContent !== entry.newContent) {
					const diff = Object.assign(this.makeDiffCallbacks(entry.path, entry.oldContent, entry.newContent), entry);
					diff.draftContent = entry.draftContent ?? entry.newContent;
					diff.missing = true;
					this.pendingDiffs.set(entry.path, diff);
				}
				continue;
			}

			let currentContent: string;
			try { currentContent = await this.app.vault.read(file); }
			catch {
				const diff = Object.assign(this.makeDiffCallbacks(entry.path, entry.oldContent, entry.newContent), entry);
				diff.draftContent = entry.draftContent ?? entry.newContent;
				diff.conflicted = true;
				this.pendingDiffs.set(entry.path, diff);
				continue;
			}
			const snapshot = restoreReview(entry, currentContent) ?? (entry.originalPath || entry.created ? {oldContent: entry.oldContent, newContent: currentContent, draftContent: currentContent, conflicted: false} : null);
			if (!snapshot) continue;
			const diff = Object.assign(this.makeDiffCallbacks(entry.path, snapshot.oldContent, snapshot.newContent), snapshot);
			diff.originalPath = entry.originalPath;
			diff.created = entry.created;
			diff.renameSources = entry.renameSources;
			diff.internalReview = entry.internalReview;
			this.pendingDiffs.set(entry.path, diff);
		}

		if (this.pendingDiffs.size > 0) {
			this.persistState();
		}
	}

	/** Create the CM6 extension that detects external changes via transaction annotations. */
	private createDetectionExtension(): Extension {
		return [
			// Block user edits on files with pending diffs and show a warning modal
			EditorState.transactionFilter.of((tr) => {
				if (!tr.docChanged) return tr;
				if (!this.settings.enabled) return tr;
				if (tr.annotation(Transaction.userEvent) === "set") return tr;

				const path = this.getPathForEditorState(tr.startState);
				if (!path || !this.pendingDiffs.has(path)) return tr;
				if (this.programmaticEdits.isActive(path) && !isManualEditorTransaction(tr, this.manualEvents)) return tr;
				const pending = this.pendingDiffs.get(path)!;
				if (pending.internalReview && pending.draftContent === pending.newContent && !pending.conflicted) return tr;
				if (this.pendingEditWarning.has(path)) return [];

				this.debugLog.write("editor.blocked-by-review", () => ({path, userEvent: tr.annotation(Transaction.userEvent)}));
				this.pendingEditWarning.add(path);
				new EditWarningModal(this.app, () => {
					this.pendingEditWarning.delete(path);
					this.pendingDiffs.delete(path);
					this.getExistingDiffView()?.removeFile(path);
					this.persistState();
				}, () => {
					this.pendingEditWarning.delete(path);
				}).open();
				return [];
			}),

			EditorView.updateListener.of((update: ViewUpdate) => {
				if (!update.docChanged) return;
				this.debugLog.write("editor.update", () => {
					const path = this.getPathForEditorView(update.view);
					return {path, programmatic: !!path && this.programmaticEdits.isActive(path),
						userEvents: update.transactions.map(tr => tr.annotation(Transaction.userEvent) ?? null),
						beforeLength: update.startState.doc.length, afterLength: update.state.doc.length};
				});
				if (!this.settings.enabled) return;

				const path = this.getPathForEditorView(update.view);
				if (!path) return;

				// Check if this is our own vault.modify
				if (this.selfModifyPaths.has(path)) {
					this.debugLog.write("editor.ignored", () => ({path, reason: "Drift self-write"}));
					this.selfModifyPaths.delete(path);
					this.baselines.set(path, update.state.doc.toString());
					return;
				}

				// Obsidian uses userEvent "set" exclusively when syncing external file
				// content into the editor. Detect that specific signal rather than
				// whitelisting all user events — Obsidian dispatches some user actions
				// (e.g. paste) without standard CM6 userEvent annotations.
				const isExternalSync = update.transactions.some(tr =>
					tr.annotation(Transaction.userEvent) === "set"
				);

				if (isExternalSync && !this.programmaticEdits.isActive(path)) {
					// A fresh mark means this "set" is Obsidian syncing an in-app
					// API write into the editor, not an external change.
					if (this.consumeInternalWriteMark(path)) {
						this.debugLog.write("editor.ignored", () => ({path, reason: "file API synchronization handled by vault event"}));
						this.baselines.set(path, update.state.doc.toString());
						return;
					}
					const newContent = update.state.doc.toString();
					const oldContent = this.baselines.get(path);
					this.debugLog.write("editor.classified", () => ({path, source: "external-sync", baselineKnown: oldContent !== undefined}));
					if (oldContent !== undefined && (oldContent !== newContent || this.pendingDiffs.has(path))) {
						this.handleExternalChange(path, oldContent, newContent);
					}
				} else {
					this.renameMatcher?.observe(path, update.state.doc.toString());
					const apiCallActive = this.programmaticEdits.isActive(path);
					const manual = update.transactions.filter(tr => tr.docChanged).every(tr => isManualEditorTransaction(tr, this.manualEvents));
					const programmatic = apiCallActive && !manual;
					this.debugLog.write("editor.classified", () => ({path,
						apiCallActive, manualAnnotation: manual,
						reason: apiCallActive && manual ? "explicit manual annotation overrides API route" : "API route classification",
						source: programmatic ? "editor-api" : "other-editor",
						reviewEnabled: programmatic ? this.settings.trackProgrammaticChanges : this.settings.trackInAppChanges,
						baselineKnown: this.baselines.has(path)}));
					if (programmatic ? this.settings.trackProgrammaticChanges : this.settings.trackInAppChanges) {
						const previous = this.baselines.get(path);
						if (previous !== undefined) this.handleExternalChange(path, previous, update.state.doc.toString(), !programmatic);
					}
					this.typingContents.set(path, update.state.doc.toString());
					this.baselines.set(path, update.state.doc.toString());
					this.persistState();
				}
			}),
		];
	}

	/** Resolve an EditorView to the file path it's editing. */
	private getPathForEditorView(view: EditorView): string | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const mdView = leaf.view as MarkdownView;
			if (getCmEditor(mdView) === view) {
				return mdView.file?.path ?? null;
			}
		}
		return null;
	}

	/** Resolve an EditorState to the file path (for transactionFilter which lacks view access). */
	private getPathForEditorState(state: EditorState): string | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const mdView = leaf.view as MarkdownView;
			if (getCmEditor(mdView)?.state === state) {
				return mdView.file?.path ?? null;
			}
		}
		return null;
	}

	/** Reconcile the returning path without associating it with another filename. */
	private handleCreate = async (file: TAbstractFile, origin?: boolean, settled = false): Promise<void> => {
		const path = file.path;
		const internal = origin ?? this.internalOperations?.isInternal(path) ?? false;
		if (this.initializing) { this.startupEvents.push(() => { void this.handleCreate(file, internal); }); return; }
		if (this.disposed) return;
		const trackCreation = this.baselineReady;
		if (this.applying.has(path)) return;
		this.refreshMissingReviews();
		if (!(file instanceof TFile) || file.extension !== "md") return;
		const previous = this.pendingDiffs.get(path);
		const baseline = settled ? undefined : this.baselines.get(path);
		if (!settled && trackCreation && !previous && baseline === undefined) { this.creationQueue.defer(file, internal); return; }
		try {
			const current = await this.app.vault.read(file);
			// Ignore a read that finished after another replacement, rename, or review.
			if (this.disposed || file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file ||
				this.pendingDiffs.get(path) !== previous || this.applying.has(path)) return;
			if (!previous && baseline !== undefined && baseline !== current && this.settings.enabled && (!internal || this.settings.trackApiChanges)) {
				this.handleExternalChange(path, baseline, current);
			} else if (previous) {
				markPresent(previous);
				const edited = previous.draftContent !== previous.newContent;
				if (!edited && current === previous.oldContent && !previous.originalPath) {
					// The deletion/content change is undone; no decision remains to apply.
					this.pendingDiffs.delete(path);
				} else if (edited || current === previous.newContent) {
					// Preserve the object and history, including an already edited draft.
					previous.conflicted = current !== previous.newContent;
				} else {
					const diff = this.makeDiffCallbacks(path, previous.oldContent, current);
					diff.originalPath = previous.originalPath;
					diff.created = previous.created;
					this.pendingDiffs.set(path, diff);
				}
				this.persistState();
				this.getExistingDiffView()?.syncFiles(this.pendingDiffs);
			}
			if (!previous && baseline === undefined && trackCreation && this.settings.reviewNewFiles && this.settings.enabled && (!internal || this.settings.trackApiChanges && current !== "")) {
				this.handleExternalChange(path, "", current, false, true);
			}
			const pending = this.pendingDiffs.get(path);
			if (pending) pending.matchContent = current;
			this.baselines.set(path, current);
			this.persistState();
			if (trackCreation && (!internal || this.settings.trackApiChanges)) this.renameMatcher?.observe(path, current, true);
		} catch (error) {
			console.error("Drift: could not read created file", error);
		}
	};

	/** Handler for vault.on('modify') — classifies Vault-API writes as internal and catches external changes to files not open in any editor. */
	private handleModify = async (file: TAbstractFile, origin?: boolean): Promise<void> => {
		if (!(file instanceof TFile) || file.extension !== "md") return;
		if (this.creationQueue.touch(file)) { this.selfModifyPaths.delete(file.path); return; }
		const path = file.path;
		const stillCurrent = () => !this.disposed && file.path === path && this.app.vault.getAbstractFileByPath(path) === file;
		const internal = origin ?? !!(file as TFile & {saving?: boolean}).saving;
		this.debugLog.write("vault.modify", () => ({path, internal, openInEditor: this.isFileOpenInEditor(path), initializing: this.initializing}));
		if (this.initializing) { this.startupEvents.push(() => { void this.handleModify(file, internal); }); return; }
		if (this.disposed) return;
		if (!this.settings.enabled) {
			const current = await this.app.vault.read(file);
			if (!stillCurrent()) return;
			this.baselines.set(path, current);
			this.persistState();
			return;
		}

		// Writes through the Vault API (plugins, Bases property edits, Obsidian
		// Sync) run with file.saving === true, and the modify event fires
		// synchronously inside that write — so `saving` must be read before the
		// first await. External changes arrive via the file watcher after the
		// write completes, with saving === false. The flag is undocumented; if a
		// future Obsidian drops it, these writes get flagged again (the old
		// behavior) rather than external changes being missed.
		if (internal) {
			if (this.isFileOpenInEditor(file.path)) {
				// The editor is about to sync this write in with a "set"
				// transaction; leave a mark for the CM6 listener to consume.
				this.internalWritePaths.set(file.path, Date.now());
			}
			const isSelfWrite = this.selfModifyPaths.delete(file.path);
			const current = await this.app.vault.cachedRead(file);
			if (!stillCurrent()) return;
			if (!isSelfWrite && this.typingContents.consume(file.path, current)) {
				this.debugLog.write("vault.ignored", () => ({path, reason: "recognized editor autosave", length: current.length}));
				// The editor already established its baseline. An older autosave
				// must neither rewind it nor create a reverse review.
				this.persistState();
				return;
			}
			this.typingContents.delete(file.path);
			if (!isSelfWrite && this.settings.trackApiChanges) {
				this.debugLog.write("vault.classified", () => ({path, source: "file-api", length: current.length}));
				const before = this.baselines.get(file.path);
				if (before !== undefined && (before !== current || this.pendingDiffs.has(file.path))) this.handleExternalChange(file.path, before, current);
				this.baselines.set(file.path, current);
				this.persistState();
				return;
			}
			// Ignoring an API write must not silently accept a previous external review.
			this.debugLog.write("vault.ignored", () => ({path, reason: isSelfWrite ? "Drift self-write" : "file API review disabled"}));
			this.baselines.set(file.path, current);
			const pending = this.pendingDiffs.get(file.path);
			if (pending && !isSelfWrite) {
				pending.conflicted = pending.newContent !== current;
				pending.matchContent = current;
				this.getExistingDiffView()?.updateReviewStatus(file.path);
				this.persistState();
			}
			this.renameMatcher?.observe(file.path, current);
			this.persistState();
			return;
		}

		// Skip if file is open in an editor (CM6 listener handles it)
		if (this.isFileOpenInEditor(file.path)) {
			this.debugLog.write("vault.deferred-to-editor", () => ({path}));
			return;
		}

		const newContent = await this.app.vault.read(file);
		if (!stillCurrent()) return;
		const oldContent = this.baselines.get(file.path);

		if (oldContent === undefined) {
			this.baselines.set(file.path, newContent);
			return;
		}

		if (oldContent === newContent && !this.pendingDiffs.has(file.path)) return;

		// Check self-modify
		if (this.selfModifyPaths.has(file.path)) {
			this.selfModifyPaths.delete(file.path);
			this.baselines.set(file.path, newContent);
			return;
		}

		this.handleExternalChange(file.path, oldContent, newContent);
	};

	/** Check if a file is currently open in any editor pane. */
	private isFileOpenInEditor(path: string): boolean {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			if (view.file?.path === path) return true;
		}
		return false;
	}

	/** Find the existing diff view, or null if none open or not yet loaded (deferred). */
	private getExistingDiffView(): DiffView | null {
		const leaves = this.app.workspace.getLeavesOfType(DIFF_VIEW_TYPE);
		const view = leaves.length > 0 ? leaves[0]!.view : null;
		return view instanceof DiffView ? view : null;
	}

	/** Find the existing diff view, loading it first if Obsidian deferred it (preserved leaf after plugin reload or app restart). */
	private async resolveDiffView(): Promise<DiffView | null> {
		const leaves = this.app.workspace.getLeavesOfType(DIFF_VIEW_TYPE);
		if (leaves.length === 0) return null;
		const leaf = leaves[0]!;
		await leaf.loadIfDeferred();
		return leaf.view instanceof DiffView ? leaf.view : null;
	}

	/** Open and focus the diff tab (for manual command). */
	private async openDiffTab(): Promise<DiffView> {
		const existing = await this.resolveDiffView();
		if (existing) {
			await this.app.workspace.revealLeaf(existing.leaf);
			return existing;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({type: DIFF_VIEW_TYPE, active: true});
		const view = leaf.view as DiffView;
		for (const [path, diff] of this.pendingDiffs) {
			view.addFile(path, diff);
		}
		return view;
	}

	/** Ensure the diff tab exists in the background without stealing focus. */
	private async ensureDiffTab(): Promise<DiffView> {
		const existing = await this.resolveDiffView();
		if (existing) return existing;
		const previousLeaf = this.app.workspace.getMostRecentLeaf();
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({type: DIFF_VIEW_TYPE, active: false});
		if (previousLeaf) {
			this.app.workspace.setActiveLeaf(previousLeaf, {focus: true});
		}
		const view = leaf.view as DiffView;
		for (const [path, diff] of this.pendingDiffs) {
			view.addFile(path, diff);
		}
		return view;
	}

	/** Create callbacks for a pending diff and store them. */
	private makeDiffCallbacks(path: string, oldContent: string, newContent: string): PendingDiff {
		const diff: PendingDiff = {
			path,
			oldContent,
			newContent,
			draftContent: newContent,
			conflicted: false,
			onAccept: content => this.operations.completeReview(diff.path!, diff, content, true),
			onReject: () => this.operations.completeReview(diff.path!, diff, diff.oldContent),
			onKeepDeletion: () => this.operations.keepDeletion(diff.path!, diff),
			onFindRename: () => new RenameReviewModal(this.app, diff.path!, diff, this.renameMatcher).open(),
			onConfirmRename: target => this.renameMatcher.confirmCandidate(diff.path!, diff, target),
			onKeepSeparate: () => this.renameMatcher.keepSeparate(diff),
			onResumeMatching: () => this.renameMatcher.resume(diff),
			onDraftChange: content => {
				diff.draftContent = content;
				this.persistState();
			},
			onReviewLatest: () => this.operations.reviewLatest(diff.path!, diff),
		};
		return diff;
	}

	/** Check old paths without inferring or following renames. */
	private refreshMissingReviews(): void {
		for (const [path, diff] of this.pendingDiffs) {
			const missing = !(this.app.vault.getAbstractFileByPath(path) instanceof TFile);
			if (!missing && diff.deleted) {
				diff.deleted = false;
				diff.deletionOnly = false;
			}
			diff.missing = missing;
			this.getExistingDiffView()?.updateReviewStatus(path);
		}
	}

	/** Handle an external file change, optionally focusing the diff tab. */
	private handleExternalChange(path: string, oldContent: string, newContent: string, internal = false, created = false): void {
		this.debugLog.write("review.received", () => ({path, internal, created,
			originalLength: oldContent.length, resultLength: newContent.length,
			programmatic: this.programmaticEdits.isActive(path), existing: this.pendingDiffs.has(path)}));
		if (!internal && !this.programmaticEdits.isActive(path)) this.typingContents.delete(path);
		this.renameMatcher?.observe(path, newContent);
		this.baselines.set(path, newContent);
		const previous = this.pendingDiffs.get(path);
		if (previous) previous.matchContent = newContent;
		if (!created && !previous && this.settings.ignoreEmptyFileChanges && oldContent === "") {
			this.baselines.set(path, newContent);
			return;
		}
		if (previous && (previous.draftContent !== previous.newContent || previous.conflicted)) {
			this.debugLog.write("review.draft-preserved", () => ({path, conflicted: previous.newContent !== newContent}));
			previous.conflicted = previous.newContent !== newContent;
			this.getExistingDiffView()?.updateReviewStatus(path);
			this.persistState();
			return;
		}
		if (previous?.newContent === newContent) {
			this.debugLog.write("review.unchanged", () => ({path}));
			return;
		}
		const diff = this.makeDiffCallbacks(path, previous?.oldContent ?? oldContent, newContent);
		diff.originalPath = previous?.originalPath;
		diff.created = previous?.created ?? created;
		diff.internalReview = internal;
		diff.renameSources = previous?.renameSources ?? [...this.pendingDiffs].filter(([, review]) => review.renameCandidates?.some(candidate => candidate.path === path)).map(([source]) => source);
		diff.matchContent = newContent;
		this.pendingDiffs.set(path, diff);
		this.debugLog.write("review.updated", () => ({path, internalReview: internal, created, hadPrevious: !!previous}));
		this.persistState();

		if (this.initializing) return;

		if (this.settings.focusDiffOnChange) {
			void this.openDiffTab().then(view => view.addFile(path, diff));
			return;
		}

		const existing = this.getExistingDiffView();
		if (existing) {
			existing.addFile(path, diff);
			return;
		}

		void this.ensureDiffTab().then(view => view.addFile(path, diff));
	}
}

class EditWarningModal extends Modal {
	private onProceed: () => void;
	private onCancel: () => void;
	private resolved = false;

	constructor(app: App, onProceed: () => void, onCancel: () => void) {
		super(app);
		this.onProceed = onProceed;
		this.onCancel = onCancel;
	}

	/** Render the warning with proceed/cancel buttons. */
	onOpen(): void {
		this.modalEl.addClass("diff-edit-warning-modal");
		this.contentEl.createEl("h3", {text: "Pending external changes"});
		this.contentEl.createEl("p", {
			text: "Editing this file will accept its current disk contents and discard any review draft. Pending changes will no longer be visible in the diff viewer.",
		});
		new Setting(this.contentEl)
			.addButton(btn => btn.setButtonText("Proceed").setCta().onClick(() => {
				this.resolved = true;
				this.close();
				this.onProceed();
			}))
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => {
				this.resolved = true;
				this.close();
				this.onCancel();
			}));
	}

	/** Call cancel callback if modal was closed without clicking a button. */
	onClose(): void {
		if (!this.resolved) this.onCancel();
	}
}
