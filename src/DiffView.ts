import {App, Modal, Setting, Notice, ItemView, setTooltip, WorkspaceLeaf} from "obsidian";
import {Change, MergeView} from "@codemirror/merge";
import {drawSelection, EditorView, keymap, lineNumbers} from "@codemirror/view";
import {defaultKeymap, history, historyField, historyKeymap} from "@codemirror/commands";
import {Compartment, EditorState} from "@codemirror/state";
import type {ExternalDiffSettings} from "./settings";
import {reviewLabels, summarizeReviews, reviewDecision} from "./reviewActions";
import {ConfirmActionModal} from "./ConfirmActionModal";
import {renderRenameSuggestions} from "./renameSuggestions";
import {DiffToolbar} from "./diffToolbar";
import {selectExportEntries} from "./export/reviewEntries";
import {ExportModal} from "./export/ExportModal";
import {DiffScrollbar} from "./diffScrollbar";
import {ReviewControls} from "./reviewControls";
import {unresolvedRename, renameOnly, type ReviewSnapshot} from "./reviewDraft";
import {createHorizontalScrollSync, synchronizedScroll} from "./syncScroll";
import {patienceDiff} from "./patienceDiff";
import {wordDiff} from "./wordDiff";
import {foldUnchangedExtension, computeUnchangedRanges, setFoldRanges, toggleFold} from "./foldUnchanged";

/** Line-based diff using patience algorithm, converted to CodeMirror Change[] with character offsets. */
function lineDiff(a: string, b: string): readonly Change[] {
	const aLines = a.split("\n");
	const bLines = b.split("\n");
	const diff = patienceDiff(aLines, bLines);

	const changes: Change[] = [];
	let curA = 0, curB = 0;
	let i = 0;
	while (i < diff.lines.length) {
		const entry = diff.lines[i]!;
		if (entry.aIndex >= 0 && entry.bIndex >= 0) {
			// Matched line — advance both positions
			const sep = entry.aIndex < aLines.length - 1 ? 1 : 0;
			curA += entry.line.length + sep;
			curB += entry.line.length + (entry.bIndex < bLines.length - 1 ? 1 : 0);
			i++;
			continue;
		}
		// Accumulate consecutive deletions/insertions into one Change
		const fromA = curA, fromB = curB;
		while (i < diff.lines.length) {
			const e = diff.lines[i]!;
			if (e.aIndex >= 0 && e.bIndex >= 0) break;
			if (e.bIndex === -1) {
				curA += e.line.length + (e.aIndex < aLines.length - 1 ? 1 : 0);
			} else {
				curB += e.line.length + (e.bIndex < bLines.length - 1 ? 1 : 0);
			}
			i++;
		}
		changes.push(new Change(fromA, curA, fromB, curB));
	}
	return changes;
}

export const DIFF_VIEW_TYPE = "external-diff-view";

export interface PendingDiff extends ReviewSnapshot {
	missing?: boolean;
	recreateMissingFile?: boolean;
	/** Session-only history and selection; only the draft text is persisted. */
	editorState?: EditorState;
	onAccept: (content: string) => Promise<boolean>;
	onReject: () => Promise<boolean>;
	onKeepDeletion: () => Promise<boolean>;
	onFindRename?: () => void;
	onKeepSeparate?: () => void;
	onResumeMatching?: () => void;
	onUndoRename?: () => Promise<void>;
	onDraftChange: (content: string) => void;
	onReviewLatest: () => Promise<void>;
}

interface FileSection {
	diff: PendingDiff;
	expanded: boolean;
	displaysDeletion?: boolean;
	mergeView: MergeView | null;
	mergeContainer: HTMLElement | null;
	chevron?: HTMLElement;
	header?: HTMLElement;
	acceptButton?: HTMLButtonElement;
	rejectButton?: HTMLButtonElement;
	scrollbar?: DiffScrollbar;
	reviewControls?: ReviewControls;
	suggestions?: HTMLElement;
	layoutKey?: string;
}

export class DiffView extends ItemView {
	private sections = new Map<string, FileSection>();
	private lineWrapping = new Compartment();
	private wordLevelHighlighting: boolean;
	private toolbar: DiffToolbar | null = null;
	private applying = new Set<string>();
	private omissionStatus?: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private settings: ExternalDiffSettings, private matchingStatus: () => string = () => "") {
		super(leaf);
		this.wordLevelHighlighting = settings.wordLevelHighlighting;
	}

	/** Rebuild diffs only when the algorithm changes; preserve current content. */
	updateSettings(): void {
		this.updateContrast();
		const algorithmChanged = this.wordLevelHighlighting !== this.settings.wordLevelHighlighting;
		this.wordLevelHighlighting = this.settings.wordLevelHighlighting;
		for (const [path, section] of this.sections) {
			if (!section.mergeView) continue;
			if (algorithmChanged) {
				this.createMergeView(path, section);
				continue;
			}
			for (const editor of [section.mergeView.a, section.mergeView.b]) {
				if (editor.lineWrapping === this.settings.wordWrap) continue;
				editor.dispatch({
					effects: this.lineWrapping.reconfigure(this.settings.wordWrap ? EditorView.lineWrapping : []),
				});
			}
			section.scrollbar?.refresh();
		}
	}

	getViewType(): string {
		return DIFF_VIEW_TYPE;
	}

	private updateContrast(): void {
		this.containerEl.classList.toggle("diff-view-contrast",
			this.settings.wordLevelHighlighting && this.settings.contrastChangedText);
	}

	getDisplayText(): string {
		const count = this.sections.size;
		return count ? `Diffs (${count})` : "External Diffs";
	}

	getIcon(): string {
		return "git-compare";
	}

	/** Check if the view has no file sections. */
	isEmpty(): boolean {
		return this.sections.size === 0;
	}

	/** Add or update a file's diff. */
	addFile(path: string, diff: PendingDiff): void {
		const previous = this.sections.get(path);
		if (previous) this.destroyMergeView(previous);
		this.sections.set(path, {diff, expanded: true, mergeView: null, mergeContainer: null});
		this.render();
	}

	syncFiles(diffs: Map<string, PendingDiff>): void {
		const same = diffs.size === this.sections.size && [...diffs].every(([path, diff], index) => {
			const section = this.sections.get(path);
			return [...this.sections.keys()][index] === path && section?.diff === diff && section.layoutKey === this.layoutKey(path, diff);
		});
		if (same) {
			for (const [path, section] of this.sections) {
				this.updateReviewStatus(path);
				if (section.suggestions) renderRenameSuggestions(section.suggestions, section.diff, this.settings.trackFileRenames);
			}
			this.updateOmissions();
			this.updateExportAvailability();
			return;
		}
		const old = [...this.sections.values()];
		this.sections.clear();
		for (const [path, diff] of diffs) {
			const previous = old.find(section => section.diff === diff);
			this.sections.set(path, previous ?? {diff, expanded: true, mergeView: null, mergeContainer: null});
		}
		for (const section of old) if (![...this.sections.values()].includes(section)) this.destroyMergeView(section);
		this.render();
	}

	updateReviewStatus(path: string): void {
		const section = this.sections.get(path);
		if (!section) return;
		const diff = section.diff;
		if (section.acceptButton) section.acceptButton.disabled = unresolvedRename(diff);
		if (section.rejectButton) section.rejectButton.disabled = unresolvedRename(diff);
		const labels = reviewLabels(diff);
		section.acceptButton?.setText(labels.keep);
		section.rejectButton?.setText(labels.restore);
		section.reviewControls?.update(diff.conflicted, diff.missing, diff.deleted);
		this.updateBulkCounts();
	}

	async onOpen(): Promise<void> {}

	onClose(): Promise<void> {
		for (const section of this.sections.values()) {
			this.destroyMergeView(section);
		}
		this.sections.clear();
		return Promise.resolve();
	}

	private updateExportAvailability(): void {
		this.toolbar?.setExportEnabled(Array.from(this.sections.values()).some(({diff}) => !unresolvedRename(diff) && (diff.oldContent !== diff.draftContent || !!diff.deleted || !!diff.originalPath || !!diff.created)));
	}

	private render(): void {
		if (this.toolbar) this.removeChild(this.toolbar);
		this.toolbar = null;
		this.updateContrast();
		const focused = this.containerEl.ownerDocument.activeElement as HTMLElement | null;
		const scrollTop = this.containerEl.querySelector(".diff-view-scroll")?.scrollTop ?? 0;
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("diff-view-container");

		if (this.sections.size === 0) {
			container.createDiv({cls: "diff-view-empty", text: "No pending changes."});
			return;
		}

		this.toolbar = this.addChild(new DiffToolbar(container, this.sections.size > 1,
			value => {
				for (const [path, section] of this.sections) this.setExpanded(path, section, value);
			}, () => { void this.handleAcceptAll(); }, () => this.confirmRestoreAll(), () => {
				const {entries, omitted} = selectExportEntries([...this.sections].map(([path, section]) => [path, section.diff] as const));
				new ExportModal(this.app, entries, this.settings.exportFilenameTemplate, this.settings.exportContextLines, this.settings.exportUnicodePaths, omitted).open();
			}));
		this.updateExportAvailability();

		this.omissionStatus = container.createDiv({cls: "diff-view-review-status", attr: {"aria-live": "polite"}});
		this.updateOmissions();
		const scrollArea = container.createDiv({cls: "diff-view-scroll"});

		for (const [path, section] of this.sections) {
			const block = scrollArea.createDiv({cls: "diff-view-section"});

			// Collapsible header
			const header = block.createDiv({cls: "diff-view-section-header"});
			section.header = header;

			const left = header.createDiv({cls: "diff-view-section-left"});
			section.chevron = left.createSpan({cls: `diff-view-chevron ${section.expanded ? "is-expanded" : ""}`, text: "›"});
			const filename = left.createSpan({cls: "diff-view-filepath", text: path});
			setTooltip(filename, path, {placement: "bottom"});
			left.addEventListener("click", () => {
				this.setExpanded(path, section, !section.expanded);
			});

			const actions = header.createDiv({cls: "diff-view-actions"});
			const rejectBtn = actions.createEl("button", {cls: "diff-view-btn diff-view-btn-reject", text: "Restore original"});
			const acceptBtn = actions.createEl("button", {cls: "diff-view-btn diff-view-btn-accept", text: "Keep current"});

			section.acceptButton = acceptBtn;
			section.rejectButton = rejectBtn;
			if (section.diff.deleted && !section.diff.deletionOnly) {
				const save = actions.createEl("button", {text: "Save result"});
				save.disabled = unresolvedRename(section.diff);
				save.addEventListener("click", () => { void this.handleAccept(path, true); });
			}
			if (section.diff.missing && !section.diff.deleted) {
				const discard = actions.createEl("button", {text: "Discard review"});
				discard.addEventListener("click", () => new ConfirmActionModal(this.app, "Discard missing-file review?", "This removes the saved comparison and draft. It does not change files.", "Discard review", () => { void this.keepDeletion(path, section); }).open());
			}
			this.updateReviewStatus(path);
			acceptBtn.addEventListener("click", (e) => { e.stopPropagation(); void this.handleAccept(path); });
			rejectBtn.addEventListener("click", (e) => { e.stopPropagation(); void this.handleReject(path); });

			section.suggestions = block.createDiv({cls: "diff-view-rename-suggestions"});
			renderRenameSuggestions(section.suggestions, section.diff, this.settings.trackFileRenames);
			const key = this.layoutKey(path, section.diff);
			if (section.mergeContainer && section.layoutKey === key) block.appendChild(section.mergeContainer);
			else {
				this.destroyMergeView(section);
				section.mergeContainer = block.createDiv({cls: "diff-view-merge cm-s-obsidian mod-cm6"});
			}
			section.layoutKey = key;
			this.setExpanded(path, section, section.expanded);
		}
		scrollArea.scrollTop = scrollTop;
		if (focused && container.contains(focused)) focused.focus({preventScroll: true});
	}

	private layoutKey(path: string, diff: PendingDiff): string {
		return JSON.stringify([path, diff.originalPath, diff.deleted, diff.deletionOnly, diff.created, renameOnly(diff)]);
	}

	private updateOmissions(): void {
		const uncertain = [...this.sections.values()].filter(({diff}) => unresolvedRename(diff)).length;
		const matching = this.matchingStatus?.() ?? "";
		this.omissionStatus?.setText([uncertain ? `${uncertain} files awaiting rename decisions are excluded from bulk actions and export.` : "", matching].filter(Boolean).join(" "));
		this.omissionStatus?.toggle(uncertain > 0 || !!matching);
	}

	private setExpanded(path: string, section: FileSection, expanded: boolean): void {
		section.expanded = expanded;
		section.header?.classList.toggle("is-expanded", expanded);
		section.chevron?.classList.toggle("is-expanded", expanded);
		section.mergeContainer?.toggle(expanded);
		if (!expanded) return;
		if (!section.mergeView) this.createMergeView(path, section);
		section.mergeView?.a.requestMeasure();
		section.mergeView?.b.requestMeasure();
		section.scrollbar?.refresh();
	}

	private destroyMergeView(section: FileSection): void {
		if (section.mergeView && !section.displaysDeletion && section.mergeView.b.state.doc.toString() === section.diff.draftContent) section.diff.editorState = section.mergeView.b.state;
		if (section.reviewControls) this.removeChild(section.reviewControls);
		section.reviewControls = undefined;
		if (section.scrollbar) this.removeChild(section.scrollbar);
		section.scrollbar = undefined;
		section.mergeView?.destroy();
		section.mergeView = null;
	}

	/** Create (or recreate) the MergeView for a section. */
	private createMergeView(path: string, section: FileSection): void {
		this.destroyMergeView(section);
		if (!section.mergeContainer) return;
		section.mergeContainer.empty();
		section.displaysDeletion = !!(section.diff.deleted && section.diff.deletionOnly);
		section.reviewControls = this.addChild(new ReviewControls(section.mergeContainer,
			() => section.mergeView?.b, section.diff.onReviewLatest));
		if (section.diff.originalPath) section.reviewControls.setRename(section.diff.originalPath);
		if (renameOnly(section.diff)) {
			section.mergeContainer.createDiv({text: "No content changes.", cls: "diff-view-review-status"});
			this.updateReviewStatus(path);
			return;
		}
		const syncScroll = createHorizontalScrollSync();
		const syncScrollEnabled = () => !this.settings.wordWrap;

		const syncA = (index: number) => {
			section.mergeView?.b.dispatch({effects: toggleFold.of(index)});
		};
		const syncB = (index: number) => {
			section.mergeView?.a.dispatch({effects: toggleFold.of(index)});
		};

		section.mergeView = new MergeView({
			a: {
				doc: section.diff.oldContent,
				extensions: [
					...foldUnchangedExtension(syncA),
					synchronizedScroll(syncScroll, () => section.mergeView?.b, syncScrollEnabled, () => section.scrollbar?.dom),
					EditorView.updateListener.of(() => section.scrollbar?.refresh()),
					lineNumbers(),
					this.lineWrapping.of(this.settings.wordWrap ? EditorView.lineWrapping : []),
					EditorView.editable.of(false),
					EditorState.readOnly.of(true),
				],
			},
			b: {
				doc: section.diff.deletionOnly && section.diff.deleted ? "" : section.diff.draftContent,
				selection: section.diff.deletionOnly && section.diff.deleted ? undefined : section.diff.editorState?.selection,
				extensions: [
					history(),
					EditorView.editable.of(!(section.diff.deleted && section.diff.deletionOnly)),
					EditorState.readOnly.of(!!(section.diff.deleted && section.diff.deletionOnly)),
					EditorState.transactionFilter.of(tr => this.applying.has(path) && tr.docChanged ? [] : tr),
					...(section.diff.editorState && !(section.diff.deleted && section.diff.deletionOnly) ? [historyField.init(() => section.diff.editorState!.field(historyField))] : []),
					keymap.of([...historyKeymap, ...defaultKeymap]),
					drawSelection(),
					EditorView.contentAttributes.of({"aria-label": "Result, editable draft"}),
					EditorView.updateListener.of(update => {
						if (!section.displaysDeletion) section.diff.editorState = update.state;
						if (update.docChanged) {
							section.diff.onDraftChange(update.state.doc.toString());
							this.updateExportAvailability();
						}
						this.updateReviewStatus(path);
					}),
					...foldUnchangedExtension(syncB),
					synchronizedScroll(syncScroll, () => section.mergeView?.a, syncScrollEnabled, () => section.scrollbar?.dom),
					EditorView.updateListener.of(() => section.scrollbar?.refresh()),
					lineNumbers(),
					this.lineWrapping.of(this.settings.wordWrap ? EditorView.lineWrapping : []),
				],
			},
			parent: section.mergeContainer,
			revertControls: section.diff.deleted && section.diff.deletionOnly ? undefined : "a-to-b",
			renderRevertControl: () => {
				const btn = createEl("button");
				btn.className = "diff-view-revert-btn";
				btn.textContent = "→";
				btn.title = "Restore original block";
				btn.setAttribute("aria-label", "Restore original block");
				return btn;
			},
			highlightChanges: true,
			gutter: false,
			diffConfig: {override: this.settings.wordLevelHighlighting ? wordDiff : lineDiff},
		});

		section.scrollbar = this.addChild(new DiffScrollbar(section.mergeContainer,
			section.mergeView, syncScrollEnabled, syncScroll));

		// Compute unchanged ranges and dispatch initial folds
		const chunks = section.mergeView.chunks;
		const rangesA = computeUnchangedRanges(section.mergeView.a.state.doc, chunks, "a", 2, 4);
		const rangesB = computeUnchangedRanges(section.mergeView.b.state.doc, chunks, "b", 2, 4);
		section.mergeView.a.dispatch({effects: setFoldRanges.of(rangesA)});
		section.mergeView.b.dispatch({effects: setFoldRanges.of(rangesB)});
		this.updateReviewStatus(path);
	}

	/** Accept current state of editor B (includes any partial chunk reverts). */
	private async handleAccept(path: string, saveResult = false): Promise<void> {
		const section = this.sections.get(path);
		if (!section || this.applying.has(path) || unresolvedRename(section.diff)) return;
		if (section.diff.deleted && !saveResult) {
			if (section.diff.draftContent !== section.diff.newContent) {
				new DiscardDraftModal(this.app, () => { void this.keepDeletion(path, section); }).open();
				return;
			}
			await this.keepDeletion(path, section);
			return;
		}
		const content = section.mergeView
			? section.mergeView.b.state.doc.toString()
			: section.diff.draftContent;
		this.applying.add(path);
		try {
			if (await section.diff.onAccept(content) && this.sections.get(path) === section) this.removeFile(path);
		} finally {
			this.applying.delete(path);
		}
	}

	private async keepDeletion(path: string, section: FileSection): Promise<void> {
		if (await section.diff.onKeepDeletion() && this.sections.get(path) === section) this.removeFile(path);
	}

	/** Reject changes for a file. */
	private async handleReject(path: string): Promise<void> {
		const section = this.sections.get(path);
		if (!section || this.applying.has(path) || unresolvedRename(section.diff)) return;
		this.applying.add(path);
		try {
			if (await section.diff.onReject() && this.sections.get(path) === section) this.removeFile(path);
		} finally {
			this.applying.delete(path);
		}
	}

	private updateBulkCounts(): void {
		this.toolbar?.setCounts(summarizeReviews([...this.sections.values()].map(section => section.diff)));
	}

	private confirmRestoreAll(): void {
		const counts = summarizeReviews([...this.sections.values()].map(section => section.diff));
		const approved = new Map([...this.sections].filter(([, section]) => !unresolvedRename(section.diff) && !(section.diff.conflicted && !section.diff.missing)).map(([path, section]) => [path, {diff: section.diff, decision: reviewDecision(section.diff)}]));
		new ConfirmActionModal(this.app, "Restore originals?",
			`Restore ${counts.restore} files to their original contents and paths. This includes ${counts.deleted} deleted files, ${counts.renamed} renames, and ${counts.created} new files to move to trash. ${counts.drafts} edited drafts will be discarded. ${counts.unresolved + counts.conflicts} unresolved or unavailable reviews are excluded.`,
			"Restore originals", () => { void this.handleRejectAll(approved); }).open();
	}

	/** Accept all files and close the diff view. */
	private async handleAcceptAll(): Promise<void> {
		let skipped = 0;
		for (const [path, section] of [...this.sections]) {
			if (unresolvedRename(section.diff) || section.diff.draftContent !== section.diff.newContent || section.diff.missing && !section.diff.deleted || section.diff.conflicted) { skipped++; continue; }
			await this.handleAccept(path);
		}
		new Notice(`Keep current finished. ${skipped} drafts, missing files, or unresolved reviews skipped; ${this.sections.size} reviews remain open.`);
	}

	/** Reject all files and close the diff view. */
	private async handleRejectAll(approved?: Map<string, {diff: PendingDiff; decision: readonly unknown[]}>): Promise<void> {
		let skipped = 0;
		for (const [path, section] of [...this.sections]) {
			const expected = approved?.get(path);
			if (approved && (!expected || expected.diff !== section.diff || expected.decision.some((value, index) => value !== reviewDecision(section.diff)[index]))) { skipped++; continue; }
			if (unresolvedRename(section.diff) || section.diff.conflicted && !section.diff.missing) { skipped++; continue; }
			await this.handleReject(path);
		}
		new Notice(`Restoration finished. ${skipped} unresolved reviews skipped; ${this.sections.size} reviews remain open, including any failed operations.`);
	}

	/** Remove a resolved file and re-render or close if empty. */
	removeFile(path: string): void {
		const section = this.sections.get(path);
		if (section) this.destroyMergeView(section);
		this.sections.delete(path);
		if (this.sections.size === 0) {
			this.leaf.detach();
		} else {
			this.render();
		}
	}
}

class DiscardDraftModal extends Modal {
	constructor(app: App, private discard: () => void) { super(app); }
	onOpen(): void {
		this.titleEl.setText("Discard edited draft?");
		this.contentEl.createEl("p", {text: "Keeping the deletion discards your edited result. The file will remain deleted."});
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText("Keep deletion").setWarning().onClick(() => { this.close(); this.discard(); }));
	}
}
