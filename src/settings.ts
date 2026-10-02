import {App, PluginSettingTab, Setting} from "obsidian";
import type ExternalDiffPlugin from "./main";
import {DEFAULT_EXPORT_TEMPLATE} from "./export/filename";
import {addExportSettings} from "./export/settings";

export interface ExternalDiffSettings {
	enabled: boolean;
	trackInAppChanges: boolean;
	trackApiChanges: boolean;
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
	trackApiChanges: true,
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
			["trackInAppChanges", "Review my typing", "Include edits made in the Obsidian editor. Your typing is ignored by default."],
			["trackApiChanges", "Review plugin and file operations", "Include writes through Obsidian APIs, including connected AI tools, plugins, and in-app file operations. Their individual origins cannot always be distinguished."],
		] as const) {
			new Setting(containerEl).setName(name).setDesc(description)
				.addToggle(toggle => toggle.setValue(this.plugin.settings[key]).onChange(async value => {
					this.plugin.settings[key] = value;
					await this.plugin.saveSettings();
				}));
		}

		new Setting(containerEl)
			.setName("Track renames and deletions (experimental)")
			.setDesc("Review missing files and suggest possible renames. Existing reviews and drafts remain available when disabled.")
			.addToggle(toggle => toggle.setValue(this.plugin.settings.trackFileRenames).onChange(async value => {
				this.plugin.settings.trackFileRenames = this.plugin.settings.trackFileDeletions = value;
				await this.plugin.saveSettings();
			}));

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
