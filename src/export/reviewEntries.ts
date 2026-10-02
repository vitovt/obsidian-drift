import {unresolvedRename, type ReviewSnapshot} from "../reviewDraft";
import type {ExportEntry} from "./unifiedDiff";

/** One selection rule for availability, export contents, and omission counts. */
export function selectExportEntries(reviews: Iterable<readonly [string, ReviewSnapshot]>): {entries: ExportEntry[]; omitted: number} {
	const entries: ExportEntry[] = [];
	let omitted = 0;
	for (const [path, diff] of reviews) {
		if (unresolvedRename(diff)) { omitted++; continue; }
		if (diff.oldContent === diff.draftContent && !diff.deleted && !diff.originalPath) continue;
		entries.push({path, oldContent: diff.oldContent, draftContent: diff.deleted ? "" : diff.draftContent,
			originalPath: diff.originalPath, deleted: diff.deleted, conflicted: diff.conflicted});
	}
	return {entries, omitted};
}
