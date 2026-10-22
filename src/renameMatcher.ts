import {TFile, type TAbstractFile, type Vault} from "obsidian";
import type {PendingDiff} from "./DiffView";
import type {ExternalDiffSettings} from "./settings";
import {markPresent} from "./reviewTransitions";
import {snapshotReview, type RenameUndo} from "./reviewDraft";
import {fingerprint, similarity, MAX_MATCH_TEXT, type Fingerprint} from "./renameSimilarity";
import {moveRenameCandidates} from "./renameCandidateMoves";

const MAX_CANDIDATES = 128;
const MAX_TEXT = 2 * 1024 * 1024;
const RETENTION_MS = 30 * 60 * 1000;
interface Candidate {text: string; print?: Fingerprint | null; observed: number}
class RenameContentChangedError extends Error {
	constructor() { super("The files changed. Open a new preview before confirming."); }
}
interface Host {
	vault: Vault;
	settings: ExternalDiffSettings;
	reviews: Map<string, PendingDiff>;
	baselines: Map<string, string>;
	changed(): void;
	busy(path: string): boolean;
	createReview(path: string, oldContent: string, newContent: string): PendingDiff;
}

/** Event-only candidate collection; no vault scan and no automatic associations. */
export class RenameMatcher {
	private created = new Map<string, Candidate>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private disposed = false;
	private sources = new Map<PendingDiff, Fingerprint | null>();
	private nextSource = 0;
	status = "";
	private limited = false;
	private undoEditors = new WeakMap<RenameUndo, {source: PendingDiff["editorState"]; target: PendingDiff["editorState"]}>();
	constructor(private host: Host) {}

	observe(path: string, text: string, created = false): void {
		if (this.disposed || !this.host.settings.enabled || !this.host.settings.trackFileRenames) return;
		if (!created && !this.created.has(path)) return;
		const previous = this.created.get(path);
		if (text.length > MAX_MATCH_TEXT) { this.limited = true; this.created.delete(path); this.schedule(); return; }
		this.created.delete(path);
		this.created.set(path, {text, print: previous?.text === text ? previous.print : undefined, observed: Date.now()});
		let size = [...this.created.values()].reduce((sum, value) => sum + value.text.length, 0);
		while (this.created.size > MAX_CANDIDATES || size > MAX_TEXT) {
			const first = [...this.created.keys()][0]!;
			size -= this.created.get(first)!.text.length;
			this.created.delete(first);
			this.limited = true;
		}
		this.schedule();
	}

	/** FileLifecycle notifies and persists after moving both reviews and candidates. */
	rename(file: TAbstractFile, oldPath: string): void {
		if (this.disposed) return;
		moveRenameCandidates(this.created, this.host.reviews, this.host.vault, file, oldPath);
		this.schedule();
	}

	schedule(): void {
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		if (!this.disposed) this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 250);
	}

	async refresh(): Promise<void> {
		const generation = ++this.generation;
		const {reviews, vault, settings} = this.host;
		const pending = [...reviews].filter(([, diff]) => (diff.missing || diff.deleted) && !diff.renameDismissed);
		const start = this.nextSource % Math.max(1, pending.length);
		const sources = [...pending.slice(start), ...pending.slice(0, start)];
		for (const [path, candidate] of this.created) {
			if (Date.now() - candidate.observed > RETENTION_MS || !(vault.getAbstractFileByPath(path) instanceof TFile)) this.created.delete(path);
		}
		this.status = settings.enabled && settings.trackFileRenames && sources.length ? `Checking ${sources.length} missing files for rename matches…` : "";
		this.host.changed();
		for (const candidate of this.created.values()) {
			if (candidate.print === undefined) candidate.print = fingerprint(candidate.text);
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			if (this.disposed || generation !== this.generation) return;
		}
		for (const source of this.sources.keys()) if (!sources.some(([, diff]) => diff === source)) this.sources.delete(source);
		const results = new Map<string, {path: string; score: number}[]>();
		let batchText = 0;
		let batchCount = 0;
		if (settings.enabled && settings.trackFileRenames) {
			for (const [path, diff] of sources) {
				const text = diff.matchContent ?? diff.newContent;
				if (batchCount >= MAX_CANDIDATES || batchText + text.length > MAX_TEXT) {
					await new Promise<void>(resolve => setTimeout(resolve, 0));
					if (this.disposed || generation !== this.generation) return;
					batchText = batchCount = 0;
				}
				batchText += text.length;
				batchCount++;
				this.nextSource = (this.nextSource + 1) % Math.max(1, pending.length);
				let source = this.sources.get(diff);
				if (source === undefined || source?.text !== text) {
					source = fingerprint(text);
					this.sources.delete(diff);
					this.sources.set(diff, source);
					let cachedText = [...this.sources.values()].reduce((sum, value) => sum + (value?.text.length ?? 0), 0);
					while (this.sources.size > MAX_CANDIDATES || cachedText > MAX_TEXT) {
						const oldest = [...this.sources.keys()][0]!;
						cachedText -= this.sources.get(oldest)?.text.length ?? 0;
						this.sources.delete(oldest);
					}
				}
				if (!source || vault.getAbstractFileByPath(path)) continue;
				const candidates: {path: string; score: number}[] = [];
				let comparisons = 0;
				for (const [target, candidate] of this.created) {
					if (candidate.print && target !== path && vault.getAbstractFileByPath(target) instanceof TFile) {
						const score = similarity(source, candidate.print);
						if (score >= 0.8) candidates.push({path: target, score});
					}
					if (++comparisons % 8 === 0) {
						await new Promise<void>(resolve => setTimeout(resolve, 0));
						if (this.disposed || generation !== this.generation) return;
					}
				}
				candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
				results.set(path, candidates.slice(0, 8));
				await new Promise<void>(resolve => setTimeout(resolve, 0));
				if (this.disposed || generation !== this.generation) return;
			}
		}
		if (this.disposed || generation !== this.generation) return;
		const before = JSON.stringify([...reviews.values()].map(diff => [diff.renameCandidates ?? [], diff.renameSources ?? []]));
		for (const diff of reviews.values()) diff.renameSources = [];
		for (const [path, diff] of reviews) {
			// Keep saved suggestions until explicitly resolved, even after cache eviction.
			const previous = diff.renameCandidates ?? [];
			const suggested = [...(results.get(path) ?? []), ...previous.filter(candidate => !settings.enabled || !settings.trackFileRenames || !this.created.has(candidate.path))]
				.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 8);
			diff.renameCandidates = (diff.missing || diff.deleted) && !diff.renameDismissed
				? suggested.filter(candidate => candidate.path !== path && vault.getAbstractFileByPath(candidate.path) instanceof TFile) : [];
			for (const candidate of diff.renameCandidates) {
				const target = reviews.get(candidate.path);
				if (target) (target.renameSources ??= []).push(path);
			}
		}
		const after = JSON.stringify([...reviews.values()].map(diff => [diff.renameCandidates ?? [], diff.renameSources ?? []]));
		this.status = this.limited ? "Some files exceed automatic matching limits. Use Select renamed file to search manually." : "";
		if (before !== after || sources.length || this.limited) this.host.changed();
	}

	keepSeparate(diff: PendingDiff): void {
		diff.renameDecisionPending = false;
		diff.renameDismissed = true;
		diff.renameCandidates = [];
		this.schedule();
		this.host.changed();
	}

	resume(diff: PendingDiff): void {
		diff.renameDismissed = false;
		this.schedule();
		this.host.changed();
	}

	/** False means a fresh preview is required; no association has been made. */
	async confirmCandidate(sourcePath: string, diff: PendingDiff, targetPath: string): Promise<boolean> {
		const candidate = this.created.get(targetPath);
		const suggestion = diff.renameCandidates?.find(item => item.path === targetPath);
		if (!suggestion) {
			throw new Error("This match is no longer available. Review the match again.");
		}
		// Exact suggestions can be revalidated against the source after cache eviction.
		const expected = suggestion.score === 1 ? diff.matchContent ?? diff.newContent : candidate?.text;
		if (expected === undefined) return false;
		try {
			await this.confirm(sourcePath, diff, targetPath, expected);
			return true;
		} catch (error) {
			if (error instanceof RenameContentChangedError) return false;
			throw error;
		}
	}

	async confirm(sourcePath: string, diff: PendingDiff, targetPath: string, expected: string): Promise<void> {
		const {vault, reviews} = this.host;
		const target = vault.getAbstractFileByPath(targetPath);
		if (!(target instanceof TFile) || target.extension !== "md" || targetPath === sourcePath) throw new Error("Select an existing Markdown file at a different path.");
		const current = await vault.read(target);
		if (this.disposed || reviews.get(sourcePath) !== diff || vault.getAbstractFileByPath(sourcePath) ||
			target.path !== targetPath || vault.getAbstractFileByPath(targetPath) !== target ||
			this.host.busy(sourcePath) || this.host.busy(targetPath)) throw new Error("The files changed. Open a new preview before confirming.");
		if (current !== expected) throw new RenameContentChangedError();
		const other = reviews.get(targetPath);
		if (other) {
			throw new Error("The selected file has its own unfinished review. Resolve it before associating these files.");
		}
		const before = snapshotReview(diff);
		const beforeEditor = diff.editorState;
		const edited = diff.draftContent !== diff.newContent;
		if (!edited) {
			if (diff.draftContent !== current) diff.editorState = undefined;
			diff.newContent = current;
			diff.draftContent = current;
		}
		diff.conflicted = edited && diff.newContent !== current;
		diff.originalPath ??= sourcePath;
		diff.path = targetPath;
		if (diff.originalPath === targetPath) diff.originalPath = undefined;
		markPresent(diff);
		diff.renameDismissed = false;
		diff.renameCandidates = [];
		diff.renameSources = [];
		diff.matchContent = current;
		diff.internalReview = false;
		const entries = [...reviews];
		reviews.clear();
		for (const [path, entry] of entries) {
			if (path === targetPath) continue;
			reviews.set(path === sourcePath ? targetPath : path, entry);
		}
		if (!diff.originalPath && diff.oldContent === current && diff.draftContent === current) reviews.delete(targetPath);
		this.created.delete(targetPath);
		this.host.baselines.set(targetPath, current);
		for (const entry of reviews.values()) entry.renameCandidates = entry.renameCandidates?.filter(candidate => candidate.path !== targetPath);
		diff.renameUndo = {sourcePath, targetPath, source: before};
		this.undoEditors.set(diff.renameUndo, {source: beforeEditor, target: undefined});
		this.host.changed();
		this.schedule();
	}

	async undo(diff: PendingDiff): Promise<void> {
		const saved = diff.renameUndo;
		if (!saved) throw new Error("Undo data is not available for this older association.");
		const {sourcePath, targetPath} = saved;
		const {vault, reviews} = this.host;
		const target = vault.getAbstractFileByPath(targetPath);
		if (!(target instanceof TFile)) throw new Error("The associated file is missing. Restore it before undoing the association.");
		const latest = await vault.read(target);
		if (this.disposed || reviews.get(targetPath) !== diff || diff.path !== targetPath || diff.renameUndo !== saved ||
			vault.getAbstractFileByPath(sourcePath) || reviews.has(sourcePath) ||
			vault.getAbstractFileByPath(targetPath) !== target || target.path !== targetPath ||
			this.host.busy(sourcePath) || this.host.busy(targetPath)) {
			throw new Error("The paths or reviews changed. Resolve them before undoing this association.");
		}
		const draft = diff.draftContent;
		const editor = diff.editorState;
		const edited = draft !== diff.newContent;
		Object.assign(diff, snapshotReview(saved.source));
		diff.path = sourcePath;
		diff.missing = true;
		diff.renameUndo = undefined;
		diff.editorState = this.undoEditors.get(saved)?.source;
		if (edited) { diff.draftContent = draft; diff.editorState = editor; }
		diff.renameDismissed = false;
		diff.renameDecisionPending = true;
		diff.renameCandidates = saved.source.renameCandidates?.filter(candidate => vault.getAbstractFileByPath(candidate.path) instanceof TFile) ?? [];
		reviews.delete(targetPath);
		reviews.set(sourcePath, diff);
		if (saved.target) {
			const other = Object.assign(this.host.createReview(targetPath, saved.target.oldContent, saved.target.newContent), saved.target);
			other.path = targetPath;
			other.editorState = this.undoEditors.get(saved)?.target;
			other.conflicted = latest !== other.newContent;
			reviews.set(targetPath, other);
		}
		this.observe(targetPath, latest, true);
		this.host.changed();
		this.schedule();
	}

	serializeCandidates(): [string, number][] {
		return [...this.created].filter(([, candidate]) => Date.now() - candidate.observed <= RETENTION_MS)
			.map(([path, candidate]) => [path, candidate.observed]);
	}

	async restore(recent: [string, number][] = []): Promise<void> {
		for (const [path, observed] of recent.slice(-MAX_CANDIDATES)) {
			if (this.disposed) return;
			if (!Number.isFinite(observed) || Date.now() - observed > RETENTION_MS || observed > Date.now()) continue;
			const file = this.host.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== "md") continue;
			try {
				const text = await this.host.vault.read(file);
				if (file.path !== path || this.host.vault.getAbstractFileByPath(path) !== file) continue;
				this.observe(path, text, true);
				const candidate = this.created.get(path);
				if (candidate) candidate.observed = observed;
			} catch { /* Retry through explicit vault search if sync interrupts the read. */ }
		}
		const paths = [...new Set([...this.host.reviews.values()].flatMap(diff => diff.renameCandidates?.map(candidate => candidate.path) ?? []))].slice(0, MAX_CANDIDATES);
		for (const path of paths) {
			if (this.disposed) return;
			if (this.created.has(path)) continue;
			const file = this.host.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			try { this.observe(path, await this.host.vault.read(file), true); }
			catch { /* Keep the source review when a sync operation interrupts a read. */ }
		}
		this.schedule();
	}

	dispose(): void {
		this.disposed = true;
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.created.clear();
		this.sources.clear();
	}
}
