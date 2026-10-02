import {App, PluginSettingTab, Setting} from "obsidian";
import type ExternalDiffPlugin from "./main";
import {DEFAULT_EXPORT_TEMPLATE} from "./export/filename";
import {addExportSettings} from "./export/settings";

export interface ExternalDiffSettings {
	enabled: boolean;
	trackInAppChanges: boolean;
	trackApiChanges: boolean;
	reviewWhileClosed: boolean;
	reviewNewFiles: boolean;
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
	reviewWhileClosed: true,
	reviewNewFiles: false,
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

		const section = (name: string, description?: string): HTMLElement => {
			const group = containerEl.createDiv({cls: "drift-settings-section"});
			const heading = new Setting(group).setName(name).setHeading();
			if (description) heading.setDesc(description);
			return group;
		};
		const sources = section("Change sources", "External editors, scripts, and sync tools that write directly to Markdown files are monitored when detection is enabled. The options below control additional sources and checks at startup.");

		new Setting(sources)
			.setName("Enable change detection")
			.setDesc("Detect changes to Markdown files using the sources selected below. Existing reviews remain available when disabled.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
				}));

		for (const [key, name, description] of [
			["trackInAppChanges", "Review editor changes", "Include typing, pasting, and changes made by plugins through the editor, such as automatic link-title formatting. Drift cannot reliably separate your edits from plugin edits in the editor. Off by default."],
			["trackApiChanges", "Review file API operations", "Include content changes and file operations made through Obsidian's file APIs by plugins, integrations, or Obsidian itself. Plugins that edit through the editor follow Review editor changes instead. New files, renames, and deletions also follow the options below. The source cannot always be identified."],
			["reviewWhileClosed", "Review changes made while closed", "Save local Markdown content checkpoints in plugin data and compare them on startup. The first run establishes a baseline. Changes found at startup cannot be attributed to an editor or plugin. Disable to remove checkpoints on the next save."],
		] as const) {
			new Setting(sources).setName(name).setDesc(description)
				.addToggle(toggle => toggle.setValue(this.plugin.settings[key]).onChange(async value => {
					this.plugin.settings[key] = value;
					await this.plugin.saveSettings();
				}));
		}

		const files = section("New files, renames, and deletions");
		new Setting(files)
			.setName("Review newly created files")
			.setDesc("Show a review when a new Markdown file appears. When off, new files establish a baseline and remain available for rename matching; later edits are still reviewed. This is separate from the empty-file option below.")
			.addToggle(toggle => toggle.setValue(this.plugin.settings.reviewNewFiles).onChange(async value => {
				this.plugin.settings.reviewNewFiles = value;
				await this.plugin.saveSettings();
			}));

		new Setting(files)
			.setName("Ignore changes to empty files")
			.setDesc("Treat the first content added to an empty file as its starting version. Useful for apps that create an empty file before writing it; later edits are still reviewed.")
			.addToggle(toggle => toggle.setValue(this.plugin.settings.ignoreEmptyFileChanges)
				.onChange(async value => {
					this.plugin.settings.ignoreEmptyFileChanges = value;
					await this.plugin.saveSettings();
				}));

		new Setting(files)
			.setName("Track renames and deletions (experimental)")
			.setDesc("Review missing files and suggest possible renames. Existing reviews and drafts remain available when disabled.")
			.addToggle(toggle => toggle.setValue(this.plugin.settings.trackFileRenames).onChange(async value => {
				this.plugin.settings.trackFileRenames = this.plugin.settings.trackFileDeletions = value;
				await this.plugin.saveSettings();
			}));

		const display = section("Review display");
		new Setting(display)
			.setName("Focus diff tab on external change")
			.setDesc("Switch to the diff tab whenever an external change is detected")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.focusDiffOnChange)
				.onChange(async (value) => {
					this.plugin.settings.focusDiffOnChange = value;
					await this.plugin.saveSettings();
				}));

		new Setting(display)
			.setName("Word wrap")
			.setDesc("Wrap long lines in both sides of the diff view")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.wordWrap)
				.onChange(async (value) => {
					this.plugin.settings.wordWrap = value;
					await this.plugin.saveSettings();
				}));

		new Setting(display)
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
			new Setting(display)
				.setName("High-contrast word highlighting")
				.setDesc("Add a red or green background to changed text when word-level highlighting is enabled")
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.contrastChangedText)
					.onChange(async (value) => {
						this.plugin.settings.contrastChangedText = value;
						await this.plugin.saveSettings();
					}));
		}
		addExportSettings(section("Diff export"), this.plugin);
	}
}
