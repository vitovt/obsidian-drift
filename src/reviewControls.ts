import {Component, setIcon, setTooltip} from "obsidian";
import {redo, redoDepth, undo, undoDepth} from "@codemirror/commands";
import type {EditorView} from "@codemirror/view";

/** Labels and draft actions, kept outside the scrolling editor content. */
export class ReviewControls extends Component {
	private original: HTMLElement;
	private resultLabel: HTMLElement;
	private undoButton: HTMLButtonElement;
	private redoButton: HTMLButtonElement;
	private status: HTMLElement;
	private statusRow: HTMLElement;
	private latestButton: HTMLButtonElement;
	private missingLabel: HTMLElement;

	constructor(container: HTMLElement, private getEditor: () => EditorView | undefined,
		reviewLatest: () => Promise<void>) {
		super();
		const labels = container.createDiv({cls: "diff-view-review-labels"});
		const original = labels.createDiv({cls: "diff-view-original-label"});
		this.original = original;
		original.createSpan({text: "Original"});
		this.missingLabel = original.createSpan({text: "— file missing", cls: "diff-view-file-missing"});
		setTooltip(this.missingLabel, "The file may have been deleted, moved, or renamed.");
		const result = labels.createDiv({cls: "diff-view-result-label"});
		this.resultLabel = result.createSpan({text: "Result (Editable)"});

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
		this.statusRow = container.createDiv({cls: "diff-view-review-status"});
		this.status = this.statusRow.createSpan({attr: {"aria-live": "polite"}});
		this.latestButton = this.statusRow.createEl("button", {text: "Review latest changes"});
		this.registerDomEvent(this.latestButton, "click", () => { void reviewLatest(); });
	}

	setRename(path: string): void {
		const icon = this.original.createSpan({cls: "diff-view-rename-icon"});
		setIcon(icon, "arrow-right-left");
		const label = this.original.createSpan({text: `Renamed from: ${path}`, cls: "diff-view-renamed"});
		setTooltip(label, path);

	}

	update(conflicted: boolean, missing = false, deleted = false): void {
		this.missingLabel.toggle(missing);
		this.missingLabel.setText(deleted ? "— file deleted" : "— file missing");
		this.resultLabel.setText(deleted && !this.getEditor()?.state.doc.length ? "File deleted" : "Result (Editable)");
		const editor = this.getEditor();
		this.undoButton.disabled = !editor || undoDepth(editor.state) === 0;
		this.redoButton.disabled = !editor || redoDepth(editor.state) === 0;
		this.latestButton.toggle(conflicted && !missing);
		this.statusRow.toggle(missing || conflicted);
		this.status.setText(missing
			? deleted ? "Keep the deletion or explicitly restore a saved version." : "File missing. Restore the result, restore the original, or discard this review."
			: conflicted
			? "File changed again. Review the latest version before applying your draft."
			: "");
	}
}
