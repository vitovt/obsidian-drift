import {Component, setIcon, setTooltip} from "obsidian";
import {redo, redoDepth, undo, undoDepth} from "@codemirror/commands";
import type {EditorView} from "@codemirror/view";

/** Labels and draft actions, kept outside the scrolling editor content. */
export class ReviewControls extends Component {
	private undoButton: HTMLButtonElement;
	private redoButton: HTMLButtonElement;
	private status: HTMLElement;
	private latestButton: HTMLButtonElement;
	private missingLabel: HTMLElement;
	private recreateLabel: HTMLElement;
	private recreateCheckbox: HTMLInputElement;

	constructor(container: HTMLElement, private getEditor: () => EditorView | undefined,
		reviewLatest: () => Promise<void>, recreate: (value: boolean) => void) {
		super();
		const labels = container.createDiv({cls: "diff-view-review-labels"});
		const original = labels.createDiv({cls: "diff-view-original-label"});
		original.createSpan({text: "Original"});
		this.missingLabel = original.createSpan({text: "— file missing", cls: "diff-view-file-missing"});
		setTooltip(this.missingLabel, "The file may have been deleted, moved, or renamed.");
		const result = labels.createDiv({cls: "diff-view-result-label"});
		result.createSpan({text: "Result (Editable)"});
		this.recreateLabel = result.createEl("label", {cls: "diff-view-recreate"});
		this.recreateCheckbox = this.recreateLabel.createEl("input", {type: "checkbox"});
		this.recreateLabel.createSpan({text: "Recreate missing file"});
		setTooltip(this.recreateLabel, "Accept recreates the result; Reject recreates the original, at the old path.");
		this.registerDomEvent(this.recreateCheckbox, "change", () => recreate(this.recreateCheckbox.checked));
		const actions = result.createDiv({cls: "diff-view-history-actions"});
		this.undoButton = actions.createEl("button", {cls: "clickable-icon", attr: {"aria-label": "Undo"}});
		this.redoButton = actions.createEl("button", {cls: "clickable-icon", attr: {"aria-label": "Redo"}});
		setIcon(this.undoButton, "undo-2");
		setIcon(this.redoButton, "redo-2");
		setTooltip(this.undoButton, "Undo");
		setTooltip(this.redoButton, "Redo");
		for (const [button, command] of [[this.undoButton, undo], [this.redoButton, redo]] as const) {
			this.registerDomEvent(button, "click", () => {
				const editor = this.getEditor();
				if (!editor) return;
				command(editor);
				editor.focus();
			});
		}
		const statusRow = container.createDiv({cls: "diff-view-review-status"});
		this.status = statusRow.createSpan({attr: {"aria-live": "polite"}});
		this.latestButton = statusRow.createEl("button", {text: "Review latest changes"});
		this.registerDomEvent(this.latestButton, "click", () => { void reviewLatest(); });
	}

	update(conflicted: boolean, missing = false, recreate = false): void {
		this.missingLabel.toggle(missing);
		this.recreateLabel.toggle(missing);
		this.recreateCheckbox.checked = recreate;
		const editor = this.getEditor();
		this.undoButton.disabled = !editor || undoDepth(editor.state) === 0;
		this.redoButton.disabled = !editor || redoDepth(editor.state) === 0;
		this.latestButton.toggle(conflicted && !missing);
		this.status.setText(missing
			? "File missing. Enable recreation to save at the original path."
			: conflicted
			? "File changed again. Review the latest version before applying your draft."
			: "Draft only. Select Accept to save the result.");
	}
}
