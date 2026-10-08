import type {Vault} from "obsidian";
import {fingerprint, similarity, MAX_MATCH_TEXT} from "./renameSimilarity";

/** Explicit, cancellable search includes files already present in checkpoints. */
export async function searchRenameFiles(vault: Vault, sourcePath: string, text: string,
	cancelled: () => boolean, progress: (checked: number, total: number) => void): Promise<{path: string; score: number}[]> {
	const source = fingerprint(text);
	const files = vault.getMarkdownFiles().filter(file => file.path !== sourcePath);
	const matches: {path: string; score: number}[] = [];
	for (let i = 0; i < files.length; i++) {
		if (cancelled()) return [];
		const file = files[i]!;
		const path = file.path;
		// Bound fuzzy matching work; large files remain available in the picker.
		if (file.stat.size <= MAX_MATCH_TEXT) {
			try {
				const current = await vault.read(file);
				if (cancelled()) return [];
				if (file.path === path && vault.getAbstractFileByPath(path) === file) {
					const target = source && fingerprint(current);
					const score = current === text && text.trim() ? 1 : source && target ? similarity(source, target) : 0;
					if (score >= 0.8) {
						matches.push({path, score});
						matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
						matches.splice(8);
					}
				}
			} catch { /* A sync operation may temporarily make a file unreadable. */ }
		}
		if (i % 8 === 0) {
			progress(i + 1, files.length);
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
	}
	return matches;
}
