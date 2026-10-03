import type {Vault} from "obsidian";
import type {ReviewSnapshot} from "./reviewDraft";

/** Last observed text, independent of a review's original and editable draft. */
export function checkpoint(baselines: Map<string, string>, reviews: Map<string, ReviewSnapshot>): [string, string][] {
	const result = new Map(baselines);
	for (const [path, review] of reviews) {
		if (review.deleted) result.delete(path);
		else if (result.has(path)) result.set(path, review.matchContent ?? review.newContent);
	}
	return [...result];
}

/** Reuse the startup scan, with bounded parallel reads and per-file failures. */
export async function readCheckpoint(vault: Pick<Vault, "getMarkdownFiles" | "read" | "getAbstractFileByPath">): Promise<{
	contents: Map<string, string>; unavailable: Set<string>;
}> {
	const files = vault.getMarkdownFiles();
	const contents = new Map<string, string>();
	const unavailable = new Set<string>();
	let next = 0;
	await Promise.all(Array.from({length: Math.min(4, files.length)}, async () => {
		while (next < files.length) {
			const file = files[next++]!;
			const path = file.path;
			try {
				const text = await vault.read(file);
				if (file.path === path && vault.getAbstractFileByPath(path) === file) contents.set(path, text);
				else unavailable.add(path);
			} catch { unavailable.add(path); }
		}
	}));
	return {contents, unavailable};
}
