import type {TFile, Vault} from "obsidian";

export interface LifecycleState {
	path?: string;
	originalPath?: string;
	deleted?: boolean;
	/** A deletion review that did not replace an existing content review. */
	deletionOnly?: boolean;
	restoreOriginalPath?: boolean;
	internalReview?: boolean;
	matchContent?: string;
	renameCandidates?: {path: string; score: number}[];
	renameSources?: string[];
	renameDismissed?: boolean;
}

export function unresolvedRename(diff: LifecycleState): boolean {
	return !!(diff.renameCandidates?.length || diff.renameSources?.length);
}

export function renameOnly(diff: ReviewSnapshot): boolean {
	return !!diff.originalPath && !diff.deleted && diff.oldContent === diff.newContent && diff.draftContent === diff.newContent;
}

export interface ReviewSnapshot extends LifecycleState {
	oldContent: string;
	/** The disk version against which this draft was reviewed. */
	newContent: string;
	draftContent: string;
	conflicted: boolean;
}

export interface PersistedDiffEntry extends LifecycleState {
	path: string;
	oldContent: string;
	newContent: string;
	draftContent?: string;
}

export function restoreReview(entry: PersistedDiffEntry, current: string): ReviewSnapshot | null {
	const draft = entry.draftContent ?? entry.newContent;
	if (draft !== entry.newContent) {
		return {oldContent: entry.oldContent, newContent: entry.newContent,
			draftContent: draft, conflicted: current !== entry.newContent};
	}
	if (current === entry.oldContent) return null;
	return {oldContent: entry.oldContent, newContent: current, draftContent: current, conflicted: false};
}

export class ReviewConflictError extends Error {
	constructor() {
		super("The file changed after this review started.");
	}
}

/** Compare inside Vault.process so checking and writing use one file operation. */
export async function writeReviewedContent(vault: Pick<Vault, "process">, file: TFile,
	expected: string, result: string, beforeWrite: () => void): Promise<void> {
	await vault.process(file, current => {
		if (current !== expected) throw new ReviewConflictError();
		beforeWrite();
		return result;
	});
}
