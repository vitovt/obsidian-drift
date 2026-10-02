import {App, FuzzySuggestModal, Modal, Setting, TFile} from "obsidian";
import {MergeView} from "@codemirror/merge";
import {EditorView, lineNumbers} from "@codemirror/view";
import {EditorState} from "@codemirror/state";
import type {PendingDiff} from "./DiffView";
import type {RenameMatcher} from "./renameMatcher";

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

	constructor(app: App, private path: string, private diff: PendingDiff, private matcher: RenameMatcher) { super(app); }

	onOpen(): void {
		this.modalEl.addClass("diff-rename-modal");
		this.titleEl.setText("Possible rename");
		this.contentEl.createEl("p", {text: `Missing file: ${this.path}`});
		this.contentEl.createEl("p", {text: "Candidates are ordered by content similarity, not certainty. Preview a file before confirming."});
		const candidates = this.diff.renameCandidates ?? [];
		if (!candidates.length) this.contentEl.createEl("p", {text: "No automatic match found. You can select a file manually."});
		for (const candidate of candidates) {
			new Setting(this.contentEl).setName(candidate.path)
				.setDesc(`${Math.floor(candidate.score * 100)}% similarity`)
				.addButton(button => button.setButtonText("Preview").onClick(() => { void this.select(candidate.path); }));
		}
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Select another file…").onClick(() => {
				new RenameFilePicker(this.app, this.path, file => { void this.select(file.path); }).open();
			}))
			.addButton(button => button.setButtonText("Keep separate").onClick(() => { this.matcher.keepSeparate(this.diff); this.close(); }));
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Original is the literal comparison label.
		if (this.diff.draftContent !== this.diff.newContent) this.contentEl.createEl("p", {text: "Your edited result and undo history will be preserved. The preview compares Original with the selected file."});
		this.status = this.contentEl.createDiv({attr: {"aria-live": "polite"}});
		this.previewEl = this.contentEl.createDiv({cls: "diff-rename-preview"});
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => {
				button.setButtonText("Confirm rename").setCta().setDisabled(true).onClick(() => { void this.confirm(); });
				this.confirmButton = button.buttonEl;
			});
	}

	private async select(path: string): Promise<void> {
		const generation = ++this.generation;
		this.selected = undefined;
		this.confirmButton.disabled = true;
		this.preview?.destroy(); this.preview = undefined;
		this.previewEl.empty();
		this.status.setText("Loading preview…");
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== "md") throw new Error("The selected Markdown file is no longer available.");
			if (file.stat.size > 1024 * 1024 || this.diff.oldContent.length > 1024 * 1024) throw new Error("This file exceeds the 1 MB rename preview limit.");
			const content = await this.app.vault.read(file);
			if (this.closed || generation !== this.generation) return;
			if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error("The selected file moved. Select it again.");
			const extensions = [lineNumbers(), EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false)];
			this.preview = new MergeView({parent: this.previewEl,
				a: {doc: this.diff.oldContent, extensions}, b: {doc: content, extensions},
				highlightChanges: true, diffConfig: {scanLimit: 500, timeout: 50}});
			this.status.setText(`Original → ${path}. Confirming associates the review; it does not modify files.`);
			this.selected = {path, content};
			this.confirmButton.disabled = false;
		} catch (error) {
			if (!this.closed && generation === this.generation) this.status.setText(error instanceof Error ? error.message : "Could not load preview.");
		}
	}

	private async confirm(): Promise<void> {
		if (!this.selected || this.confirmButton.disabled) return;
		this.confirmButton.disabled = true;
		try {
			await this.matcher.confirm(this.path, this.diff, this.selected.path, this.selected.content);
			this.close();
		} catch (error) {
			if (!this.closed) this.status.setText(error instanceof Error ? error.message : "Could not confirm rename.");
		}
	}

	onClose(): void {
		this.closed = true;
		this.generation++;
		this.preview?.destroy();
		this.contentEl.empty();
	}
}
