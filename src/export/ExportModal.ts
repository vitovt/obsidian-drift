import {App, ButtonComponent, Component, Modal, Notice, Setting, TextComponent} from "obsidian";
import {availableFilename, formatExportFilename} from "./filename";
import {inspectDestination, openExport, saveExport} from "./files";
import {createUnifiedExport, ExportEntry} from "./unifiedDiff";

export class ExportModal extends Modal {
	private lifetime = new Component();
	private filename!: TextComponent;
	private status!: HTMLElement;
	private exportButton!: ButtonComponent;
	private checkVersion = 0;
	private closed = false;
	private saving = false;
	private openAfterExport = true;
	private date = new Date();
	private patch = "";

	constructor(app: App, private entries: ExportEntry[], private template: string, private context: number, private unicodePaths: boolean) {
		super(app);
	}

	onOpen(): void {
		this.lifetime.load();
		this.titleEl.setText("Export diff");
		this.contentEl.createEl("p", {text: `${this.entries.length} files · Original → Result · ${this.context} context lines`});
		this.contentEl.createEl("p", {text: "Exports the current review snapshot to the vault root."});
		new Setting(this.contentEl).setName("Filename").addText(text => {
			this.filename = text;
			text.inputEl.addClass("diff-export-filename");
			text.setDisabled(true).onChange(() => { void this.validate(); });
		});
		this.status = this.contentEl.createDiv({cls: "diff-export-status", attr: {"aria-live": "polite"}});
		this.status.setText("Preparing export…");
		new Setting(this.contentEl).setName("Open after export")
			.setDesc("Open .md and .txt in a new tab; use the system application for other extensions.")
			.addToggle(toggle => toggle.setValue(this.openAfterExport).onChange(value => { this.openAfterExport = value; }));
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => {
				this.exportButton = button.setButtonText("Export").setCta().setDisabled(true).onClick(() => { void this.export(); });
			});
		const refresh = () => { if (!this.saving) void this.validate(); };
		this.lifetime.registerEvent(this.app.vault.on("create", refresh));
		this.lifetime.registerEvent(this.app.vault.on("delete", refresh));
		this.lifetime.registerEvent(this.app.vault.on("rename", refresh));
		void this.prepare();
	}

	private async prepare(): Promise<void> {
		try {
			const name = await availableFilename(formatExportFilename(this.template, this.date),
				path => this.app.vault.adapter.exists(path));
			if (this.closed) return;
			this.patch = createUnifiedExport(this.entries, this.context, this.date, this.unicodePaths);
			if (!this.patch) throw new Error("There are no changes to export.");
			this.filename.setValue(name).setDisabled(false);
			await this.validate();
			this.filename.inputEl.focus();
		} catch (error) { this.showError(error); }
	}

	private async validate(): Promise<boolean> {
		const version = ++this.checkVersion;
		this.exportButton.setDisabled(true);
		try {
			const result = await inspectDestination(this.app, this.filename.getValue());
			if (this.closed || version !== this.checkVersion) return false;
			this.status.toggleClass("is-error", !!result.error || result.exists);
			this.status.toggleClass("is-available", !result.error && !result.exists);
			this.status.setText(result.error ?? (result.exists
				? "File exists and will be overwritten!"
				: "Filename is available. A new file will be created."));
			this.exportButton.setDisabled(!!result.error || !this.patch || this.saving);
			return !result.error;
		} catch (error) {
			if (version === this.checkVersion) this.showError(error);
			return false;
		}
	}

	private async export(): Promise<void> {
		if (this.saving || !this.patch || !await this.validate() || this.saving || this.closed) return;
		this.saving = true;
		this.exportButton.setDisabled(true);
		this.filename.setDisabled(true);
		const name = this.filename.getValue();
		try {
			const file = await saveExport(this.app, name, this.patch);
			new Notice(`Diff exported to ${file.path}`);
			this.close();
			if (this.openAfterExport) {
				try { await openExport(this.app, file); }
				catch { new Notice(`Export saved to ${file.path}, but it could not be opened.`); }
			}
		} catch (error) {
			this.saving = false;
			this.filename.setDisabled(false);
			this.exportButton.setDisabled(false);
			this.showError(error);
		}
	}

	private showError(error: unknown): void {
		if (this.closed) return;
		this.status.removeClass("is-available");
		this.status.addClass("is-error");
		this.status.setText(error instanceof Error ? error.message : "Could not export the diff.");
	}

	onClose(): void {
		this.closed = true;
		this.checkVersion++;
		this.lifetime.unload();
		this.contentEl.empty();
	}
}
