# Editor detection debug log

## Follow-up: manual commands and responsiveness

The configurable **Treat these events as manual edits** list takes precedence over an active Editor API wrapper. Defaults are `input.type`, `input.paste`, `delete`, `undo`, and `redo`. This covers the observed Obsidian `newlineAndIndentContinueMarkdownList` call (`input.type`) and ordinary `replaceSelection` paste (`input.paste`). Unannotated Better Paste transactions remain in the Editor API category. A plugin that supplies a listed annotation follows the other-editor setting too. Mixed updates containing an unrecognized document-changing transaction remain programmatic when inside an API call.

To add an exception, copy the exact marker from `editor.update.userEvents` into the settings field on its own line. Do not copy `null`: that means no marker. A name matches itself and dot-separated subtypes, with case preserved. Settings snapshots include the parsed `manualEvents` list so logs show which rules were active. Keep **Review other editor changes (probably not needed)** off to ignore matching changes. Try ordinary paste first, then a Better Paste conversion; only the subsequent unannotated transformation should create a new review. **Restore defaults** reverses customizations.

Repeat case A on a fresh disposable note: type text, create a Markdown list, press Enter to continue it, use Backspace, Undo and Redo, then paste through Better Paste. Manual annotations should show `source: other-editor`, `manualAnnotation: true`, and `reviewEnabled: false`. The unannotated paste should show `source: editor-api` and create a review. Pending reviews can still trigger an edit warning; resolve them before the next case.

Debug now records:

- `debug.performance` once per second: main-thread scheduling delay, input counts, buffered events, logging serialization time, and the last file write measurement. Background-window throttling or system sleep can also cause scheduling delays.
- `debug.flush`: elapsed time for writing each batch, including initial file creation when applicable. This is wall-clock latency, not CPU time; the small timing record's own subsequent write is excluded.
- `editor-api.end.durationMs`: elapsed time for the synchronous API call, including debug work around it.
- `editor.classified.reason`: whether a manual annotation overrode the API route.

Repeated `beforeinput` details are sampled at most every 250 ms; full event counts are retained in the per-second summary. When debug is off, diagnostic input listeners and the heartbeat timer are removed, and stack capture, serialization, and diagnostic timing stop. A final buffered write may finish asynchronously after disabling. Detection itself retains its ordinary hooks and lightweight debug-enabled checks.

For the slowdown, compare the same actions with debug on and off and send the log with the approximate time of the pause. These measurements distinguish an event-loop stall from slow asynchronous writes; they do not identify every possible cause of a stall.

On the experimental editor-review branch, enable **Diagnostics → Debug logging** in Drift settings. It defaults off. Each enable or plugin reload with debug enabled creates a new `obsidian-drift-debug-*` directory in the system temporary directory, containing `events.jsonl`. On Linux this is usually `/tmp`.

Select **Copy log path** to get the exact filename. The button also works after logging is disabled, until the plugin reloads. The log is local and is not written inside the vault. Existing logs are not deleted by Drift.

Records contain timestamps, sequence numbers, active detection settings, vault-relative paths, input event types, document lengths, and review decisions. Editor API begin/end records include a call ID; begin records include a stack trace. Note contents, clipboard text, and typed characters are not recorded. Stack traces and paths may identify installed plugins and local directories.

Writes are asynchronous and normally batched every 250 ms. Up to 1,000 events can wait in a batch; `debug.dropped` reports omitted events if writing falls behind. Abruptly closing Obsidian can lose the last buffered records. Turn debug off after reproducing the issue so the final records are flushed.

## Reproduce the classification problem

Use a disposable Markdown note without an existing review. Keep **Enable change detection** and **Review file API operations** on throughout. Start a separate log for each case by disabling and enabling debug; copy each path before starting the next log.

| Case | Review other editor changes | Review Editor API changes |
| --- | --- | --- |
| A | Off | On |
| B | On | Off |
| C | Off | Off |

For each case, open a fresh note, type a short sentence, press Enter and Backspace, and wait about two seconds for autosave. Then paste a URL that your title-formatting plugin handles and wait until the final title appears. Record which action first opened a review or warning. If an existing review blocks the next action, record that separately; finish or dismiss it before the next case.

Case B deliberately includes manual editing. Case A is the disputed classification. Case C should exclude both editor categories, although independently detected file API writes remain enabled and can still create reviews. The log shows whether that happens.

Relevant events:

- `input.event`: input/paste/composition events from the main document's CodeMirror editors, without input text. Pop-out windows may lack these input markers.
- `editor-api.begin` / `editor-api.end`: wrapped method, path, call ID, nesting depth, and caller stack.
- `editor.update`: CodeMirror user-event annotations, programmatic flag, and document lengths.
- `editor.classified`: the selected category and whether review is enabled.
- `vault.modify`, `vault.classified`, `vault.ignored`: file events and whether Drift recognized an editor autosave, its own write, or an API operation.
- `review.received`, `review.updated`, `review.draft-preserved`: review creation/update and draft protection.
- `editor.blocked-by-review`: the edit warning was caused by an already pending review.

Send the log files or their paths together with the case letters and the action that triggered the unwanted review. Logs are evidence of the execution path, not guaranteed identification of the author.
