import {App, Modal, Setting} from "obsidian";

export class ConfirmActionModal extends Modal {
	constructor(app: App, private title: string, private message: string, private action: string, private confirm: () => void) { super(app); }
	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", {text: this.message});
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText(this.action).setWarning().onClick(() => { this.close(); this.confirm(); }));
	}
	onClose(): void { this.contentEl.empty(); }
}
