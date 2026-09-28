import {Component, setIcon, setTooltip} from "obsidian";

export class DiffToolbar extends Component {
	private exportButton: HTMLButtonElement;
	constructor(container: HTMLElement, multiple: boolean, expand: (value: boolean) => void,
		accept: () => void, reject: () => void, exportDiff: () => void) {
		super();
		const toolbar = container.createDiv({cls: "diff-view-toolbar"});
		const navigation = toolbar.createDiv({cls: "diff-view-toolbar-navigation"});
		for (const [icon, label, expanded] of [
			["unfold-vertical", "Expand all files", true],
			["fold-vertical", "Collapse all files", false],
		] as const) {
			const button = navigation.createEl("button", {cls: "clickable-icon", attr: {"aria-label": label}});
			setIcon(button, icon);
			setTooltip(button, label);
			this.registerDomEvent(button, "click", () => expand(expanded));
		}
		const actions = toolbar.createDiv({cls: "diff-view-toolbar-actions"});
		if (multiple) {
			const acceptButton = actions.createEl("button", {cls: "diff-view-btn diff-view-btn-accept", text: "Accept all"});
			const rejectButton = actions.createEl("button", {cls: "diff-view-btn diff-view-btn-reject", text: "Reject all"});
			this.registerDomEvent(acceptButton, "click", accept);
			this.registerDomEvent(rejectButton, "click", reject);
		}
		this.exportButton = actions.createEl("button", {cls: "diff-view-btn", text: "Export diff"});
		this.registerDomEvent(this.exportButton, "click", exportDiff);
	}
	setExportEnabled(enabled: boolean): void { this.exportButton.disabled = !enabled; }
}
