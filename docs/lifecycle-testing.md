# Test experimental file lifecycle reviews

Build with `npm run build`, copy `main.js`, `manifest.json`, and `styles.css` to a test vault's `.obsidian/plugins/drift/`, and reload Drift. Start with both experimental settings and **Track in-app changes** disabled. Use disposable Markdown files.

## 1. Acknowledge and save

1. Create a note in Obsidian, then change its text externally.
2. Select **Accept**. Verify its content and modification time do not change.
3. Repeat, edit Result, and verify the action becomes **Save result**.
4. With another pending file, select **Accept all changes**. The edited draft must remain open; other files must not be rewritten.
5. Select **Save result** and verify only the edited draft is written.

## 2. Confirmed renames

1. Enable **Track file renames (experimental)** and **Track in-app changes**.
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
2. Delete a known note externally. After about half a second expect all its text shown as removed and a read-only empty result.
3. Select **Keep deletion**. No file is created.
4. Repeat and select **Restore file**. Its last known contents return.
5. Delete a folder containing a known note, then restore the note. Missing parent folders are recreated.
6. Delete a note with an edited Result. Verify the draft remains editable and **Restore original**, **Keep deletion**, and **Save result** are available.
7. Verify **Keep deletion** asks before discarding an edited draft. Cancel and check the draft remains.
8. Verify **Save result** recreates the draft, while **Restore original** recreates Original.
9. Recreate a deleted note externally with different text. Review its current contents; recovery must not overwrite it silently.
10. Reload Drift with deletions pending. Reviews and drafts remain available.
11. Move a note to another name with shell `mv`, wait for the deletion review, and move it back. With unchanged contents and no edited draft, its original-path review disappears. A separate deletion review for the temporary filename can remain; the two paths are intentionally not associated.

## 4. Bulk actions and export

1. Prepare a pure rename, a content change with a rename, a deleted file, and an edited draft.
2. Inspect both bulk-action tooltips.
3. Export while some sections are collapsed. Verify viewer order, uppercase rename warnings, current paths, and `/dev/null` for deleted files.
4. **Accept all changes** keeps current filenames, contents, and deletions; edited drafts remain open. Repeat with explicit restoration checkboxes separately.
5. **Reject all changes** restores deleted files and original contents. Pure renames reverse; content-review renames reverse only with their checkbox selected.

## 5. External rename suggestions

1. Disable **Track in-app changes**, enable **Track file renames (experimental)**, and leave Drift running.
2. Create a disposable note with several paragraphs. Rename it using `mv` or an external editor. Expect a missing-file review offering the new path as a possible rename, without associating it automatically.
3. Select **Review candidates…**, then **Preview** and **Confirm rename**. Expect **No content changes**, the new path, and **Renamed from**. Confirmation must not write files.
4. Repeat with a few lines changed in the renamed file. Expect a high similarity score and a preview of those changes. After confirmation, Original is preserved and Result contains the current file.
5. Try two identical destination files. Both must be listed; neither is automatically selected. Select **Keep separate** and verify normal deletion/content actions become available.
6. Make a Result draft before externally renaming. Confirm the rename and verify the draft and session Undo/Redo survive. If the destination changed too, review the content conflict before saving.
7. Change the candidate after opening its preview. Confirmation must fail with a request to preview again.
8. Deliver deletion first and creation later; then test creation first and deletion shortly afterward. Also create an empty destination and fill it afterward. Suggestions should appear once sufficient content is available.
9. With suggestions unresolved, exercise both bulk buttons and export. Both source and candidate reviews must remain untouched and omitted; the UI must show the omitted count.
10. Reload Drift or disable rename tracking with suggestions unresolved. The pending association must remain unresolved. Try manual selection when the automatic candidate is absent.
11. Rename/edit/delete inside Obsidian with **Track in-app changes** off: no new reviews. Existing reviews must follow recognized moves. Enable the option and repeat: new reviews should appear; ordinary typing should continue without repeated pending-review prompts.
12. For Dropbox, perform a rename plus small edits on another PC while offline, then sync with this vault and Drift running. Check the suggestions; repeat with duplicate notes and resolve the ambiguity manually.

Matching is intentionally bounded: up to 128 recent creation paths for 30 minutes and 128 pending missing-file sources, with text-size limits. No extra vault scan is performed. Events missed while Drift is stopped are not reconstructed. See the README for all limits.
