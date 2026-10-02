import {Component, setIcon, setTooltip} from "obsidian";

export class DiffToolbar extends Component {
	private keepButton?: HTMLButtonElement;
	private restoreButton?: HTMLButtonElement;
	private counts: HTMLElement;
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
			const rejectButton = actions.createEl("button", {cls: "diff-view-btn diff-view-btn-reject", text: "Restore originals…"});
			const acceptButton = actions.createEl("button", {cls: "diff-view-btn diff-view-btn-accept", text: "Keep all current"});
			this.keepButton = acceptButton; this.restoreButton = rejectButton;
			setTooltip(rejectButton, "Restore original contents and paths, recover deleted files, and move new files to trash. Review the counts before confirming. Unresolved reviews are skipped.");
			setTooltip(acceptButton, "Acknowledge current contents, renames, and deletions without writing files. Drafts, missing files, conflicts, and unresolved rename candidates remain open.");
			this.registerDomEvent(acceptButton, "click", accept);
			this.registerDomEvent(rejectButton, "click", reject);
		}
		this.counts = toolbar.createDiv({cls: "diff-view-bulk-counts", attr: {"aria-live": "polite"}});
		this.exportButton = actions.createEl("button", {cls: "diff-view-btn", text: "Export diff"});
		this.registerDomEvent(this.exportButton, "click", exportDiff);
	}
	setCounts(counts: {keep: number; restore: number; drafts: number; unresolved: number; unavailable: number}): void {
		if (this.keepButton) { this.keepButton.setText(`Keep all current (${counts.keep})`); this.keepButton.disabled = counts.keep === 0; }
		if (this.restoreButton) { this.restoreButton.setText(`Restore originals… (${counts.restore})`); this.restoreButton.disabled = counts.restore === 0; }
		this.counts.setText(`${counts.keep} ready · ${counts.drafts} drafts · ${counts.unresolved} awaiting rename decisions · ${counts.unavailable} unavailable`);
	}
	setExportEnabled(enabled: boolean): void { this.exportButton.disabled = !enabled; }
}
