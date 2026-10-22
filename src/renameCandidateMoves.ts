import {TFile, type TAbstractFile, type Vault} from "obsidian";
import type {PendingDiff} from "./DiffView";

/** Follow only explicit vault rename events, retaining cache order and expiry. */
export function moveRenameCandidates<T>(created: Map<string, T>, reviews: Map<string, PendingDiff>,
	vault: Vault, file: TAbstractFile, oldPath: string): void {
	if (oldPath === file.path) return;
	const destination = (path: string): string | undefined => {
		if (path !== oldPath && (file instanceof TFile || !path.startsWith(oldPath + "/"))) return path;
		const next = file.path + path.slice(oldPath.length);
		const target = vault.getAbstractFileByPath(next);
		return target instanceof TFile && target.extension === "md" && (!(file instanceof TFile) || target === file)
			? next : undefined;
	};
	const previous = new Map(created);
	created.clear();
	for (const [path, candidate] of previous) {
		const next = destination(path);
		// An occupied cache key belongs to another observation; do not replace it.
		if (next !== undefined && (next === path || !previous.has(next))) created.set(next, candidate);
	}
	for (const [source, diff] of reviews) {
		const suggestions = diff.renameCandidates;
		if (!suggestions) continue;
		const paths = new Set(suggestions.map(candidate => candidate.path));
		const moved = new Map<string, {path: string; score: number}>();
		for (const candidate of suggestions) {
			const next = destination(candidate.path);
			if (next === undefined || next === source) continue;
			if (next !== candidate.path && (previous.has(next) || paths.has(next))) continue;
			if (!moved.has(next)) moved.set(next, {...candidate, path: next});
		}
		diff.renameCandidates = [...moved.values()];
	}
	// Source review keys have already followed the same event in FileLifecycle.
	for (const diff of reviews.values()) diff.renameSources = [];
	for (const [source, diff] of reviews) {
		for (const candidate of diff.renameCandidates ?? []) {
			const target = reviews.get(candidate.path);
			if (target) (target.renameSources ??= []).push(source);
		}
	}
}
