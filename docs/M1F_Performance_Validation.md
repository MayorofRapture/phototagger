# M1F Performance Validation

## Baseline and environment

- Baseline: `96fe99c Add M1E3 read-only Image View` on `main`.
- Harness: `npm.cmd run test:performance` (`tests/performance/m1f-performance.ts`).
- Platform: Windows 11 Pro 10.0.26200, x64; Node 24.20.0.
- CPU/RAM: Intel Core i5-8265U at 1.60 GHz, 8 logical CPUs, 16 GiB RAM.
- Workspace drive: `D:` had 766 GiB free. Its filesystem type, physical drive model, cache condition, and antivirus state were not available to this non-administrative harness.
- This is a local development-machine observation, not a laboratory-grade or fully documented TDS reference-hardware acceptance run.

The starting working tree contained only the intentional M1F additions: the `test:performance` package script, this report, and the performance harness. No production source was modified.

## Deterministic synthetic catalog

The harness opens a fresh disposable database through the production schema/initial-state helpers, creates the production TEMP tables, and removes the whole temporary directory after its close/reopen lifetime check. It does not generate image files.

| Population                                 |                                           Count / value |
| ------------------------------------------ | ------------------------------------------------------: |
| Photos                                     |                                          100,000 active |
| Tags                                       | 10,000 (20 roots, 980 intermediate nodes, 9,000 leaves) |
| Explicit `photo_tags`                      |                        1,000,000 (exactly 10 per photo) |
| Flagged photos                             |                                                  10,000 |
| Integrity: clean                           |                                                  99,501 |
| Integrity: missing / unreadable            |                                                 99 / 99 |
| Integrity: metadata/content conflict       |                                               100 / 100 |
| Integrity: recovery required               |                                                     101 |
| Schema + required initial state            |                                               28.510 ms |
| Seed transaction                           |                                           15,310.260 ms |
| `ANALYZE` + `PRAGMA optimize` + checkpoint |                                              507.122 ms |
| SQLite artifacts after checkpoint          |                          117,809,152 bytes (112.35 MiB) |
| Seeding                                    | One explicit IMMEDIATE transaction, prepared statements |

The distribution includes a broad ancestor filter (73,778 matches), a medium ancestor filter (2,001), a narrow leaf filter (305), a nonempty descendant-aware multi-tag AND filter (1,465), and an explicitly unassigned leaf for a zero-result query. It also includes palette entries, literal-percent and literal-underscore tags, repeated NFC-safe filenames, varying revisions/timestamps, metadata states, and shallow through depth-three tag paths.

## Measurement correction and reproduction

The original harness timed `issueAndCheck()`. That function first issued the complete production request (production total count plus bounded page) and then ran a second, independent `expectedCount()` SQL assertion. The second query is a test oracle, not legitimate request work. It was especially expensive for the broad hierarchical case, so the original timing did not represent the TDS request boundary.

The harness now computes and asserts the independent expected counts before sampling, then supplies those values to the timed calls. Every production response is still checked against the independent result, and no dataset size, selectivity, sample count, threshold, production query, or correctness assertion was reduced. Untimed pagination and zero-result checks continue to invoke the independent oracle directly.

Before that correction, two unchanged reruns already failed to reproduce either reported budget miss:

| Operation                    | Original median / p95 ms | Rerun 1 median / p95 ms | Rerun 2 median / p95 ms |
| ---------------------------- | -----------------------: | ----------------------: | ----------------------: |
| Broad hierarchical tag query |        935.569 / 996.823 |       383.589 / 441.314 |       368.085 / 390.364 |
| Tag suggestions              |        120.781 / 141.361 |         44.521 / 45.108 |         42.855 / 43.523 |

This demonstrates substantial local run variability. The corrected final results below measure the production request only while retaining the oracle outside the timer.

## Method

Each timed operation uses the existing production query/service implementation, not substitute SQL. Timings use Node's monotonic `performance.now()`, exclude catalog construction and test-only oracle SQL, and report repeated warm-ish local samples after `ANALYZE`. Median is the middle sorted sample; p95 uses nearest-rank, so for seven samples it is the maximum. The 251-page keyset traversal progresses 50,200 rows beyond page one using issued opaque cursors only.

The following table preserves the originally reported measurements and compares them with the corrected final run. The differences are p95 changes. They are not attributed to a production optimization: the broad result combines the measurement-boundary correction with run variability, while changes in workloads unaffected by that correction demonstrate the machine's run-to-run variability.

| Operation                         | Original median ms | Original p95 ms | Corrected median ms | Corrected p95 ms |    p95 difference |
| --------------------------------- | -----------------: | --------------: | ------------------: | ---------------: | ----------------: |
| Library first page, unfiltered    |             21.865 |          36.823 |               5.116 |           11.720 |  -25.103 (-68.2%) |
| Library deep subsequent page      |             21.802 |          36.661 |               4.771 |            5.645 |  -31.016 (-84.6%) |
| Library first page, flagged       |              3.459 |           5.725 |               0.864 |            1.980 |   -3.745 (-65.4%) |
| Library first page, broad tag     |            935.569 |         996.823 |             284.583 |          290.782 | -706.041 (-70.8%) |
| Library first page, medium tag    |             23.201 |          33.608 |               7.133 |           15.158 |  -18.450 (-54.9%) |
| Library first page, narrow tag    |              5.120 |           5.502 |               1.765 |            2.125 |   -3.377 (-61.4%) |
| Library first page, multi-tag AND |            277.631 |         376.248 |              70.234 |           71.024 | -305.224 (-81.1%) |
| Tag suggestions                   |            120.781 |         141.361 |              44.612 |           47.431 |  -93.930 (-66.4%) |
| Select All, unfiltered            |            798.128 |       1,077.013 |             285.895 |          292.815 | -784.198 (-72.8%) |
| Select All, medium tag            |             21.553 |          29.987 |               6.878 |            7.301 |  -22.686 (-75.7%) |
| Select All, narrow tag            |              4.795 |           5.773 |               1.353 |            1.503 |   -4.270 (-74.0%) |
| Image View session, unfiltered    |          1,064.007 |       1,321.899 |             437.540 |          444.596 | -877.303 (-66.4%) |
| Image View session, medium tag    |             39.784 |          40.485 |              16.063 |           16.789 |  -23.696 (-58.5%) |
| Image View session, narrow tag    |             17.000 |          18.377 |               6.808 |            7.030 |  -11.347 (-61.7%) |
| Image View navigation, beginning  |             48.961 |          66.387 |              21.166 |           23.682 |  -42.705 (-64.3%) |
| Image View navigation, middle     |             61.993 |          67.810 |              19.794 |           23.652 |  -44.158 (-65.1%) |
| Image View navigation, end        |             53.105 |          63.769 |              19.707 |           20.384 |  -43.385 (-68.0%) |
| PhotoDetail reads                 |             35.081 |          36.648 |              13.326 |           14.109 |  -22.539 (-61.5%) |

The local corrected broad hierarchical p95 of 290.782 ms is below the 500 ms reference budget. The local tag-suggestion p95 of 47.431 ms is below the 100 ms reference budget. This is a local observed target result, not universal hardware-independent certification.

## Diagnosis and query plans

### Broad hierarchical filtering

The production query plan uses the `tag_closure` primary key for the requested ancestor, the covering `ix_photo_tags_tag_photo` index for matching explicit assignments, and `ix_photos_active_order` for active-photo lookup. SQLite also creates temporary B-trees for grouping/deduplication, `COUNT(DISTINCT)` ancestor accounting, and final ordering.

For a single tag, distinct ancestor counting is theoretically avoidable, and a correlated semi-join was considered. However, the current generalized query is needed for multi-tag descendant-aware AND semantics, and a one-tag semi-join can regress sparse filters by scanning active photos. Because unchanged reruns already met the target and the corrected production request is approximately 42% below it, no production rewrite was justified. The observed hotspot remains an optimization candidate only if a valid request-only benchmark later demonstrates a stable miss.

### Tag suggestions

The captured production-equivalent plan scans the covering `ix_tag_paths_leaf` index, performs primary-key lookups for tags and palette entries, evaluates a correlated direct-child count, and uses a temporary B-tree for exact ranking. The `OR`-combined escaped `LIKE` predicates do not become a selective prefix seek, and without a `tags(parent_tag_id)` index the child-count subquery scans children for each candidate considered before the limit.

Those are real plan costs, but the unchanged production query completed at 47.431 ms p95 for 10,000 tags. Reordering work through a top-K subquery could change subtle matching/ranking behavior and is unnecessary without a reproduced failure. No suggestion SQL, normalization, wildcard escaping, child-count behavior, palette ranking, limit, or deterministic tie-break behavior changed.

## Correctness validation

- All four approved Library orders produced deterministic first/second keyset pages, valid opaque cursors, and no duplicate boundary IDs.
- 251 unfiltered pages had no duplicate or skipped tested photo IDs.
- Independent SQL counts matched `LibraryQueryService` for unfiltered, flagged, broad, medium, narrow, multi-tag AND, and zero-result queries. Those assertions remain present after moving oracle execution outside timed samples.
- Hierarchical ancestor filtering included explicitly tagged descendants. Multi-tag descendant-aware AND and zero-result behavior remained correct without duplicate results.
- Tag suggestions covered exact leaf, leaf prefix, path prefix, palette ordering, full paths, direct child count, and literal `%`/`_` input.
- Select None, Select One, and Select All used complete TEMP membership; all selection operations left `app_state.catalog_revision` unchanged.
- Image View sessions captured complete contiguous zero-based membership for all four orders. Stored-position navigation was checked near the beginning, middle, and end without rerunning filters.
- A later fixture mutation did not redefine a frozen Image View membership. Both TEMP selection and view-session tables were empty after catalog close/reopen.
- Clean PhotoDetail rows exposed only renderer-safe ID/revision URLs; missing and unreadable rows omitted full-image URLs.

No focused production-query integration test was added because no production implementation changed. The existing full integration suite and deterministic harness continue to exercise the accepted semantics.

## Resource observations

RSS is approximate process-wide diagnostic data, not a memory budget:

| Stage                   |                            RSS |
| ----------------------- | -----------------------------: |
| Before seed             | 118,140,928 bytes (112.67 MiB) |
| After seed/open         | 406,634,496 bytes (387.80 MiB) |
| After Select All checks | 453,902,336 bytes (432.88 MiB) |
| After Image View checks | 498,016,256 bytes (474.95 MiB) |

The temporary database and its companion files were removed after validation.

## Performance conclusion

**Outcome A — Local targets met.**

The initial misses did not reproduce in two unchanged reruns. Correcting the timer to exclude its second, test-only count query produced a valid production request measurement while retaining the independent oracle. Both local measurements now meet the TDS reference budgets with accepted correctness and architecture intact. No production remediation was made, and no universal reference-hardware certification is claimed.

## Regression and packaging verification

- `npm.cmd run typecheck`: passed.
- `npx.cmd vitest run`: passed, 20 files / 169 tests.
- `npm.cmd run test:performance`: passed; corrected results are reported above.
- `npm.cmd run package`: passed; a fresh Windows x64 package was produced.
- Packaged `PHOTOTAGGER_SMOKE_AUTO_QUIT=1` smoke: exited `0` in approximately 9 seconds; logs confirmed main startup, catalog utility startup, a fresh schema-version-1 catalog open, and clean catalog utility shutdown.
- `git diff --check`: passed (only Git's existing LF-to-CRLF working-copy notice for `package.json`).

## Scope confirmation

The only implementation correction is in the performance harness. This report was updated, and the existing `test:performance` package script remains. Production catalog queries, Migration 001, persistent schema/indexes, Library/filter/query semantics, keyset cursors, selection/session semantics, renderer virtualization, Electron process/IPC architecture, durable revision behavior, dependencies, and later-milestone behavior remain unchanged.
