# Drift

A VS Code-style side-by-side diff viewer that lives inside Obsidian. Automatically detects external file changes (including AI coding agents) and shows you a before/after view with per-chunk accept/reject, accept all/reject all, and collapsible unchanged regions.

![Drift demo](demo.gif)

## Features

- **Event-driven detection** — No polling. Uses CodeMirror 6 transaction monitoring to detect external changes the moment they happen.
- **Editable review drafts** — Restore individual blocks or edit the result manually, with Undo/Redo, before applying the result to the file.
- **Reject all changes / Accept all changes** — Bulk actions when you have multiple files with pending diffs.
- **Persistence** — Pending diffs and edited drafts survive Obsidian restarts. Drafts are preserved if the file changes again; obsolete unedited reviews are discarded on reload.
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

Run `npm run test:review` for draft persistence, history, and conflict checks without launching Obsidian. These tests mock vault operations; interactive scenarios live in `e2e/test/specs/`.

Run `npm run test:diff` for word-level highlighting regressions, including sparse edits across large documents and incremental draft changes.

Run `npm run test:export` for export tests. These require Git and GNU patch on your PATH: generated patches are applied to temporary files and their contents compared with the expected results. Vault writes and file-opening routes are tested with mocks.

## Usage

Once enabled, the plugin runs automatically. When an external tool modifies a markdown file in your vault:

1. A **Drift** tab opens in the background showing the side-by-side diff
2. Compare **Original** on the left with **Result (Editable)** on the right
3. Edit the result or select **Restore original block** (`→`) to copy a block from left to right. These actions change the draft only; the file stays untouched until **Save result**. Use **Undo** / **Redo**, or `Ctrl+Z` / `Ctrl+Shift+Z` (`Cmd` on macOS), to revise your decisions
4. Use the **Open diff viewer** command to reopen the tab if you close it
5. Select **Accept** to acknowledge the current file without writing. After editing the draft, this button becomes **Save result**. **Reject** restores the original. **Accept all changes** leaves edited drafts open for individual saving; **Reject all changes** restores original contents

Restoring every block keeps the review open so you can undo or explicitly accept it. Draft text is saved in the plugin's local data and restored after restarting Obsidian. Undo history survives collapsing/reopening views and changing the diff algorithm within the current plugin session; it resets on plugin reload or when starting a comparison against a newer disk version.

If the file changes again while you have an edited draft, Drift keeps the draft and shows **Review latest changes**. Selecting it puts the latest disk version on the left and your draft on the right without writing anything. Review the differences before accepting; **Reject** now keeps that latest comparison baseline. Both Accept and Reject check the disk version before writing, and failed or conflicting files remain open even during bulk actions.

The toolbar centers **Reject all changes** and **Accept all changes**, separate from the right-aligned per-file actions. Reject comes first in both places, matching Original on the left and Result on the right. Hover over bulk actions for their descriptions. The icons on the left expand or collapse all file sections; hover over them for labels. Collapsing a file keeps its editor and current edits intact.

Expanded comparisons are indented beneath their file headers. Long file paths wrap when expanded; hover over a path to read it in full, including when the section is collapsed.

If a reviewed file disappears from its original path, Drift displays **Original — file missing**. With experimental rename tracking disabled, it does not follow renamed files. Enable **Recreate missing file** in that review to let **Accept** create the Result or **Reject** create the Original at the old path. The checkbox is off by default and also controls whether bulk actions can recreate that file. Recreation requires the original parent folder to exist and never overwrites an occupied path. If the file reappears, the checkbox resets and normal content-conflict checks apply. Legacy missing-path reviews without tracked rename or deletion metadata are dropped on reload, including their drafts; copy useful draft text or export the diff first.

### Experimental renames and deletions

Both **Track file renames (experimental)** and **Track file deletions (experimental)** are off by default. They use Obsidian events and Drift's existing in-memory Markdown baselines: no additional vault scan or filesystem watcher. Changes that happen while Drift is not running are not discovered retrospectively. **Track in-app changes** is a separate option, off by default: recognized Obsidian edits, renames, and deletions do not create new reviews unless enabled. Existing reviews still follow recognized in-app moves. Origin detection uses editor transactions and Vault API operations; writes through other routes may still appear external.

Confirmed renames move an existing review to the new path, preserving Original, Result, and session Undo/Redo. **Renamed from** shows the initial path, even after several renames. For content reviews, Accept/Reject use the current path unless **Restore original path** is checked. Pure renames show **No content changes**, with **Keep rename** and **Restore original path** actions. Renaming back clears a pure rename review. Folder renames update existing reviews and baselines without creating a review for every child.

Renaming through Obsidian produces a confirmed rename event. Shell commands such as `mv`, and changes arriving through Dropbox, can produce separate deletion and creation events instead. With rename tracking enabled, Drift compares recently created files with pending missing-file reviews. It ranks exact and similar contents as **Possible rename** candidates. Select **Review candidates…**, preview a file, and **Confirm rename**, or choose **Keep separate**. **Select another file…** allows manual association. Even identical contents require confirmation: duplicate notes are not proof of a rename. Confirmation changes review metadata only and preserves edited drafts; a changed destination may require reviewing a content conflict. Rename tracking retains missing-file reviews even when deletion tracking is off. If the original path reappears with its original content and no edited draft, the obsolete review is removed. Changed content becomes a normal comparison; edited drafts remain available. After an external rename round trip, a deletion review for the temporary filename can still remain.

Matching uses word-sequence fingerprints, with up to eight suggestions scoring at least 80%. Scores measure textual overlap, not the probability of a rename. Empty files are never matched; very short files require exact contents. Automatic matching considers up to 128 pending missing files and 128 recently created paths, with a 30-minute creation window and a 2 Mi-character text budget per side. Each fingerprint is limited to 256 Ki characters and 60,000 tokens. Work is debounced and yields between batches. Large folder moves can exceed these limits; use manual selection for omitted files (preview limit: approximately 1 MB).

A deletion can match a creation delivered much later while its review remains pending. If creation arrives first and deletion arrives after the candidate window, select the file manually. Saved suggestions survive restart, but the unmatched creation cache does not. Dropbox must deliver the events while Drift is running; this is not retrospective sync-history recovery.

Unresolved suggestions and their candidate reviews are excluded from **Accept all changes**, **Reject all changes**, and export. A count explains omissions. Resolve the association or select **Keep separate** before applying those reviews individually. Disabling rename tracking does not silently resolve saved suggestions.

Tracked deletions are delayed briefly (500 ms) so temporary delete/create replacements can settle. A standalone deletion displays all original lines as removed, with **Keep deletion** and **Restore file**. If a file with a pending comparison is deleted, its Original and Result remain available: **Restore original**, **Keep deletion**, and **Save result** choose what happens next. Keeping a deletion with an edited draft asks before discarding the draft. A restored deletion recreates missing parent folders. Existing destinations are never overwritten by recreation.

**Accept all changes** keeps current contents, renames, and deletions without changing files unless a restoration checkbox was explicitly selected; edited drafts remain open. **Reject all changes** restores original contents and deleted files, and reverses pure renames. For renames with content changes it restores the path only when the checkbox is selected. Hover over the bulk buttons for these rules.

Tracked rename and deletion reviews survive plugin reloads and Obsidian restarts. Restoration checkboxes reset; Undo/Redo history remains session-only. A reappearing file is compared again before any write. Restoring a renamed path requires its parent folder to exist and its destination to be free. Case-only restoration can be blocked by a filesystem that treats both spellings as occupied. Drift uses Vault.rename and does not additionally rewrite links in other notes. Content writes and renames are separate operations: if a later operation fails, the review remains available with an error explaining that the file should be checked before retrying.

For a step-by-step test in a disposable vault, see [the lifecycle testing checklist](docs/lifecycle-testing.md).

Enable **Ignore changes to empty files** in plugin settings to treat the first content written to an empty file as its baseline. This is useful for external apps that create an empty file before filling it. The option is off by default, applies only to files with no existing pending review, and treats only zero-character content as empty (not whitespace). Subsequent edits are reviewed normally.

In **Settings → Drift**, enable **Focus diff tab on external change** to switch to the diff tab automatically whenever an external change is detected. This is off by default, so changes open in the background unless you opt in.

Enable **Word wrap** in the same settings to wrap long lines in both diff panes. It is off by default and applies immediately to open diff views without reloading the plugin.

When word wrap is off, horizontal scrolling in either pane automatically scrolls the other pane by the same offset. Each file comparison scrolls independently. If one pane has less content, it stops at its own edge without pulling the longer pane back.

A shared horizontal scrollbar stays at the bottom of each visible comparison, outside its vertically scrolling text, so long files can be scrolled horizontally without reaching their last line. It is hidden when word wrap is enabled or neither pane overflows.

Enable **Word-level highlighting** to highlight changed text within lines. Drift first matches unchanged lines with patience diff, then uses CodeMirror's character diff inside each changed block. This keeps distant edits separate in long documents instead of letting a coarse character-diff fallback highlight the whole section. It is off by default. Switching the option can change chunk boundaries; open comparisons rebuild immediately, keeping the draft, selection, and undo history while collapsing unchanged regions. Word wrap works with either mode.

With word-level highlighting enabled, turn on **High-contrast word highlighting** to add dark red backgrounds to deleted text and dark green backgrounds to inserted text, both with white lettering. This optional styling applies immediately without rebuilding editors and is off by default.

## Export a review

Select **Export diff** after the bulk review actions in the toolbar (also available for a single file). Drift exports all pending **Original → Result** comparisons, including collapsed files and regions, as one unified patch. The snapshot includes your draft edits at the moment the dialog opens; unchanged results are omitted unless they carry rename or deletion metadata. Exporting does not accept or reject the reviews.

The dialog shows an editable filename. A green message means the name is available; a red message means the existing file **will be overwritten** when you select **Export**. There is no additional overwrite popup. Drift suggests a free name with a suffix such as `-2`, which you can remove manually.

Exports are saved in the vault root. In **Settings → Drift**, configure:

- **Export filename template** — defaults to `drift-%Y-%m-%d_%H-%M.diff.txt`. Tokens `%Y`, `%m`, `%d`, `%H`, `%M`, and `%S` use local date/time; `%%` produces a literal percent sign. Folder paths are not allowed. Editing the name in the export dialog affects only that export.
- **Export context lines** — defaults to `3` (`diff -U3` style); accepts non-negative whole numbers.
- **Readable Unicode paths** — enabled by default. Keeps Ukrainian letters, emoji, and other Unicode characters readable in patch paths. Disable to use octal UTF-8 byte escapes. Paths containing spaces remain quoted; both modes work with Git and GNU patch.

**Open after export** is enabled initially. Markdown opens in a new Obsidian tab, `.txt` opens in a new read-only Drift text tab, and other extensions open through the system's associated application. If opening fails, the saved export remains in the vault.

The patch starts with metadata and a file list, followed by standard unified hunks using `a/` and `b/` paths relative to the vault root. It preserves CRLF and missing final newlines. It describes the pending text comparisons tracked by Drift, not a complete vault backup or a scan for added/deleted files.

Both the header's file list and the patch sections follow the viewer order captured when the export dialog opens. Unchanged content-only reviews are omitted without changing the order of the remaining files.

Tracked deletions export Original → `/dev/null`, even if a Result draft remains available for recovery. Rename sections use the **current path** and include uppercase warnings naming the original path: the patch does not perform the rename, so paths may need manual adjustment. Pure renames export metadata only, without invented hunks. A metadata-only export has no text patch to apply. Deleting an empty file uses Git's deleted-file metadata; use `git apply` for that case.

Apply it from the root of a vault containing the **Original** versions (the current externally modified files may already contain some or all of the changes):

```sh
git apply --check drift-2026-09-28_14-05.diff.txt
git apply drift-2026-09-28_14-05.diff.txt
# Alternatively:
patch -p1 < drift-2026-09-28_14-05.diff.txt
```

For zero-context exports, add `--unidiff-zero` to both Git commands.

To test in Obsidian, edit a Result draft, collapse another changed file, and export. Check that both appear in the patch. Export again, remove the suggested suffix, verify the red overwrite warning, and save. Check **Open after export** with `.txt`, `.md`, and an extension associated with an external application.

## Commands

| Command | Description |
|---------|-------------|
| **Open diff viewer** | Open or focus the diff viewer tab |
| **Toggle external change detection** | Enable/disable external change detection |
