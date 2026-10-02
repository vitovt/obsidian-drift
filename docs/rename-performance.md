# Rename matching performance

Run `npm run bench:rename` from the repository root. The benchmark bundles the real matcher against a small vault fixture, observes a burst of creations, and measures a complete matching pass, heap delta, and gaps in a 1 ms event-loop heartbeat. It does not launch or render Obsidian.

## Recorded measurement

Measured on Linux with Node v20.19.4 on 2026-10-02. Notes contain approximately 21 KiB of Markdown; candidate contents are either identical or have a small appended edit. These deliberately ambiguous documents exercise comparisons against many plausible matches.

| Pending missing files | Creation events | Retained creation paths | Sources receiving suggestions | Elapsed | Maximum heartbeat gap | Heap delta |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 32 | 32 | 32 | 383 ms | 10 ms | 6.8 MiB |
| 128 | 128 | 97 | 128 | 2,978 ms | 6 ms | 17.0 MiB |
| 512 | 128 | 97 | 512 | 11,352 ms | 8 ms | 5.5 MiB |

The 2 Mi-character creation budget is reached before the 128-path limit in the larger fixtures. This is intentional; retained paths are reported explicitly. All 512 missing sources are examined, rather than permanently limiting matching to the newest 128 sources. The UI displays matching progress and warns when creation candidates exceed automatic size/capacity limits.

An earlier synchronous fingerprinting implementation produced roughly 170 ms heartbeat gaps during 128-file bursts in an all-identical corpus. Fingerprinting now runs during the yielding matching pass instead of inside each create-event handler. The mixed-content results above show why deferring that work matters. These are development measurements, not a cross-machine performance guarantee or a controlled statistical comparison.

Heap delta is affected by garbage collection and includes temporary allocations. It is not the retained-memory limit. The count/text limits bound candidate and source fingerprint caches; JavaScript Sets, review drafts, persisted checkpoints, and the existing vault baseline cache consume additional memory.

## Limits and remaining scope

- Up to 128 recent creation paths, retained for 30 minutes after observation, with a 2 Mi-character text budget.
- Up to 128 cached source fingerprints and 2 Mi characters; pending sources are visited in rotating, yielding batches without permanently excluding older reviews.
- Per fingerprint: 256 Ki characters and 60,000 tokens; empty text does not match and short/repetitive text requires exact equality.
- At most eight suggestions per missing file at 80% similarity or higher.
- Exact matches require user confirmation. Similarity is token-sequence overlap, not rename probability.
- Manual previews are capped at approximately 1 MB.

The benchmark validates throughput and responsiveness for these fixtures. Large single-document fingerprinting, actual Obsidian layout, storage latency, and Dropbox delivery should be evaluated separately. A two-device Dropbox test is in [the manual checklist](lifecycle-testing.md). Do not increase thresholds or limits solely because this synthetic workload passes.
