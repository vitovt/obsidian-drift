import {Setting} from "obsidian";
import type ExternalDiffPlugin from "../main";
import {formatExportFilename} from "./filename";
import {validContextLines} from "./unifiedDiff";

export function addExportSettings(container: HTMLElement, plugin: ExternalDiffPlugin): void {
	// eslint-disable-next-line obsidianmd/ui/sentence-case -- Unicode is a proper name.
	new Setting(container).setName("Readable Unicode paths")
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Unicode is a proper name.
		.setDesc("Keep Unicode characters and emoji readable in exported patch paths. Turn off to use octal byte escapes.")
		.addToggle(toggle => toggle.setValue(plugin.settings.exportUnicodePaths).onChange(async value => {
			plugin.settings.exportUnicodePaths = value;
			await plugin.saveSettings();
		}));
	const filename = new Setting(container).setName("Export filename template")
		// Date format tokens are intentionally case-sensitive.
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		.setDesc("Vault root only. Date tokens: %Y %m %d %H %M %S; %% for a percent sign.");
	const preview = filename.descEl.createDiv({cls: "diff-export-status"});
	filename.addText(text => {
		text.setValue(plugin.settings.exportFilenameTemplate).onChange(async value => {
			try {
				preview.setText(`Example: ${formatExportFilename(value)}`);
				preview.removeClass("is-error");
			} catch (error) {
				preview.setText(error instanceof Error ? error.message : "Invalid template.");
				preview.addClass("is-error");
				return;
			}
			plugin.settings.exportFilenameTemplate = value;
			await plugin.saveSettings();
		});
	});
	const context = new Setting(container).setName("Export context lines")
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Literal CLI option.
		.setDesc("Unchanged lines around each change (default: 3); zero requires git apply --unidiff-zero.");
	const error = context.descEl.createDiv({cls: "diff-export-status is-error"});
	context.addText(text => text.setValue(String(plugin.settings.exportContextLines)).onChange(async value => {
		const count = Number(value);
		if (!/^\d+$/.test(value) || !validContextLines(count)) {
			error.setText("Enter a non-negative whole number.");
			return;
		}
		error.setText("");
		plugin.settings.exportContextLines = count;
		await plugin.saveSettings();
	}));
}
