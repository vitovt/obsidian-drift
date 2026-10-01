# Test experimental file lifecycle reviews

Build with `npm run build`, copy `main.js`, `manifest.json`, and `styles.css` to a test vault's `.obsidian/plugins/drift/`, and reload Drift. Start with both experimental settings disabled. Use disposable Markdown files.

## 1. Acknowledge and save

1. Create a note in Obsidian, then change its text externally.
2. Select **Accept**. Verify its content and modification time do not change.
3. Repeat, edit Result, and verify the action becomes **Save result**.
4. With another pending file, select **Accept all changes**. The edited draft must remain open; other files must not be rewritten.
5. Select **Save result** and verify only the edited draft is written.

## 2. Confirmed renames

1. Enable **Track file renames (experimental)**.
2. Rename an unchanged note inside Obsidian. Expect a compact review, its current path, the previous path, and **No content changes**.
3. Select **Keep rename**. The file stays at its current path without a content write.
4. Rename again, then select **Restore original path**. Verify the original name returns.
5. Create an external content change, edit Result, and rename the note twice. Original, Result, and Undo/Redo must survive; the initial path remains in the label.
6. Reject without the checkbox: restore only content at the current path. Repeat with **Restore original path** checked: restore content and path.
7. Occupy the original path with another file. Restoration must fail without overwriting either file or changing content.
8. Rename a folder containing pending reviews. Only existing reviews follow it; unchanged children do not each create a review.
9. Reload Drift with a rename pending. Its paths and draft survive; the restoration checkbox resets.

## 3. Deletions

1. Enable **Track file deletions (experimental)**.
2. Delete a known note. After about half a second expect all its text shown as removed and a read-only empty result.
3. Select **Keep deletion**. No file is created.
4. Repeat and select **Restore file**. Its last known contents return.
5. Delete a folder containing a known note, then restore the note. Missing parent folders are recreated.
6. Delete a note with an edited Result. Verify the draft remains editable and **Restore original**, **Keep deletion**, and **Save result** are available.
7. Verify **Keep deletion** asks before discarding an edited draft. Cancel and check the draft remains.
8. Verify **Save result** recreates the draft, while **Restore original** recreates Original.
9. Recreate a deleted note externally with different text. Review its current contents; recovery must not overwrite it silently.
10. Reload Drift with deletions pending. Reviews and drafts remain available.

## 4. Bulk actions and export

1. Prepare a pure rename, a content change with a rename, a deleted file, and an edited draft.
2. Inspect both bulk-action tooltips.
3. Export while some sections are collapsed. Verify viewer order, uppercase rename warnings, current paths, and `/dev/null` for deleted files.
4. **Accept all changes** keeps current filenames, contents, and deletions; edited drafts remain open. Repeat with explicit restoration checkboxes separately.
5. **Reject all changes** restores deleted files and original contents. Pure renames reverse; content-review renames reverse only with their checkbox selected.

Dropbox may deliver a rename as separate deletion and creation events. Drift intentionally does not associate those files. Offline changes and full-vault rename discovery are outside this experiment.
