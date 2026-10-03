import {Notice} from "obsidian";
import type {PendingDiff} from "./DiffView";
import {renamePaths} from "./renamePaths";

/** Update association controls independently of the editable comparison. */
export function renderRenameSuggestions(container: HTMLElement, diff: PendingDiff, tracking: boolean): void {
	container.empty();
	if (diff.onUndoRename) {
		const undo = container.createEl("button", {text: "Undo association"});
		undo.title = "Undo this association while the review remains open in this session.";
		undo.addEventListener("click", () => { void diff.onUndoRename?.().catch(error => {
			new Notice(error instanceof Error ? error.message : "Could not undo association.");
		}); });
	}
	if (diff.deleted && (tracking || diff.renameCandidates?.length || diff.renameDismissed)) {
		const candidates = diff.renameCandidates ?? [];
		const best = candidates[0];
		if (best) {
			renamePaths(container, diff.path ?? "Missing file", best.path);
			container.createDiv({text: best.score === 1 ? "Possible rename · identical contents; confirmation required." : `Possible rename · ${Math.floor(best.score * 100)}% content similarity; confirmation required.`});
			if (candidates.length > 1) container.createDiv({text: `${candidates.length - 1} other possible matches available.`});
		} else if (tracking && !diff.renameDismissed) {
			container.createDiv({text: "No automatic match yet. Large, empty, short, or older files may need manual selection."});
		}
		const choose = container.createEl("button", {text: best ? "Review match…" : "Select renamed file…"});
		choose.addEventListener("click", () => diff.onFindRename?.());
		if (best) {
			const confirm = container.createEl("button", {text: "Confirm rename"});
			confirm.disabled = !diff.onConfirmRename;
			confirm.title = `Associate with ${best.path} without opening a preview. No files are moved or changed.`;
			confirm.addEventListener("click", () => {
				confirm.disabled = true;
				void diff.onConfirmRename?.(best.path).catch(error => {
					new Notice(error instanceof Error ? error.message : "Could not confirm rename.");
				}).finally(() => { confirm.disabled = false; });
			});
			const separate = container.createEl("button", {text: "Treat as separate files"});
			separate.addEventListener("click", () => diff.onKeepSeparate?.());
		} else if (diff.renameDismissed) {
			const resume = container.createEl("button", {text: "Look for matches again"});
			resume.addEventListener("click", () => diff.onResumeMatching?.());
		}
	} else if (diff.renameSources?.length) {
		container.createDiv({text: `Possible rename candidate for: ${diff.renameSources.join(", ")}. Resolve the missing-file review first.`});
	}
}
