# Persistence performance

Routine state saves wait for five seconds without changes. Typing updates in-memory observations; it does not serialize the vault. Settings changes save immediately, and unload attempts a final save. An abrupt exit can lose Drift state from the entire unsaved interval; unload cannot guarantee completion during process shutdown.

## Storage and migration

`data.json` contains settings and a versioned index. Each checkpoint and pending review has its own immutable `state/record-<uuid>.json` file under the plugin directory. A review record includes its draft and rename undo metadata; checkpoints retain the original text needed to compare changes made while Obsidian was closed.

The writer compares strings and metadata against the last successful save before serializing. Unchanged records are reused. A changed record gets a new filename, then the new index is saved through `Plugin.saveData()`. Previous records are removed only after that save succeeds. A failed record or index write leaves the previously committed records intact; failed cleanup is retried later. Startup reads referenced records with at most four concurrent reads and discovers orphaned records left by interrupted saves. It prunes those only after a successful save, touching only Drift's record filenames.

Legacy inline checkpoints and reviews migrate on the first successful save. Until the index commits, the old `data.json` remains the source of state. Migration writes the whole dataset once and can take longer than routine saves. The underlying adapter and `saveData()` still determine filesystem durability; this is not a transactional filesystem guarantee.

Sync and back up both `data.json` and `state/`. If an index arrives before its records during synchronization, loading fails rather than silently dropping checkpoints or drafts. Finish synchronization and reload. Older plugin versions cannot read this format; preserve a pre-upgrade copy of plugin data if testing a downgrade.

This design reduces writes proportional to total note text, but still scans in-memory record metadata and rewrites the index when references or settings change. A large individual note/review remains a large individual record. It does not compress or discard draft/history text.

## Reproducible synthetic benchmark

Run `npm run bench:persistence`. It creates and removes a temporary fixture outside the vault. It measures JSON serialization, UTF-8 buffer creation, and Node filesystem writes for five single-note edits at each size. Migration is measured separately. The corpus uses Unicode notes of approximately 8 KiB each, without pending reviews.

Example on Linux, Node 22.22.0:

| Checkpoint corpus | Full-state bytes written | Incremental bytes written | Full-save median | Incremental median |
| --- | ---: | ---: | ---: | ---: |
| ~100 KiB | 108,879 | 9,797 | 0.81 ms | 0.45 ms |
| ~1 MiB | 1,079,393 | 21,194 | 6.52 ms | 0.56 ms |
| ~5 MiB | 5,363,809 | 71,882 | 38.14 ms | 1.31 ms |
| ~10 MiB | 10,719,891 | 135,523 | 73.10 ms | 1.69 ms |

Each incremental save writes one changed checkpoint and the index; unchanged saves write zero files. These are local synthetic timings, not Obsidian renderer timings or predictions for a particular vault, filesystem, or sync service.

## Verify in Obsidian

1. Let initial migration finish before measuring routine saves.
2. Record continuous typing for 15–20 seconds, then keep recording for another 7–10 seconds.
3. Confirm no Drift persistence executes during typing. After idle, inspect the changed record write and the smaller `saveData()` index write.
4. Repeat with a pending review draft, reload Drift, and verify that the draft and original survive.

Optional debug logging emits `persistence.saved` with changed record count, serialized record/index character counts, checkpoint/review counts, and total elapsed save duration. It excludes note contents and paths from that event. Character counts are UTF-16 code units, not UTF-8 bytes; the benchmark reports actual bytes. Total elapsed time includes asynchronous I/O and cleanup, so use DevTools to measure renderer CPU/blocking time. Debug logging itself adds work and should be disabled for the final performance comparison.

## Editor wrapper attribution

`ProgrammaticEdits` wraps supported Editor API methods to classify programmatic changes. It calls the original method once with its original receiver and arguments, tracking nested synchronous calls with a per-path counter and `try/finally`. Stack capture and timing diagnostics run only with debug logging enabled. The wrapper contains no DOM measurement, style mutation, selection update, or extra editor transaction.

A sampled stack beneath this wrapper includes the original editor's work. Inclusive layout time alone does not establish that the wrapper caused additional layout. Investigate this independently with debug logging disabled and comparable editor actions before changing classification behavior; removing wrappers would affect which edits are reviewed.
