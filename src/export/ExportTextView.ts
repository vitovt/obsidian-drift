import {FileView, TFile, WorkspaceLeaf} from "obsidian";

export const EXPORT_TEXT_VIEW = "drift-export-text";

/** Show exported .txt files without registering a handler for every text file. */
export class ExportTextView extends FileView {
	private readVersion = 0;
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.registerEvent(this.app.vault.on("modify", file => {
			if (file === this.file && file instanceof TFile) void this.onLoadFile(file);
		}));
	}

	getViewType(): string { return EXPORT_TEXT_VIEW; }
	getDisplayText(): string { return this.file?.name ?? "Diff export"; }
	getIcon(): string { return "file-diff"; }

	async onLoadFile(file: TFile): Promise<void> {
		const version = ++this.readVersion;
		try {
			const text = await this.app.vault.read(file);
			if (this.file !== file || version !== this.readVersion) return;
			this.contentEl.empty();
			this.contentEl.createEl("pre", {cls: "diff-export-text", text});
		} catch {
			if (this.file !== file || version !== this.readVersion) return;
			this.contentEl.empty();
			this.contentEl.createEl("p", {text: "Could not read the exported file."});
		}
	}

	onUnloadFile(): Promise<void> {
		this.readVersion++;
		this.contentEl.empty();
		return Promise.resolve();
	}
}
