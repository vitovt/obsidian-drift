import {TFile, type Vault} from "obsidian";
import type {PendingDiff} from "./DiffView";
import type {ExternalDiffSettings} from "./settings";
import {markPresent} from "./reviewTransitions";
import {fingerprint, similarity, MAX_MATCH_TEXT, type Fingerprint} from "./renameSimilarity";

const MAX_CANDIDATES = 128;
const MAX_TEXT = 2 * 1024 * 1024;
const RETENTION_MS = 30 * 60 * 1000;
interface Candidate {text: string; print?: Fingerprint | null; observed: number}
interface Host {
	vault: Vault;
	settings: ExternalDiffSettings;
	reviews: Map<string, PendingDiff>;
	baselines: Map<string, string>;
	changed(): void;
	busy(path: string): boolean;
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

	schedule(): void {
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		if (!this.disposed) this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 250);
	}

	async refresh(): Promise<void> {
		const generation = ++this.generation;
		const {reviews, vault, settings} = this.host;
		const pending = [...reviews].filter(([, diff]) => diff.deleted && !diff.renameDismissed);
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
			diff.renameCandidates = diff.deleted && !diff.renameDismissed
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

	async confirm(sourcePath: string, diff: PendingDiff, targetPath: string, expected: string): Promise<void> {
		const {vault, reviews} = this.host;
		const target = vault.getAbstractFileByPath(targetPath);
		if (!(target instanceof TFile) || target.extension !== "md" || targetPath === sourcePath) throw new Error("Select an existing Markdown file at a different path.");
		const current = await vault.read(target);
		if (this.disposed || reviews.get(sourcePath) !== diff || !diff.deleted || vault.getAbstractFileByPath(sourcePath) ||
			target.path !== targetPath || vault.getAbstractFileByPath(targetPath) !== target || current !== expected ||
			this.host.busy(sourcePath) || this.host.busy(targetPath)) throw new Error("The files changed. Open a new preview before confirming.");
		const other = reviews.get(targetPath);
		if (other && (other.draftContent !== other.newContent || other.conflicted || other.originalPath)) {
			throw new Error("The selected file has its own unfinished review. Resolve it before associating these files.");
		}
		const before = {...diff};
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
		const associatedDraft = diff.draftContent;
		diff.onUndoRename = async () => {
			const targetNow = vault.getAbstractFileByPath(targetPath);
			const latest = targetNow instanceof TFile ? await vault.read(targetNow) : null;
			if (reviews.get(targetPath) !== diff || vault.getAbstractFileByPath(sourcePath) ||
				this.host.busy(sourcePath) || this.host.busy(targetPath)) throw new Error("The paths changed. Resolve the current review before undoing this association.");
			const currentDraft = diff.draftContent;
			const editorState = diff.editorState;
			Object.assign(diff, before);
			diff.originalPath = before.originalPath;
			diff.created = before.created;
			if (currentDraft !== associatedDraft) { diff.draftContent = currentDraft; diff.editorState = editorState; }
			diff.onUndoRename = undefined;
			diff.renameDismissed = true;
			diff.renameCandidates = [];
			reviews.delete(targetPath);
			reviews.set(sourcePath, diff);
			if (other) { other.conflicted = latest !== null && latest !== other.newContent; reviews.set(targetPath, other); }
			if (latest !== null) this.observe(targetPath, latest, true);
			this.host.changed();
			this.schedule();
			await Promise.resolve();
		};
		this.host.changed();
		this.schedule();
	}

	async restore(): Promise<void> {
		const paths = [...new Set([...this.host.reviews.values()].flatMap(diff => diff.renameCandidates?.map(candidate => candidate.path) ?? []))].slice(0, MAX_CANDIDATES);
		for (const path of paths) {
			if (this.disposed) return;
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
