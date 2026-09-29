import {Change, diff} from "@codemirror/merge";
import {patienceDiff} from "./patienceDiff";

/** Anchor unchanged lines before refining changed blocks to character ranges. */
export function wordDiff(a: string, b: string): readonly Change[] {
	// Keep separators in tokens: adding/removing the final newline is a change too.
	const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const entries = patienceDiff(lines(a), lines(b)).lines;
	const changes: Change[] = [];
	let fromA = 0, fromB = 0, toA = 0, toB = 0;
	const flush = () => {
		if (fromA === toA && fromB === toB) return;
		// Bound expensive character comparisons locally, so a fallback cannot
		// swallow unchanged sections between distant edits in a large document.
		for (const change of diff(a.slice(fromA, toA), b.slice(fromB, toB), {scanLimit: 500, timeout: 20})) {
			changes.push(new Change(change.fromA + fromA, change.toA + fromA,
				change.fromB + fromB, change.toB + fromB));
		}
	};
	for (const entry of entries) {
		if (entry.aIndex >= 0 && entry.bIndex >= 0) {
			flush();
			toA += entry.line.length;
			toB += entry.line.length;
			fromA = toA;
			fromB = toB;
		} else if (entry.aIndex >= 0) {
			toA += entry.line.length;
		} else {
			toB += entry.line.length;
		}
	}
	flush();
	return changes;
}
