import {Notice, setIcon, setTooltip} from "obsidian";

function directory(path: string): string {
	return path.slice(0, path.lastIndexOf("/") + 1);
}

/** Emphasize the filename; omit a destination folder already shown on the left. */
export function renderFilename(container: HTMLElement, path: string, from?: string): void {
	const folder = directory(path);
	const text = container.createSpan({cls: "diff-rename-filename"});
	text.title = path;
	if (from === undefined || directory(from) !== folder) text.appendText(folder);
	text.createEl("strong", {text: path.slice(folder.length)});
}

/** Compact direction labels with full paths available for copying. */
export function renamePath(container: HTMLElement, label: string, path: string, copy = false, from?: string): void {
	const item = container.createSpan({cls: "diff-rename-path"});
	item.createSpan({text: `${label}: `});
	renderFilename(item, path, from);
	if (!copy) return;
	const button = item.createEl("button", {cls: "clickable-icon", attr: {"aria-label": `Copy ${label.toLowerCase()} path`}});
	setIcon(button, "copy");
	setTooltip(button, `Copy path: ${path}`);
	button.addEventListener("click", () => {
		void navigator.clipboard.writeText(path).then(() => new Notice("Path copied"), () => new Notice("Could not copy path."));
	});
}

export function renamePaths(container: HTMLElement, from: string, to: string, copy = false): void {
	const row = container.createDiv({cls: "diff-rename-paths"});
	renamePath(row, "From", from, copy);
	row.createSpan({text: "→", attr: {"aria-hidden": "true"}});
	renamePath(row, "To", to, copy, from);
}
