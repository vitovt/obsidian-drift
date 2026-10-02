import type {ReviewSnapshot} from "./reviewDraft";

/** Lifecycle changes preserve the original, draft and editor history on the object. */
export function markDeleted<T extends ReviewSnapshot & {missing?: boolean}>(review: T, standalone: boolean): void {
	review.matchContent ??= review.newContent;
	review.deletionOnly = standalone;
	review.deleted = true;
	review.missing = true;
}

export function markPresent<T extends ReviewSnapshot & {missing?: boolean}>(review: T): void {
	review.deleted = false;
	review.deletionOnly = false;
	review.missing = false;
	review.renameCandidates = [];
}
