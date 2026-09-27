# Drift

A VS Code-style side-by-side diff viewer that lives inside Obsidian. Automatically detects external file changes (including AI coding agents) and shows you a before/after view with per-chunk accept/reject, accept all/reject all, and collapsible unchanged regions.

![Drift demo](demo.gif)

## Features

- **Instant detection** — No polling or delays. Uses CodeMirror 6 transaction monitoring to detect external changes the moment they happen.
- **Per-chunk accept/reject** — Cherry-pick individual changes, not just all-or-nothing. Revert buttons on each diff chunk let you keep what you want and undo what you don't.
- **Accept all / Reject all** — Bulk actions when you have multiple files with pending diffs.
- **Persistence** — Pending diffs survive Obsidian restarts. Stale diffs (file deleted or reverted) are automatically discarded on reload.
- **Edit protection** — Editing a file with pending diffs shows a warning modal, preventing accidental data loss.
- **Tool-agnostic** — Works with any tool that modifies vault files: AI coding agents, sync services, scripts, other plugins.

## Installation

Install Drift from the [Obsidian community plugin directory](https://community.obsidian.md/plugins/drift).

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ryanbbrown/obsidian-drift/releases)
2. Create a folder `VaultFolder/.obsidian/plugins/drift/`
3. Copy the downloaded files into that folder
4. Restart Obsidian and enable the plugin in **Settings → Community plugins**

### Build and test locally

1. Run `npm ci` in the repository to install the locked dependencies.
2. Run `npm run build` to type-check and generate `main.js`.
3. Copy `main.js`, `manifest.json`, and `styles.css` into your test vault's `.obsidian/plugins/drift/` folder.
4. Disable and re-enable Drift in **Settings → Community plugins** to load the new build.

Repeat steps 2–4 after each change. `npm run dev` rebuilds automatically when source files change; you still need to copy the files and reload the plugin. Generated `main.js` is excluded from Git.

## Usage

Once enabled, the plugin runs automatically. When an external tool modifies a markdown file in your vault:

1. A **Drift** tab opens in the background showing the side-by-side diff
2. Use **Accept All** to keep the new content, or **Reject All** to revert to the original
3. Use the **revert button** on individual chunks to selectively undo specific changes
4. Use the **Open diff viewer** command to reopen the tab if you close it

The toolbar centers **Accept all** and **Reject all**, separate from the right-aligned per-file actions. The icons on the left expand or collapse all file sections; hover over them for labels. Collapsing a file keeps its editor and current edits intact.

In **Settings → Drift**, enable **Focus diff tab on external change** to switch to the diff tab automatically whenever an external change is detected. This is off by default, so changes open in the background unless you opt in.

Enable **Word wrap** in the same settings to wrap long lines in both diff panes. It is off by default and applies immediately to open diff views without reloading the plugin.

When word wrap is off, horizontal scrolling in either pane automatically scrolls the other pane by the same offset. Each file comparison scrolls independently. If one pane has less content, it stops at its own edge without pulling the longer pane back.

A shared horizontal scrollbar stays at the bottom of each visible comparison, outside its vertically scrolling text, so long files can be scrolled horizontally without reaching their last line. It is hidden when word wrap is enabled or neither pane overflows.

Enable **Word-level highlighting** to highlight changed text within lines using CodeMirror's built-in diff algorithm. It is off by default, preserving Drift's line-based patience diff. Switching algorithms can change chunk boundaries and the alignment of repeated lines or moved Markdown sections. Open comparisons rebuild immediately, keeping current text and partial reverts but resetting editor selection, undo history, and expanded unchanged regions. Word wrap works with either algorithm.

With word-level highlighting enabled, turn on **High-contrast word highlighting** to add dark red backgrounds to deleted text and dark green backgrounds to inserted text, both with white lettering. This optional styling applies immediately without rebuilding editors and is off by default.

## Commands

| Command | Description |
|---------|-------------|
| **Open diff viewer** | Open or focus the diff viewer tab |
| **Toggle external change detection** | Enable/disable external change detection |
