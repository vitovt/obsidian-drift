import {Notice, TFile, type App} from "obsidian";
import type {DiffView, PendingDiff} from "./DiffView";
import {ReviewConflictError, writeReviewedContent, unresolvedRename} from "./reviewDraft";

interface ReviewHost {
	app: App;
	reviews: Map<string, PendingDiff>;
	baselines: Map<string, string>;
	applying: Set<string>;
	selfModifyPaths: Set<string>;
	refreshMissing(): void;
	view(): DiffView | null;
	changed(): void;
	make(path: string, original: string, result: string): PendingDiff;
	setRestoringPath(path: string | null): void;
}

/** File effects and their preconditions, separate from detection and presentation. */
export class ReviewOperations {
	constructor(private host: ReviewHost) {}
	/** Apply only to the version reviewed, leaving failed/conflicting drafts open. */
	async completeReview(path: string, diff: PendingDiff, content: string, accept = false): Promise<boolean> {
		if (this.host.reviews.get(path) !== diff || this.host.applying.has(path)) return false;
		this.host.refreshMissing();
		const file = this.host.app.vault.getAbstractFileByPath(path);
		if (unresolvedRename(diff)) { new Notice("Resolve the possible rename before applying this review."); return false; }

		if (diff.conflicted && !diff.missing) {
			new Notice("Review the latest file changes before applying this draft.");
			return false;
		}
		this.host.applying.add(path);
		try {
			if (diff.created && !accept) {
				if (file instanceof TFile) {
					const current = await this.host.app.vault.read(file);
					if (current !== diff.newContent || file.path !== path || this.host.reviews.get(path) !== diff) throw new ReviewConflictError();
					await this.host.app.fileManager.trashFile(file);
				}
				this.host.reviews.delete(path);
				this.host.baselines.delete(path);
				this.host.changed();
				return true;
			}
			const restorePath = diff.originalPath && !accept;
			if (restorePath) {
				const target = diff.originalPath!;
				if (this.host.app.vault.getAbstractFileByPath(target)) throw new Error("The original path is occupied. Nothing was changed.");
				const parent = target.slice(0, target.lastIndexOf("/"));
				if (target.includes("/") && !this.host.app.vault.getAbstractFileByPath(parent)) throw new Error("The original folder is missing. Restore it before restoring the path.");
			}
			if (!(file instanceof TFile)) {
				await this.ensureParentFolders(path);
				// create refuses an occupied path, including files arriving during sync.
				if (this.host.reviews.get(path) !== diff) throw new ReviewConflictError();
				await this.host.app.vault.create(path, content);
				if (restorePath) {
					const recreated = this.host.app.vault.getAbstractFileByPath(path);
					if (!(recreated instanceof TFile)) throw new ReviewConflictError();
					this.host.setRestoringPath(path);
					try { await this.host.app.vault.rename(recreated, diff.originalPath!); }
					finally { this.host.setRestoringPath(null); }
				}
			} else if (content === diff.newContent) {
				// Acknowledgement must not emit a write, even when disk changed again.
				const current = await this.host.app.vault.read(file);
				if (!accept && current !== diff.newContent) throw new ReviewConflictError();
				content = current;
				if (this.host.reviews.get(path) !== diff || file.path !== path || this.host.app.vault.getAbstractFileByPath(path) !== file) return false;
			} else {
				await writeReviewedContent(this.host.app.vault, file, diff.newContent, content, () => {
					if (this.host.reviews.get(path) !== diff || file.path !== path || this.host.app.vault.getAbstractFileByPath(path) !== file) throw new ReviewConflictError();
					this.host.selfModifyPaths.add(path);
				});
			}
			if (file instanceof TFile && (file.path !== path || this.host.app.vault.getAbstractFileByPath(path) !== file)) throw new ReviewConflictError();
			if (file instanceof TFile && !(accept && content === diff.newContent)) {
				// A later rename failure must not make the successful content write look stale.
				diff.newContent = content;
			}
			if (restorePath && file instanceof TFile) {
				if (file.path !== path || this.host.reviews.get(path) !== diff) throw new ReviewConflictError();
				this.host.setRestoringPath(path);
				try { await this.host.app.vault.rename(file, diff.originalPath!); }
				finally { this.host.setRestoringPath(null); }
				this.host.baselines.delete(path);
			}
			if (this.host.reviews.get(path) === diff) this.host.reviews.delete(path);
			if (!(file instanceof TFile)) {
				diff.deleted = false;
				diff.missing = false;
			}
			this.host.baselines.set(restorePath ? diff.originalPath! : path, content);
			this.host.changed();
			return true;
		} catch (error) {
			this.host.selfModifyPaths.delete(path);
			if (error instanceof ReviewConflictError) {
				diff.conflicted = true;
				this.host.view()?.updateReviewStatus(path);
				new Notice("The file changed again. Review the latest changes before applying your draft.");
			} else {
				console.error("Drift: could not apply review", error);
				new Notice(`Could not finish applying the review. ${error instanceof Error ? error.message : ""} Your draft is still available; check the file before retrying.`, 12000);
			}
			this.host.changed();
			return false;
		} finally {
			this.host.applying.delete(path);
		}
	}

	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split("/");
		parts.pop();
		let parent = "";
		for (const part of parts) {
			parent = parent ? `${parent}/${part}` : part;
			if (!this.host.app.vault.getAbstractFileByPath(parent)) await this.host.app.vault.createFolder(parent);
		}
	}

	keepDeletion(path: string, diff: PendingDiff): Promise<boolean> {
		if (unresolvedRename(diff)) { new Notice("Resolve the possible rename first."); return Promise.resolve(false); }
		if (this.host.reviews.get(path) !== diff || this.host.applying.has(path)) return Promise.resolve(false);
		if (this.host.app.vault.getAbstractFileByPath(path)) {
			this.host.refreshMissing();
			new Notice("The file has reappeared. Review its current contents before continuing.");
			return Promise.resolve(false);
		}
		this.host.reviews.delete(path);
		this.host.baselines.delete(path);
		this.host.changed();
		return Promise.resolve(true);
	}

	/** Compare the preserved draft against the latest disk version, without writing. */
	async reviewLatest(path: string, previous: PendingDiff): Promise<void> {
		if (this.host.reviews.get(path) !== previous || this.host.applying.has(path)) return;
		const file = this.host.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		try {
			const current = await this.host.app.vault.read(file);
			if (this.host.reviews.get(path) !== previous) return;
			const diff = this.host.make(path, current, current);
			diff.draftContent = previous.draftContent;
			diff.renameSources = previous.renameSources;
			diff.originalPath = previous.originalPath;
			diff.created = previous.created;
			this.host.reviews.set(path, diff);
			this.host.view()?.addFile(path, diff);
			this.host.changed();
		} catch (error) {
			console.error("Drift: could not read latest version", error);
			new Notice("Could not read the latest version. Your draft is still available.");
		}
	}

}
