# Drift

Review changes to Markdown notes in one place inside Obsidian. Drift compares the previous text with changes from external editors, AI agents, scripts, plugins, and synchronization tools, and lets you keep the current file, restore the original, or edit a result draft before saving.

![Drift demo](demo.gif)

## Selecting reviews and confirming renames

Use the checkbox beside a file to limit **Keep selected** and **Restore selected** to selected reviews. With no selection, those buttons apply to all reviews. The compact **Clear selection** icon beside Expand/Collapse returns to that all-files scope. Unresolved rename decisions and other existing safety exclusions still apply; export continues to include all eligible reviews independently of selection.

Possible renames show **From → To** paths. **Confirm rename** associates the displayed candidate after validating its contents, including identical matches whose temporary cache has expired. If the contents changed or an approximate match is no longer cached, it opens that candidate's preview for confirmation. **Review match…** always opens the content comparison first. Both actions protect unfinished drafts. Only filenames are bold; folder paths use regular text. When both files share a folder, the destination after the arrow shows only its filename. Copy-path icons still copy the full paths. Confirmed renames also show the old and current paths in the file header.

**Undo association** reopens the rename decision; it does not move files. New confirmations save the pre-association review snapshots, so undo remains available after restart and later content updates. Edited drafts are preserved; editor undo/redo history remains session-only. Older renames without saved association history show a disabled Undo button with an explanation. Undo is blocked if the associated file is missing, the paths have changed, or another file/review occupies the source path. Deletion actions remain disabled until you confirm a rename again or choose **Treat as separate files**, including after a restart. Once treated separately, **Restore file** restores the old path and **Keep deletion** leaves that path deleted; neither changes the other file.

## Settings layout

Dependent controls share an indented block with a vertical divider. **High-contrast word highlighting** appears below **Word-level highlighting** only while it is enabled; hiding it preserves its value. Editor API event filters and File API child switches use the same layout. **Debug log location** is also indented beneath Debug logging, but remains available after logging is disabled so the completed log path can still be copied.

## What gets reviewed

**Review file API operations** is a master switch with three indented child settings. Turning it off hides the children and preserves their values:

- **Review file content changes** defaults on: text written through file APIs by plugins, integrations, or Obsidian. Initial file creation also follows **Review newly created files**.
- **Review file renames and moves** defaults off: includes manual renames and moves in Obsidian as well as plugin operations.
- **Review file deletions** defaults off: includes manual deletions in Obsidian as well as plugin operations.

The rename and deletion children also require **Track renames and deletions**. External filesystem operations continue to follow the existing external detection settings. Existing reviews follow ignored internal renames without adding a new original-path change. These defaults also apply when upgrading from settings that do not yet contain the child options; the saved master-switch value is retained. Editor API review remains independent.


| Setting | Default | Behavior |
| --- | --- | --- |
| Enable change detection | On | Review changes to known Markdown files. |
| Review newly created files | **Off** | New files establish a baseline and remain eligible for rename matching. Later edits are reviewed. Enable to review the initial creation too. |
| Ignore changes to empty files | Off | When enabled, the first content written to a zero-character file becomes its baseline. Whitespace is not empty. Existing reviews are preserved. This is independent of reviewing new files. |
| Review other editor changes | Off | Include typing, pasting, and changes not recognized as Editor API calls, including plugins that modify CodeMirror directly. |
| Review Editor API changes (experimental) | Off | Review programmatic calls through supported Editor API methods, including link-title formatting. This identifies a write path, not the author. |
| Review file API operations | On | Include operations through Obsidian file APIs, from plugins, integrations, or Obsidian itself. Supported Editor API calls follow **Review Editor API changes**; other editor changes follow **Review other editor changes**. |
| Review changes made while closed | On | Store local Markdown content checkpoints and compare them during the next startup. |
| Track renames and deletions (experimental) | Off | Review missing files and suggest possible renames. |

New-file events settle for 250 ms of inactivity (up to two seconds) so an empty creation event followed immediately by copied contents establishes one baseline. Edits after that settling period are reviewed.

For example, with the defaults, copying `notes.md` into the vault creates **no review**. Editing it afterward creates a content review. If the copied file is a possible destination for a missing note, it can still appear as a rename candidate. Enabling **Ignore changes to empty files** additionally skips the first fill of an empty file.

Origin detection uses editor transactions and file APIs. It cannot reliably identify every tool or distinguish an Obsidian file operation from a plugin using the same API. Unknown filesystem writes are treated as external. Disabling API review does not dismiss an existing external review: a later API write can instead mark it as needing a fresh comparison. An AI tool writing through an Obsidian API is covered by API review; one writing directly to disk is covered by external detection.

On the `experimental/programmatic-editor-reviews` branch, **Review Editor API changes (experimental)** wraps `replaceRange`, `replaceSelection`, `setValue`, and `transaction` on open Markdown editors. For example, an existing plain URL followed by an API replacement produces Original = URL and Result = Markdown link. Successive plugin replacements continue the same review and preserve edited Result drafts. The option defaults off; existing saved preferences are retained. Its event-list controls are shown only while it is enabled, with their contents preserved when hidden. The fixed, disabled toggle beside **Changes outside Obsidian** indicates that external changes are always included while global detection is enabled.

This is partial classification, not plugin attribution. Obsidian itself can call these APIs, including in response to user actions. Plugins that dispatch directly to CodeMirror, retained method references that bypass the wrappers, and calls before an editor is attached may not be recognized. A paste plugin can insert a placeholder through the API before fetching its title; that initial insertion can also be reviewed. There is no promise that every paste plugin produces a plain-URL baseline. Disabling API review does not discard an existing review.

**Treat these events as manual edits**, below the Editor API toggle, controls which transaction annotations take precedence over the API route. Defaults are `input.type`, `input.paste`, `delete`, `undo`, and `redo`, one per line. Names are case-sensitive and match dot-separated subtypes (`delete` also matches `delete.backward`); wildcards are not supported. Blank lines and duplicate names are ignored. An empty field removes all exceptions. **Restore defaults** restores the initial list; changes apply immediately and persist across restarts.

Matching changes follow **Review other editor changes (probably not needed)**. Leave that toggle off to ignore them. This covers annotated typing, ordinary paste, and Markdown list continuation; a later unannotated Better Paste transformation can still create a review against the text you pasted. Plugins supplying matching annotations also follow the other-editor toggle: this is an event filter, not a plugin blacklist. Events without an annotation do not match. Copy additional names from `userEvents` in [the debug log](docs/editor-debug.md); debug defaults off.

Wrappers mark only their synchronous call scope, support nested calls, and are restored on editor removal or plugin unload without replacing another plugin's newer wrapper. No stack inspection, vault scan, or new filesystem watcher is added. Drift also recognizes recent editor versions when delayed autosaves arrive, so an earlier URL save does not become a reverse review. Autosave matching is bounded to 64 versions and 8 Mi characters across files, with a 10-second lifetime.

The first run establishes the checkpoint; it cannot recover changes made before installation. With checkpoints enabled, subsequent startup compares the current vault against the last saved observations, including changes delivered by Dropbox while Obsidian was closed. It reuses the startup Markdown scan, with four concurrent reads. Read failures keep the previous checkpoint and saved drafts and show a retry notice. There is no additional filesystem watcher or continuous polling.

Settings and a record index are stored in the plugin's `data.json`; checkpoint text and review drafts live in separate per-note JSON records in its `state/` directory inside the vault configuration folder. No telemetry or network requests are made by Drift. If your sync tool includes that folder, it can sync this data too. Sync or back up `data.json` and `state/` together. A missing or unreadable referenced record stops plugin loading rather than discarding saved state; finish synchronization or restore the missing record, then reload Drift. Older Drift versions cannot read the new record index.

Disabling **Review changes made while closed** removes checkpoint references on the next save and cleans up their records; pending reviews and drafts remain.

Routine saves wait for five seconds without changes, so continuous typing keeps checkpoints and drafts in memory. Settings changes save immediately, and plugin unload attempts a final save. Writes remain serialized. A changed note writes only its checkpoint and/or review record plus the index; unchanged records are reused, and a save with no changes does not write. Legacy `data.json` contents migrate automatically after their replacement records have been written successfully. Obsolete records are removed only after the new index saves. A single very large note or review can still make its own record expensive to save. An abrupt process or storage failure can lose changes since the last save, including a continuous typing session; unload saves are best-effort. Checkpoints are observations, not a version history or backup.

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
- **Confirm rename** links the review to the already-existing destination. It does not move or modify files. Confirmation rechecks the preview and refuses to replace any existing destination review.
- **Undo association** reverses that metadata decision while the review remains unresolved, including after restart, preserving draft edits. Starting a new latest-version comparison also ends association undo. It does not move files.
- **Treat as separate files** dismisses automatic suggestions for that missing review. **Look for matches again** reverses the dismissal. **Link to existing file…** / **Select another file…** allow manual selection for every missing review, even with rename and deletion tracking disabled. Missing reviews retain their Original and draft across restart. **Find matches in vault** searches existing Markdown files, including paths already in checkpoints; it is cancellable and reads current contents. Search skips files larger than 256 KiB and bounds fuzzy matching with the automatic fingerprint limits; manual selection remains available for larger files.

Unresolved sources and candidate reviews are excluded from bulk actions and export, with a visible omission count. Resolve or dismiss the association first. Disabling matching does not silently accept saved associations. Duplicate/template notes require confirmation even when their contents are identical.

Deletions wait 500 ms so temporary replacements can settle. Delete/create saves at the same path compare the replacement against the previous baseline. A returning original with unchanged contents and no edited draft clears an obsolete review. An unconfirmed external rename round trip can still leave a review for the temporary filename; the plugin does not invent an association.

Matching uses at most eight suggestions at 80% similarity or above. Empty files are not matched; short or highly repetitive files require exact contents. Automatic fingerprints accept up to 256 Ki characters and 60,000 tokens. Recent creation candidates are bounded by 128 paths, 30 minutes since their last observation, and 2 Mi characters. Source fingerprint caching has the same count/text bounds, but **all pending missing sources are examined in batches**, including older unresolved deletions. Fingerprinting and comparison yield between batches. A visible status indicates matching in progress or candidates excluded by size/capacity limits.

If deletion arrives first, its unresolved review can match a creation delivered much later. If creation expires before deletion arrives, select it manually. Saved suggestions and a bounded list of recent creation paths/timestamps survive restart. Candidate text is reread on startup, and restarting does not renew its retention period. Subsequent edits update a candidate rather than removing it. Startup checkpoint reconciliation can identify newly present paths, but changes that leave no observable difference between checkpoints cannot be reconstructed. Large reorganizations can exceed candidate retention limits. Manual preview is limited to approximately 1 MB. See [measured performance](docs/rename-performance.md) and the [testing checklist](docs/lifecycle-testing.md).

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

Persistence benchmark and profiling instructions: [Persistence performance](docs/persistence-performance.md).
