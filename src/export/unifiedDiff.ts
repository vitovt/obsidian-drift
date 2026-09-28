import {patienceDiff} from "../patienceDiff";

export interface ExportEntry {
	path: string;
	oldContent: string;
	draftContent: string;
	conflicted?: boolean;
}

export function validContextLines(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Git-compatible C quoting, including UTF-8 byte escapes for unusual paths. */
function quotePath(path: string): string {
	if (/^[\w./-]+$/.test(path)) return path;
	let quoted = '"';
	for (const byte of new TextEncoder().encode(path)) {
		if (byte === 34 || byte === 92) quoted += "\\" + String.fromCharCode(byte);
		else if (byte < 32 || byte >= 127) quoted += "\\" + ("00" + byte.toString(8)).slice(-3);
		else quoted += String.fromCharCode(byte);
	}
	return quoted + '"';
}

/** Keep line endings in tokens so final-newline and CRLF changes are explicit. */
function lines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function range(before: number, count: number): string {
	return `${count === 0 ? before : before + 1},${count}`;
}

function filePatch(entry: ExportEntry, context: number): string {
	if (entry.oldContent === entry.draftContent) return "";
	if (!entry.path || entry.path.startsWith("/") || entry.path.includes("\\") ||
		entry.path.split("/").some(part => !part || part === "." || part === "..")) {
		throw new Error("Export paths must be relative to the vault root.");
	}
	const edits = patienceDiff(lines(entry.oldContent), lines(entry.draftContent)).lines;
	const oldPositions = [0], newPositions = [0];
	const groups: {start: number; end: number}[] = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i]!;
		oldPositions.push(oldPositions[i]! + (edit.aIndex >= 0 ? 1 : 0));
		newPositions.push(newPositions[i]! + (edit.bIndex >= 0 ? 1 : 0));
		if (edit.aIndex >= 0 && edit.bIndex >= 0) continue;
		const start = Math.max(0, i - context), end = Math.min(edits.length, i + context + 1);
		const previous = groups[groups.length - 1];
		if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
		else groups.push({start, end});
	}
	const a = quotePath(`a/${entry.path}`), b = quotePath(`b/${entry.path}`);
	const output = [`diff --git ${a} ${b}\n--- ${a}\n+++ ${b}\n`];
	for (const {start, end} of groups) {
		output.push(`@@ -${range(oldPositions[start]!, oldPositions[end]! - oldPositions[start]!)} +${range(newPositions[start]!, newPositions[end]! - newPositions[start]!)} @@\n`);
		for (let i = start; i < end; i++) {
			const edit = edits[i]!;
			const prefix = edit.aIndex < 0 ? "+" : edit.bIndex < 0 ? "-" : " ";
			output.push(prefix + edit.line);
			if (!edit.line.endsWith("\n")) output.push("\n\\ No newline at end of file\n");
		}
	}
	return output.join("");
}

/** Export a frozen Original -> Result snapshot, independent of viewer folding. */
export function createUnifiedExport(entries: readonly ExportEntry[], context = 3, date = new Date()): string {
	if (!validContextLines(context)) throw new Error("Context lines must be a non-negative integer.");
	const changed = entries.filter(entry => entry.oldContent !== entry.draftContent)
		.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	if (changed.length === 0) return "";
	const header = [
		"Drift diff export",
		`Created: ${date.toISOString()}`,
		"Comparison: Original -> Result draft (snapshot at export dialog opening)",
		`Context lines: ${context}`,
		"Paths: relative to vault root, with a/ and b/ prefixes",
		"Apply to the Original versions, not necessarily the current files on disk.",
		...(context === 0 ? ["Zero-context patch: git apply requires --unidiff-zero."] : []),
		`Files (${changed.length}):`,
		...changed.map(entry => `  ${JSON.stringify(entry.path)}${entry.conflicted ? " [disk changed since review]" : ""}`),
		"", "",
	].join("\n");
	return header + changed.map(entry => filePatch(entry, context)).join("");
}
