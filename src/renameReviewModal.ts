import {App, FuzzySuggestModal, Modal, Setting, TFile} from "obsidian";
import {MergeView} from "@codemirror/merge";
import {EditorView, lineNumbers} from "@codemirror/view";
import {EditorState} from "@codemirror/state";
import type {PendingDiff} from "./DiffView";
import type {RenameMatcher} from "./renameMatcher";
import {searchRenameFiles} from "./renameSearch";
import {renamePath, renamePaths} from "./renamePaths";

class RenameFilePicker extends FuzzySuggestModal<TFile> {
	constructor(app: App, private source: string, private select: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Select the renamed Markdown file");
	}
	getItems(): TFile[] { return this.app.vault.getMarkdownFiles().filter(file => file.path !== this.source); }
	getItemText(file: TFile): string { return file.path; }
	onChooseItem(file: TFile): void { this.select(file); }
}

/** Association changes review metadata only. File contents are never written here. */
export class RenameReviewModal extends Modal {
	private preview?: MergeView;
	private previewEl!: HTMLElement;
	private status!: HTMLElement;
	private confirmButton!: HTMLButtonElement;
	private selected?: {path: string; content: string};
	private generation = 0;
	private closed = false;
	private searchGeneration = 0;
	private searchResults!: HTMLElement;

	constructor(app: App, private path: string, private diff: PendingDiff, private matcher: RenameMatcher,
		private initialPath?: string) { super(app); }

	onOpen(): void {
		this.modalEl.addClass("diff-rename-modal");
		this.titleEl.setText("Link to existing file");
		renamePath(this.contentEl.createDiv({cls: "diff-rename-paths"}), "From", this.path, true);
		this.contentEl.createEl("p", {text: "Candidates are ordered by content similarity, not certainty. Preview a file before confirming."});
		const candidates = this.diff.renameCandidates ?? [];
		if (!candidates.length) this.contentEl.createEl("p", {text: "No automatic match found. You can select a file manually."});
		for (const candidate of candidates) {
			const setting = new Setting(this.contentEl);
			renamePath(setting.nameEl, "To", candidate.path, true);
			setting
				.setDesc(candidate.score === 1 ? "Identical contents" : `${Math.floor(candidate.score * 100)}% content similarity`)
				.addButton(button => button.setButtonText("Preview").onClick(() => { void this.select(candidate.path); }));
		}
		this.searchResults = this.contentEl.createDiv();
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Find matches in vault").onClick(() => { void this.search(); }))
			.addButton(button => button.setButtonText("Cancel search").onClick(() => { this.searchGeneration++; this.searchResults.setText("Search cancelled."); }))
			.addButton(button => button.setButtonText("Select another file…").onClick(() => {
				new RenameFilePicker(this.app, this.path, file => { void this.select(file.path); }).open();
			}))
			.addButton(button => button.setButtonText("Treat as separate files").onClick(() => { this.matcher.keepSeparate(this.diff); this.close(); }));
		if (this.diff.draftContent !== this.diff.newContent) this.contentEl.createEl("p", {text: "Your edited result and undo history will be preserved. The preview compares the last known contents with the selected file."});
		this.previewEl = this.contentEl.createDiv({cls: "diff-rename-preview"});
		const footer = this.contentEl.createDiv({cls: "diff-rename-footer"});
		this.status = footer.createDiv({cls: "diff-rename-status", attr: {"aria-live": "polite"}});
		this.status.setText("Preview a candidate before confirming the rename.");
		new Setting(footer)
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => {
				button.setButtonText("Confirm rename").setCta().onClick(() => { void this.confirm(); });
				this.confirmButton = button.buttonEl;
				this.confirmButton.disabled = true;
			});
		const initialPath = this.initialPath ?? (candidates.length === 1 ? candidates[0]!.path : undefined);
		if (initialPath) void this.select(initialPath);
	}

	private async search(): Promise<void> {
		const generation = ++this.searchGeneration;
		const cancelled = () => this.closed || generation !== this.searchGeneration;
		this.searchResults.setText("Searching vault…");
		try {
			const matches = await searchRenameFiles(this.app.vault, this.path,
				this.diff.matchContent ?? this.diff.newContent, cancelled,
				(checked, total) => { if (!cancelled()) this.searchResults.setText(`Checking ${checked} of ${total} files…`); });
			if (cancelled()) return;
			this.searchResults.empty();
			this.searchResults.createEl("p", {text: matches.length ? "Possible matches — preview before linking." : "No matches found. Large or unreadable files may be skipped; select a file manually."});
			for (const match of matches) {
				new Setting(this.searchResults).setName(match.path)
					.setDesc(match.score === 1 ? "Identical contents" : `${Math.floor(match.score * 100)}% content similarity`)
					.addButton(button => button.setButtonText("Preview").onClick(() => { void this.select(match.path); }));
			}
		} catch (error) {
			if (!cancelled()) this.showError(error, "Could not search the vault.");
		}
	}

	private async select(path: string): Promise<void> {
		const generation = ++this.generation;
		this.selected = undefined;
		this.confirmButton.disabled = true;
		this.preview?.destroy(); this.preview = undefined;
		this.previewEl.empty();
		this.status.removeClass("is-error");
		this.status.setText("Loading preview…");
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== "md") throw new Error("The selected Markdown file is no longer available.");
			if (file.stat.size > 1024 * 1024 || (this.diff.matchContent ?? this.diff.newContent).length > 1024 * 1024) throw new Error("This file exceeds the 1 MB rename preview limit.");
			const content = await this.app.vault.read(file);
			if (this.closed || generation !== this.generation) return;
			if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error("The selected file moved. Select it again.");
			const extensions = [lineNumbers(), EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false)];
			this.preview = new MergeView({parent: this.previewEl,
				a: {doc: this.diff.matchContent ?? this.diff.newContent, extensions}, b: {doc: content, extensions},
				highlightChanges: true, diffConfig: {scanLimit: 500, timeout: 50}});
			this.status.empty();
			renamePaths(this.status, this.path, path, true);
			this.status.createSpan({text: "Confirm rename links this review to the selected file; it does not move or modify files."});
			this.selected = {path, content};
			this.confirmButton.disabled = false;
		} catch (error) {
			if (!this.closed && generation === this.generation) this.showError(error, "Could not load preview.");
		}
	}

	private async confirm(): Promise<void> {
		if (this.confirmButton.disabled) return;
		if (!this.selected) {
			this.showError("Preview a candidate before confirming the rename.", "Select a file first.");
			return;
		}
		this.confirmButton.disabled = true;
		try {
			await this.matcher.confirm(this.path, this.diff, this.selected.path, this.selected.content);
			this.close();
		} catch (error) {
			if (!this.closed) {
				this.showError(error, "Could not confirm rename.");
				this.confirmButton.disabled = false;
			}
		}
	}

	private showError(error: unknown, fallback: string): void {
		this.status.addClass("is-error");
		this.status.setText(error instanceof Error ? error.message : typeof error === "string" ? error : fallback);
	}

	onClose(): void {
		this.closed = true;
		this.generation++;
		this.preview?.destroy();
		this.contentEl.empty();
	}
}
