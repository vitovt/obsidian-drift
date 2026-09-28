import {App, FileSystemAdapter, TFile} from "obsidian";
import {shell} from "electron";
import {filenameError} from "./filename";
import {EXPORT_TEXT_VIEW} from "./ExportTextView";

export interface Destination {
	exists: boolean;
	error: string | null;
}

export async function inspectDestination(app: App, name: string): Promise<Destination> {
	const error = filenameError(name);
	if (error) return {exists: false, error};
	const stat = await app.vault.adapter.stat(name);
	return {exists: stat?.type === "file", error: stat?.type === "folder" ? "A folder has this name. Choose a filename." : null};
}

/** Overwriting is authorized in the dialog by its inline warning, not a popup. */
export async function saveExport(app: App, name: string, text: string): Promise<TFile> {
	const destination = await inspectDestination(app, name);
	if (destination.error) throw new Error(destination.error);
	const existing = app.vault.getAbstractFileByPath(name);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, text);
		return existing;
	}
	return app.vault.create(name, text);
}

export async function openExport(app: App, file: TFile): Promise<void> {
	const extension = file.extension.toLowerCase();
	if (extension === "md") {
		await app.workspace.getLeaf("tab").openFile(file);
	} else if (extension === "txt") {
		await app.workspace.getLeaf("tab").setViewState({type: EXPORT_TEXT_VIEW, state: {file: file.path}, active: true});
	} else {
		if (!(app.vault.adapter instanceof FileSystemAdapter)) throw new Error("System opening is only available for a local vault.");
		const error = await shell.openPath(app.vault.adapter.getFullPath(file.path));
		if (error) throw new Error(error);
	}
}
