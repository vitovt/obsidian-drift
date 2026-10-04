import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import type ExternalDiffPlugin from "./main";
import {DEFAULT_EXPORT_TEMPLATE} from "./export/filename";
import {addExportSettings} from "./export/settings";

export const DEFAULT_MANUAL_EDITOR_EVENTS = "input.type\ninput.paste\ndelete\nundo\nredo";

export function manualEditorEvents(value: string): string[] {
	return [...new Set(value.split(/\r?\n/).map(event => event.trim()).filter(Boolean))];
}

export interface ExternalDiffSettings {
	debug: boolean;
	enabled: boolean;
	trackInAppChanges: boolean;
	trackApiChanges: boolean;
	trackApiContentChanges: boolean;
	trackApiRenames: boolean;
	trackApiDeletions: boolean;
	trackProgrammaticChanges: boolean;
	manualEditorEvents: string;
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
	debug: false,
	enabled: true,
	trackInAppChanges: false,
	trackApiChanges: true,
	trackApiContentChanges: true,
	trackApiRenames: false,
	trackApiDeletions: false,
	trackProgrammaticChanges: false,
	manualEditorEvents: DEFAULT_MANUAL_EDITOR_EVENTS,
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
		const sources = section("Change sources");

		new Setting(sources)
			.setName("Enable change detection")
			.setDesc("Detect changes to Markdown files using the sources selected below. Existing reviews remain available when disabled.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(sources)
			.setName("Changes outside Obsidian — always included")
			.setDesc("Drift's main purpose: review Markdown file changes made by external editors, AI agents, scripts, and sync tools such as Dropbox. Always monitored while change detection is enabled. This fixed indicator cannot be switched off separately. New files, renames, and deletions follow the file options below.")
			.addToggle(toggle => toggle.setValue(true).setDisabled(true));

		for (const [key, name, description] of [
			["trackInAppChanges", "Review other editor changes (probably not needed)", "Include typing, pasting, and editor changes not recognized as Editor API calls, including events listed as manual below. Plugins that modify CodeMirror directly also fall into this group. Leave off to ignore these changes."],
			["trackProgrammaticChanges", "Review Editor API changes (experimental)", "Include programmatic edits through Editor API methods, such as automatic link-title formatting. Plugins and Obsidian itself can use these methods; this does not identify the author. Direct CodeMirror changes and calls before an editor is attached may not be recognized. Off by default."],
			["trackApiChanges", "Review file API operations", "Enable the file API review types below. These APIs are used by plugins, integrations, and Obsidian itself; they do not identify who made the change. Turning this off preserves your child settings. Editor API changes have their own setting."],
			["reviewWhileClosed", "Review changes made while closed", "Save local Markdown content checkpoints in plugin data and compare them on startup. The first run establishes a baseline. Changes found at startup cannot be attributed to an editor or plugin. Disable to remove checkpoints on the next save."],
		] as const) {
			let eventsBlock: HTMLElement | undefined;
			new Setting(sources).setName(name).setDesc(description)
				.addToggle(toggle => toggle.setValue(this.plugin.settings[key]).onChange(async value => {
					this.plugin.settings[key] = value;
					if (eventsBlock) eventsBlock.style.display = value ? "" : "none";
					await this.plugin.saveSettings();
				}));
			if (key === "trackApiChanges") {
				eventsBlock = sources.createDiv({cls: "drift-settings-children drift-settings-api-operations"});
				eventsBlock.style.display = this.plugin.settings.trackApiChanges ? "" : "none";
				for (const [child, title, desc] of [
					["trackApiContentChanges", "Review file content changes", "Review text written through file APIs, for example by formatters, metadata tools, or integrations, including writes initiated through Obsidian's interface. Editor typing and Editor API calls follow their separate settings. Initial content in newly created files also requires Review newly created files."],
					["trackApiRenames", "Review file renames and moves", "Review renames and folder moves through file APIs, whether triggered by plugins or manually through Obsidian's interface. Requires Track renames and deletions. Leave off to reorganize files in Obsidian without creating rename reviews; existing reviews still follow their files."],
					["trackApiDeletions", "Review file deletions", "Review deletions through file APIs, including cleanup plugins and files or folders you delete manually in Obsidian's interface. Requires Track renames and deletions. Leave off to avoid new deletion reviews for these operations; existing drafts remain protected."],
				] as const) {
					new Setting(eventsBlock).setName(title).setDesc(desc)
						.addToggle(toggle => toggle.setValue(this.plugin.settings[child]).onChange(async value => {
							this.plugin.settings[child] = value;
							await this.plugin.saveSettings();
						}));
				}
			}
			if (key === "trackProgrammaticChanges") {
				eventsBlock = sources.createDiv({cls: "drift-settings-children drift-settings-editor-events"});
				eventsBlock.style.display = this.plugin.settings.trackProgrammaticChanges ? "" : "none";
				let resetText = () => {};
				new Setting(eventsBlock)
					.setName("Treat these events as manual edits")
					.setDesc("One event per line, as shown in the debug log's userEvents field. Matching events follow Review other editor changes, even inside an Editor API call; leave that option off to ignore them. A name also matches its dot-separated subtypes: delete includes delete.backward. Case-sensitive, no wildcards. Empty means no exceptions. This filters event types, not individual plugins; events without a marker do not match.")
					.addTextArea(text => {
						text.setValue(this.plugin.settings.manualEditorEvents);
						text.inputEl.rows = 6;
						text.inputEl.cols = 25;
						text.inputEl.spellcheck = false;
						text.inputEl.setAttribute("aria-label", "Events treated as manual edits");
						resetText = () => { text.setValue(DEFAULT_MANUAL_EDITOR_EVENTS); };
						text.onChange(async value => {
							this.plugin.settings.manualEditorEvents = value;
							await this.plugin.saveSettings();
						});
					})
					.addButton(button => button.setButtonText("Restore defaults").onClick(async () => {
						this.plugin.settings.manualEditorEvents = DEFAULT_MANUAL_EDITOR_EVENTS;
						resetText();
						await this.plugin.saveSettings();
					}));
			}
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

		let highlightingOptions: HTMLElement;
		new Setting(display)
			.setName("Word-level highlighting")
			.setDesc("Highlight changed words within line-based change blocks; unchanged regions collapse when toggled.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.wordLevelHighlighting)
				.onChange(async (value) => {
					this.plugin.settings.wordLevelHighlighting = value;
					highlightingOptions.style.display = value ? "" : "none";
					await this.plugin.saveSettings();
				}));

		highlightingOptions = display.createDiv({cls: "drift-settings-children"});
		highlightingOptions.style.display = this.plugin.settings.wordLevelHighlighting ? "" : "none";
		new Setting(highlightingOptions)
			.setName("High-contrast word highlighting")
			.setDesc("Add a red or green background to changed text when word-level highlighting is enabled")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.contrastChangedText)
				.onChange(async (value) => {
					this.plugin.settings.contrastChangedText = value;
					await this.plugin.saveSettings();
				}));
		addExportSettings(section("Diff export"), this.plugin);
		const diagnostics = section("Diagnostics");
		new Setting(diagnostics)
			.setName("Debug logging")
			.setDesc("Write a temporary events.jsonl file in the system temp directory. Includes Editor API call stacks, input event types, file paths, active settings, and review decisions, but no note text, typed characters, or clipboard contents. Each enable starts a new log. Disable after reproducing the issue; existing logs remain until you or the system removes them.")
			.addToggle(toggle => toggle.setValue(this.plugin.settings.debug).onChange(async value => {
				if (!value) this.plugin.debugLog.write("debug.disabling");
				if (value) await this.plugin.debugLog.start();
				this.plugin.settings.debug = value;
				if (value) this.plugin.startDebugMonitoring();
				this.plugin.debugLog.write("debug.enabled");
				if (!value) await this.plugin.debugLog.stop();
				await this.plugin.saveSettings();
			}));
		const debugOptions = diagnostics.createDiv({cls: "drift-settings-children"});
		new Setting(debugOptions)
			.setName("Debug log location")
			.setDesc("Copy the full path to the current session's log, including after debug logging is turned off.")
			.addButton(button => button.setButtonText("Copy log path").onClick(async () => {
				try {
					const path = await this.plugin.debugLog.location();
					if (!path) { new Notice("Enable debug logging first."); return; }
					await navigator.clipboard.writeText(path);
					new Notice(`Debug log path copied: ${path}`, 10000);
				} catch { new Notice("Could not copy the log path. Check that the temp directory is writable."); }
			}));
	}
}
