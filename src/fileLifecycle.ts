import {TFile, type TAbstractFile, type Vault} from "obsidian";
import type {PendingDiff} from "./DiffView";
import type {ExternalDiffSettings} from "./settings";
import {markDeleted} from "./reviewTransitions";
import {renameOnly} from "./reviewDraft";

interface LifecycleHost {
	vault: Vault;
	settings: ExternalDiffSettings;
	baselines: Map<string, string>;
	reviews: Map<string, PendingDiff>;
	make(path: string, original: string, result: string): PendingDiff;
	changed(): void;
}

/** Uses existing baselines only; no scans, hashes, or inferred renames. */
export class FileLifecycle {
	private deletedPaths = new Map<string, boolean>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(private host: LifecycleHost) {}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.deletedPaths.clear();
	}

	deleted(file: TAbstractFile, internal = false): void {
		const {baselines, reviews} = this.host;
		const paths = file instanceof TFile ? [file.path] : [...baselines.keys(), ...reviews.keys()]
			.filter(path => path.startsWith(file.path + "/"));
		for (const path of paths) if (baselines.has(path) || reviews.has(path)) this.deletedPaths.set(path, internal);
		if (this.timer || !this.deletedPaths.size) return;
		// Batch folder deletions and allow atomic replacements to settle.
		this.timer = setTimeout(() => this.flushDeletions(), 500);
	}

	private flushDeletions(): void {
		this.timer = undefined;
		const {baselines, reviews, settings, vault} = this.host;
		for (const [path, internal] of this.deletedPaths) {
			if (vault.getAbstractFileByPath(path) instanceof TFile) continue;
			const previous = reviews.get(path);
			const baseline = baselines.get(path);
			if (previous?.created && previous.draftContent === previous.newContent) {
				reviews.delete(path);
				baselines.delete(path);
				continue;
			}
			if (settings.enabled && (settings.trackFileDeletions || settings.trackFileRenames) && (!internal || settings.trackApiChanges) && (previous || baseline !== undefined)) {
				const diff = previous ?? this.host.make(path, baseline!, baseline!);
				diff.matchContent ??= previous?.newContent ?? baseline;
				markDeleted(diff, previous ? !!previous.deletionOnly : true);
				reviews.set(path, diff);
			}
			baselines.delete(path);
		}
		this.deletedPaths.clear();
		this.host.changed();
	}

	rename(file: TAbstractFile, oldPath: string, internal = false): void {
		const {baselines, reviews, settings} = this.host;
		const destination = (path: string) => path === oldPath ? file.path : file.path + path.slice(oldPath.length);
		const affected = (path: string) => path === oldPath || path.startsWith(oldPath + "/");
		const baseline = baselines.get(oldPath);
		const baselineEntries = file instanceof TFile ? (baseline === undefined ? [] : [[oldPath, baseline] as const]) : [...baselines];
		for (const [path, content] of baselineEntries) {
			if (!affected(path)) continue;
			baselines.delete(path);
			baselines.set(destination(path), content);
		}
		if (reviews.size || settings.enabled && settings.trackFileRenames) {
			if (settings.enabled && (!internal || settings.trackApiChanges) && settings.trackFileRenames && file instanceof TFile && file.extension === "md" && !reviews.has(oldPath) && baseline !== undefined) {
				reviews.set(oldPath, this.host.make(oldPath, baseline, baseline));
			}
			// Rebuild keys in place order, keeping review objects and editor history.
			const entries = [...reviews];
			const byPath = new Map(entries);
			reviews.clear();
			for (const [path, diff] of entries) {
				if (!affected(path)) { reviews.set(path, diff); continue; }
				const next = destination(path);
				// A pending review at the destination may contain an unrelated draft.
				// Keep both reviews rather than replacing that draft implicitly.
				if (byPath.has(next) && byPath.get(next) !== diff) {
					reviews.set(path, diff);
					continue;
				}
				diff.originalPath ??= path;
				diff.path = next;
				diff.missing = false;
				diff.recreateMissingFile = false;
				if (diff.originalPath === next) {
					const wasRenameOnly = renameOnly(diff);
					diff.originalPath = undefined;
					diff.restoreOriginalPath = false;
					if (wasRenameOnly) continue;
				}
				reviews.set(next, diff);
			}
		}
		this.host.changed();
	}
}
