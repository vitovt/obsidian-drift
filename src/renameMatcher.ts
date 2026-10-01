import {TFile, type Vault} from "obsidian";
import type {PendingDiff} from "./DiffView";
import type {ExternalDiffSettings} from "./settings";
import {fingerprint, similarity, type Fingerprint} from "./renameSimilarity";

const MAX_CANDIDATES = 128;
const MAX_TEXT = 2 * 1024 * 1024;
const RETENTION_MS = 30 * 60 * 1000;
interface Candidate {print: Fingerprint; observed: number}
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
	constructor(private host: Host) {}

	observe(path: string, text: string, created = false): void {
		if (this.disposed || !this.host.settings.enabled || !this.host.settings.trackFileRenames) return;
		if (!created && !this.created.has(path)) return;
		const print = fingerprint(text);
		this.created.delete(path);
		if (print) this.created.set(path, {print, observed: Date.now()});
		let size = [...this.created.values()].reduce((sum, value) => sum + value.print.text.length, 0);
		while (this.created.size > MAX_CANDIDATES || size > MAX_TEXT) {
			const first = [...this.created.keys()][0]!;
			size -= this.created.get(first)!.print.text.length;
			this.created.delete(first);
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
		const sources = [...reviews].filter(([, diff]) => diff.deleted && !diff.renameDismissed).slice(-MAX_CANDIDATES);
		for (const [path, candidate] of this.created) {
			if (Date.now() - candidate.observed > RETENTION_MS || !(vault.getAbstractFileByPath(path) instanceof TFile)) this.created.delete(path);
		}
		for (const source of this.sources.keys()) if (!sources.some(([, diff]) => diff === source)) this.sources.delete(source);
		const results = new Map<string, {path: string; score: number}[]>();
		let textBudget = MAX_TEXT;
		if (settings.enabled && settings.trackFileRenames) {
			for (const [path, diff] of sources) {
				const text = diff.matchContent ?? diff.newContent;
				textBudget -= text.length;
				if (textBudget < 0) { this.sources.delete(diff); continue; }
				let source = this.sources.get(diff);
				if (source === undefined || source?.text !== text) {
					source = fingerprint(text);
					this.sources.set(diff, source);
				}
				if (!source || vault.getAbstractFileByPath(path)) continue;
				const candidates: {path: string; score: number}[] = [];
				let comparisons = 0;
				for (const [target, candidate] of this.created) {
					if (target !== path && vault.getAbstractFileByPath(target) instanceof TFile) {
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
		for (const diff of reviews.values()) diff.renameSources = [];
		for (const [path, diff] of reviews) {
			// Keep saved suggestions until explicitly resolved, even after cache eviction.
			const previous = diff.renameCandidates ?? [];
			const suggested = [...(results.get(path) ?? []), ...previous.filter(candidate => !this.created.has(candidate.path))]
				.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 8);
			diff.renameCandidates = diff.deleted && !diff.renameDismissed
				? suggested.filter(candidate => candidate.path !== path && vault.getAbstractFileByPath(candidate.path) instanceof TFile) : [];
			for (const candidate of diff.renameCandidates) {
				const target = reviews.get(candidate.path);
				if (target) (target.renameSources ??= []).push(path);
			}
		}
		this.host.changed();
	}

	keepSeparate(diff: PendingDiff): void {
		diff.renameDismissed = true;
		diff.renameCandidates = [];
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
		const edited = diff.draftContent !== diff.newContent;
		if (!edited) {
			if (diff.draftContent !== current) diff.editorState = undefined;
			diff.newContent = current;
			diff.draftContent = current;
		}
		diff.conflicted = edited && diff.newContent !== current;
		diff.originalPath ??= sourcePath;
		diff.path = targetPath;
		diff.deleted = diff.deletionOnly = diff.missing = diff.recreateMissingFile = false;
		diff.renameCandidates = [];
		diff.renameSources = [];
		diff.matchContent = undefined;
		const entries = [...reviews];
		reviews.clear();
		for (const [path, entry] of entries) {
			if (path === targetPath) continue;
			reviews.set(path === sourcePath ? targetPath : path, entry);
		}
		this.created.delete(targetPath);
		this.host.baselines.set(targetPath, current);
		for (const entry of reviews.values()) entry.renameCandidates = entry.renameCandidates?.filter(candidate => candidate.path !== targetPath);
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
