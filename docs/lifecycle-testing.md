# Lifecycle review testing

Use a disposable vault. Run `npm run build`, copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/drift/`, and reload Drift. Do not copy plugin `data.json` from a different vault.

## Defaults and copied files

1. Leave **Review newly created files** off. Copy a nonempty Markdown file into the vault from outside it: no creation review should appear.
2. Edit that file externally: expect Original to contain the copied text and Result to contain the edit.
3. Enable **Track renames and deletions (experimental)**. Move a known file externally: the new path remains eligible for matching even though new-file reviews are off.
4. Enable **Review newly created files** and copy another file: expect **Keep new file** and **Move new file to trash**. Edit Result and expect **Save result**. Keeping it must not change its modification time.
5. Test an empty creation with both settings combinations. **Ignore changes to empty files** only suppresses the first fill of an empty baseline without a pending review; it does not control initial creation reviews.

## Edits and replacement saves

1. Modify an existing file externally. **Keep current** acknowledges it without writing. **Restore original** restores its previous content.
2. Delete and recreate a known path quickly with different text, as an atomic-save editor might: expect a content review, not a silently replaced baseline.
3. Edit Result, restore a block, and use Undo/Redo. The disk must not change until **Save result**.
4. Update the file externally while a draft exists. **Review latest changes** must retain the draft and use current disk text as the new comparison baseline.
5. Change the file again immediately before saving/restoring: the operation must refuse to overwrite the new version and retain the review.

## Origins

1. With **Review my typing** off, type and wait for autosave: no new review.
2. With **Review plugin and file operations** on, write via `vault.modify`, frontmatter APIs, or a connected AI tool: expect review for both open and closed notes.
3. Turn API review off and repeat: no new review. If an external review already existed, the API write must not silently dismiss it.
4. Enable typing review: typing should be included without repeated edit-warning prompts for an untouched typing review.
5. Recognized moves must keep existing reviews usable even with detection or lifecycle creation disabled. API-origin classification includes in-app file operations; test this separately from typing.

## Renames and decisions

1. Rename a known file with `mv`. Expect **Possible rename** and its best candidate. Preview and confirm: the file must not be written or moved by confirmation.
2. Repeat with small content edits. The preview uses last known contents; the subsequent review preserves Original.
3. Create duplicate/template destinations. Scores indicate similarity; no association happens without confirmation.
4. Edit Result before moving. Confirm the association: draft and available Undo/Redo survive. Select **Undo association**, then **Look for matches again** and confirm again. Later draft edits must survive undoing the association.
5. Select **Treat as separate files**, then **Look for matches again**. Dismissal must be reversible. Test manual selection too.
6. Change a candidate after preview: confirmation must request a fresh preview. An independently edited destination review must not be discarded.
7. For pure renames, test **Keep rename** and **Restore original path**. For renames plus edits, **Restore original** must restore both contents and initial path; **Save result** keeps the current path.
8. Occupy the original path: restoration must fail before changing content. Test a missing original folder and case-only rename on applicable filesystems.
9. Rename a folder: existing review objects and drafts follow it. Exceed 128 missing sources and verify older sources still get examined. Large creation batches show matching-limit feedback.
10. Rename out and back. The original-path review clears when its content is unchanged and no draft remains. Without confirmed identity, a temporary-path deletion review may remain.

## Missing files and deletions

1. Delete a known note. After the settling delay, inspect **Keep deletion** and **Restore file**.
2. Delete a note with an edited draft. Test **Save result**, **Restore original**, and the discard warning on **Keep deletion**.
3. With lifecycle tracking off, make a draft, remove its file, and restart. The draft must remain recoverable as a missing-file review.
4. Use **Restore result** or **Restore original** directly, without a permission checkbox. Missing parent folders should be recreated. **Discard review** must explain that it removes the saved draft without modifying files.
5. Recreate the path with other contents before restoring: never overwrite it silently.

## Startup, sync and persistence

1. The first run establishes a baseline without opening reviews for existing notes.
2. With **Review changes made while closed** on, disable Drift, edit an existing file, add a new one, and rename/delete a known file. Re-enable Drift: expect offline edits and enabled lifecycle reviews. New-file review still follows its own setting.
3. Repeat with an edited draft pending: preserve the draft and mark a conflict if disk content changed.
4. Test a read failure during startup: retain the checkpoint and draft and show a retry notice.
5. Turn checkpoint recording off and save settings: stored checkpoints should be removed while pending reviews remain.
6. Deliver deletion before creation with a long delay, then creation before deletion within the retention window. Both should suggest a match. After the creation window expires, manual selection remains available.
7. **Two-device Dropbox test:** edit and rename offline on another device, then synchronize while Drift is running; repeat while Obsidian is closed and reopen it. Include duplicates, folder moves, and delete/create replacement saves. Verify local results and remote propagation separately. Automated filesystem tests do not validate Dropbox's actual event delivery.

## Bulk actions and export

1. Prepare ordinary edits, an edited draft, a pure rename, rename plus edits, a deletion, an optional new-file review, and an unresolved rename.
2. Check visible counts. **Keep all current** writes nothing and skips drafts, missing recovery files, conflicts, and unresolved associations.
3. **Restore originals…** previews affected files, new files to trash, renames, deletions, and drafts to discard. Cancel must change nothing. Confirm restores both content and paths consistently.
4. Resolve an ambiguous association while a bulk operation runs: excluded or changed reviews must not be applied under a stale decision.
5. Export collapsed and expanded reviews. Check ordering, creation/deletion `/dev/null` paths, uppercase rename warnings, and omitted-association counts. Deletion export does not export a saved recovery draft.
6. Apply exports with Git and GNU patch in a separate fixture directory. Use Git for empty-file creation/deletion. Test filename collisions and open-after-export routes.

## Automated checks

Run `npm run test:review`, `npm run test:diff`, `npm run test:export`, `npm run build`, and `npm run lint`. Run `npm run bench:rename` for the reproducible matching workload. See [performance results](rename-performance.md) for the measured environment and limits; the benchmark does not render the Obsidian UI.
