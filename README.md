# Drift

Review changes to Markdown notes in one place inside Obsidian. Drift compares the previous text with changes from external editors, AI agents, scripts, plugins, and synchronization tools, and lets you keep the current file, restore the original, or edit a result draft before saving.

![Drift demo](demo.gif)

## What gets reviewed

| Setting | Default | Behavior |
| --- | --- | --- |
| Enable external change detection | On | Review changes to known Markdown files. |
| Review newly created files | **Off** | New files establish a baseline and remain eligible for rename matching. Later edits are reviewed. Enable to review the initial creation too. |
| Ignore changes to empty files | Off | When enabled, the first content written to a zero-character file becomes its baseline. Whitespace is not empty. Existing reviews are preserved. This is independent of reviewing new files. |
| Review my typing | Off | Include edits made in the Obsidian editor. Ordinary typing and its autosaves are otherwise excluded. |
| Review plugin and file operations | On | Include writes through Obsidian APIs, including connected AI tools, plugins, and in-app file operations. |
| Review changes made while closed | On | Store local Markdown content checkpoints and compare them during the next startup. |
| Track renames and deletions (experimental) | Off | Review missing files and suggest possible renames. |

New-file events settle for 250 ms of inactivity (up to two seconds) so an empty creation event followed immediately by copied contents establishes one baseline. Edits after that settling period are reviewed.

For example, with the defaults, copying `notes.md` into the vault creates **no review**. Editing it afterward creates a content review. If the copied file is a possible destination for a missing note, it can still appear as a rename candidate. Enabling **Ignore changes to empty files** additionally skips the first fill of an empty file.

Origin detection uses editor transactions and file APIs. It cannot reliably identify every tool or distinguish an Obsidian file operation from a plugin using the same API. Unknown filesystem writes are treated as external. Disabling API review does not dismiss an existing external review: a later API write can instead mark it as needing a fresh comparison. An AI tool writing through an Obsidian API is covered by API review; one writing directly to disk is covered by external detection.

Plugins that change text through the editor, such as automatic link-title formatting, currently follow **Review my typing**. Drift recognizes recent editor versions when delayed autosaves arrive, so an earlier URL save does not become a reverse review after the editor has already formatted the link. This matching is bounded to 64 versions and 8 Mi characters across files, with a 10-second lifetime; it does not identify the plugin responsible.

The first run establishes the checkpoint; it cannot recover changes made before installation. With checkpoints enabled, subsequent startup compares the current vault against the last saved observations, including changes delivered by Dropbox while Obsidian was closed. It reuses the startup Markdown scan, with four concurrent reads. Read failures keep the previous checkpoint and saved drafts and show a retry notice. There is no additional filesystem watcher or continuous polling.

Checkpoint text and review drafts are stored in the plugin's `data.json` inside the vault configuration folder. No telemetry or network requests are made by Drift. If your sync tool includes that folder, it can sync this data too. Disabling **Review changes made while closed** removes checkpoints on the next save; pending reviews and drafts remain. Saves are serialized and scheduled within about 500 ms of changes; an abrupt process or storage failure can lose state not yet saved. Checkpoints are observations, not a version history or backup.

## Review actions

The left pane shows **Original**. The right pane shows **Result (Editable)**. Restoring a block with the arrow, typing in Result, and Undo/Redo change the draft only.

| Situation | Actions |
| --- | --- |
| Content changed | **Keep current** acknowledges the file without writing. **Restore original** restores the previous contents. |
| Draft edited | **Save result** writes the draft after checking that the file has not changed again. |
| File renamed | **Keep rename** keeps its current path. **Restore original path** reverses a pure rename. For a rename with content changes, **Restore original** restores both contents and path. |
| File deleted | **Keep deletion** leaves it deleted. **Restore file** recreates the original. If a content draft existed, **Save result** can recreate that draft. |
| File missing without deletion metadata | **Restore result**, **Restore original**, or **Discard review**. Discarding a review asks before removing its saved draft. |
| New-file review enabled | **Keep new file**, **Save result** after editing, or **Move new file to trash**, using Obsidian's deletion preference. |

Keeping a deletion asks before discarding an edited draft. Restoring a missing file creates missing parent folders and never overwrites an occupied path. Restoring a renamed path requires its original parent folder to exist and the destination to be free. Case-only restoration may be blocked on case-insensitive filesystems. Content writes and path changes are separate operations; a partial failure leaves the review available with an error explaining what to check. Drift uses `Vault.rename` and does not additionally update links in other notes.

**Keep all current** never writes files. It skips edited drafts, missing files requiring recovery, conflicts, and unresolved rename associations. **Restore originals…** shows a confirmation with counts for affected files, renames, deletions, new files to trash, and drafts to discard. It restores original contents **and paths** consistently. Unresolved associations and content conflicts remain open. Completion messages report skipped and remaining reviews, including failures. The toolbar displays ready, draft, rename-decision, and unavailable counts.

If the file changes while you have an edited draft, Drift keeps the draft and shows **Review latest changes**. This starts a comparison with the latest disk text on the left and your saved draft on the right. It does not write the file. The new left side becomes the baseline for **Restore original**. Undo history resets when starting that new comparison or reloading the plugin; otherwise it survives collapsing and reopening comparisons. Draft text survives restarts, including when its file has disappeared.

Editing a note directly while an external review is pending shows a warning before discarding that review and draft. Typing-only reviews, when enabled, do not repeatedly interrupt ordinary typing.

## Renames and synchronization

Enable **Track renames and deletions (experimental)** for this workflow. Upgrades combine the previous separate rename/deletion settings: if either was enabled, the combined setting is enabled.

Confirmed Obsidian rename events move existing reviews to the new path, preserving their Original, draft, and session history. **Renamed from** retains the initial path through a chain of moves. Existing reviews follow recognized moves even when creating new lifecycle reviews is disabled. Folder rename events migrate existing reviews and baselines without creating one review per unchanged child.

External tools can deliver a rename as deletion plus creation, in either order. Drift compares a missing file's **last known contents** with recent creations. It checks identical contents and then overlap of word-sequence fingerprints. Original and edited Result are preserved separately.

- A review shows its best candidate and either **Identical contents** or a **content similarity** percentage. This is evidence, not certainty.
- Select **Review match…** to preview **Last known contents → Candidate**. A sole candidate is previewed automatically. Alternatives are ordered by similarity.
- **Confirm rename** links the review to the already-existing destination. It does not move or modify files. Confirmation rechecks the preview and refuses to replace an independently edited destination review.
- **Undo association** reverses that metadata decision while the same review remains open in the current session, preserving draft edits. Starting a new latest-version comparison also ends association undo. It does not move files. The undo action is not persisted across restart.
- **Treat as separate files** dismisses automatic suggestions for that missing review. **Look for matches again** reverses the dismissal. **Select renamed file…** / **Select another file…** allow manual selection.

Unresolved sources and candidate reviews are excluded from bulk actions and export, with a visible omission count. Resolve or dismiss the association first. Disabling matching does not silently accept saved associations. Duplicate/template notes require confirmation even when their contents are identical.

Deletions wait 500 ms so temporary replacements can settle. Delete/create saves at the same path compare the replacement against the previous baseline. A returning original with unchanged contents and no edited draft clears an obsolete review. An unconfirmed external rename round trip can still leave a review for the temporary filename; the plugin does not invent an association.

Matching uses at most eight suggestions at 80% similarity or above. Empty files are not matched; short or highly repetitive files require exact contents. Automatic fingerprints accept up to 256 Ki characters and 60,000 tokens. Recent creation candidates are bounded by 128 paths, 30 minutes since their last observation, and 2 Mi characters. Source fingerprint caching has the same count/text bounds, but **all pending missing sources are examined in batches**, including older unresolved deletions. Fingerprinting and comparison yield between batches. A visible status indicates matching in progress or candidates excluded by size/capacity limits.

If deletion arrives first, its unresolved review can match a creation delivered much later. If creation expires before deletion arrives, select it manually. Saved suggestions survive restart; the transient creation cache does not. Startup checkpoint reconciliation can identify newly present paths, but changes that leave no observable difference between checkpoints cannot be reconstructed. Large reorganizations can exceed candidate retention limits. Manual preview is limited to approximately 1 MB. See [measured performance](docs/rename-performance.md) and the [testing checklist](docs/lifecycle-testing.md).

## Display and navigation

Drift opens in a background tab by default. Enable **Focus diff tab on external change** to switch automatically. Use **Open diff viewer** to reopen it.

Comparisons support collapsible unchanged regions, per-file collapse, synchronized scrolling, and a shared horizontal scrollbar. **Word wrap** is off by default. **Word-level highlighting** uses patience diff for line alignment and character diff inside changed blocks. **High-contrast word highlighting** adds red/green backgrounds with white text. Changing the diff algorithm preserves draft text and available session history. Suggestion updates preserve existing comparison editors, selection, and scroll position.

## Export a review

**Export diff** saves pending Original → Result comparisons as a unified patch without resolving reviews. The snapshot includes collapsed sections and edited drafts. Unchanged content-only reviews are omitted. Unresolved rename sources/candidates are excluded, with a visible count.

Exports are saved in the vault root. Settings provide a filename template (`drift-%Y-%m-%d_%H-%M.diff.txt`), context lines (default `3`), and readable Unicode paths (on by default). Supported filename tokens are `%Y`, `%m`, `%d`, `%H`, `%M`, `%S`, and `%%`, using local time. Folder paths are not permitted. The dialog suggests a free filename; selecting an occupied filename shows a red overwrite message, and **Export** overwrites it without another popup.

**Open after export** initially defaults on. Markdown opens in a new Obsidian tab, text in a read-only Drift tab, and other extensions through the system application. A failed open leaves the export saved.

Patches preserve viewer order, CRLF, and missing final newlines. Creation reviews use `/dev/null` as the source; tracked deletions use it as the destination. A deletion exports the deletion even if a draft remains available for recovery. Rename sections use the **current path** with uppercase warning comments: the patch does not rename files. Pure renames export metadata only. Empty-file creation/deletion uses Git metadata; use Git for those cases.

From a vault containing the Original versions:

```sh
git apply --check drift-2026-10-02_14-05.diff.txt
git apply drift-2026-10-02_14-05.diff.txt
# For ordinary text hunks, GNU patch is also supported:
patch -p1 < drift-2026-10-02_14-05.diff.txt
```

For zero-context exports, add `--unidiff-zero` to Git commands. Exports cover pending reviews, not every file in the vault or a complete backup.

## Installation and development

Install Drift from the [Obsidian community plugin directory](https://community.obsidian.md/plugins/drift), or download `main.js`, `manifest.json`, and `styles.css` from a release into `<Vault>/.obsidian/plugins/drift/` and enable it in **Settings → Community plugins**. This experimental branch must be built locally to use its unreleased features.

```sh
npm ci
npm run build
npm run lint
npm run test:review
npm run test:diff
npm run test:export
npm run bench:rename
```

Copy the three plugin files into a disposable test vault and reload Drift. `npm run dev` watches sources, but copying and reloading are still required. Generated `main.js` and dependencies are excluded from Git. Export tests require Git and GNU patch.

End-to-end tests launch a separate Obsidian profile; see [test environment notes](e2e/LEARNINGS.md). Manual Dropbox testing requires another device and is listed separately in the checklist.

Commands retain stable IDs: **Open diff viewer** and **Toggle external change detection**.
