import {renameOnly, unresolvedRename, type ReviewSnapshot} from "./reviewDraft";

type Review = ReviewSnapshot & {missing?: boolean};

export function reviewLabels(diff: Review): {keep: string; restore: string} {
	return {
		keep: diff.deleted ? "Keep deletion" : diff.missing ? "Restore result" : diff.draftContent !== diff.newContent ? "Save result" : diff.created ? "Keep new file" : renameOnly(diff) ? "Keep rename" : "Keep current",
		restore: diff.created ? "Move new file to trash" : diff.deleted ? diff.deletionOnly ? "Restore file" : "Restore original" : renameOnly(diff) ? "Restore original path" : "Restore original",
	};
}

export function summarizeReviews(reviews: Iterable<Review>) {
	const summary = {keep: 0, restore: 0, unresolved: 0, drafts: 0, unavailable: 0, conflicts: 0, created: 0, renamed: 0, deleted: 0};
	for (const diff of reviews) {
		if (unresolvedRename(diff)) { summary.unresolved++; continue; }
		if (diff.conflicted && !diff.missing) { summary.unavailable++; summary.conflicts++; continue; }
		summary.restore++;
		if (diff.created) summary.created++;
		if (diff.originalPath) summary.renamed++;
		if (diff.deleted) summary.deleted++;
		if (diff.draftContent !== diff.newContent) summary.drafts++;
		else if (diff.missing && !diff.deleted) summary.unavailable++;
		else summary.keep++;
	}
	return summary;
}

/** Values covered by a destructive confirmation; later changes require a fresh decision. */
export function reviewDecision(diff: Review): readonly unknown[] {
	return [diff.oldContent, diff.newContent, diff.draftContent, diff.originalPath, diff.created, diff.deleted, diff.missing, diff.conflicted, unresolvedRename(diff)];
}
