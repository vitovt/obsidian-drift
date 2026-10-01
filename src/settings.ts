import {App, PluginSettingTab, Setting} from "obsidian";
import type ExternalDiffPlugin from "./main";
import {DEFAULT_EXPORT_TEMPLATE} from "./export/filename";
import {addExportSettings} from "./export/settings";

export interface ExternalDiffSettings {
	enabled: boolean;
	trackInAppChanges: boolean;
	trackFileRenames: boolean;
	trackFileDeletions: boolean;
	ignoreEmptyFileChanges: boolean;
	focusDiffOnChange: boolean;
	wordWrap: boolean;
	wordLevelHighlighting: boolean;
	contrastChangedText: boolean;
	exportFilenameTemplate: string;
	exportContextLines: number;
	exportUnicodePaths: boolean;
}

export const DEFAULT_SETTINGS: ExternalDiffSettings = {
	enabled: true,
	trackInAppChanges: false,
	trackFileRenames: false,
	trackFileDeletions: false,
	ignoreEmptyFileChanges: false,
	focusDiffOnChange: false,
	wordWrap: false,
	wordLevelHighlighting: false,
	contrastChangedText: false,
	exportFilenameTemplate: DEFAULT_EXPORT_TEMPLATE,
	exportContextLines: 3,
	exportUnicodePaths: true,
};

export class ExternalDiffSettingTab extends PluginSettingTab {
	plugin: ExternalDiffPlugin;

	constructor(app: App, plugin: ExternalDiffPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Enable external change detection")
			.setDesc("Automatically detect when external tools modify Markdown files")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
				}));

		for (const [key, name, description] of [
			["trackInAppChanges", "Track in-app changes", "Include edits, renames, and deletions made through Obsidian and plugin file APIs. Existing reviews always follow confirmed moves."],
			["trackFileRenames", "Track file renames (experimental)", "Follow confirmed Obsidian rename events. Delete and create events are never matched. Folder renames update existing reviews only."],
			["trackFileDeletions", "Track file deletions (experimental)", "Review deletions while Drift is running, including deletions in Obsidian. Restore files from their last known versions."],
		] as const) {
			new Setting(containerEl).setName(name).setDesc(description)
				.addToggle(toggle => toggle.setValue(this.plugin.settings[key]).onChange(async value => {
					this.plugin.settings[key] = value;
					await this.plugin.saveSettings();
				}));
		}

		new Setting(containerEl)
			.setName("Ignore changes to empty files")
			.setDesc("Treat the first content added to an empty file as its starting version. Useful for apps that create an empty file before writing it; later edits are still reviewed.")
			.addToggle(toggle => toggle.setValue(this.plugin.settings.ignoreEmptyFileChanges)
				.onChange(async value => {
					this.plugin.settings.ignoreEmptyFileChanges = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Focus diff tab on external change")
			.setDesc("Switch to the diff tab whenever an external change is detected")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.focusDiffOnChange)
				.onChange(async (value) => {
					this.plugin.settings.focusDiffOnChange = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Word wrap")
			.setDesc("Wrap long lines in both sides of the diff view")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.wordWrap)
				.onChange(async (value) => {
					this.plugin.settings.wordWrap = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Word-level highlighting")
			.setDesc("Highlight changed words within line-based change blocks; unchanged regions collapse when toggled.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.wordLevelHighlighting)
				.onChange(async (value) => {
					this.plugin.settings.wordLevelHighlighting = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.wordLevelHighlighting) {
			new Setting(containerEl)
				.setName("High-contrast word highlighting")
				.setDesc("Add a red or green background to changed text when word-level highlighting is enabled")
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.contrastChangedText)
					.onChange(async (value) => {
						this.plugin.settings.contrastChangedText = value;
						await this.plugin.saveSettings();
					}));
		}
		addExportSettings(containerEl, this.plugin);
	}
}
