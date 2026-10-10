# Native Chat memory comparison

This opt-in workload uses a fresh scaffold profile and synthetic PDF/chat fixtures.
It never calls a model provider and never opens the normal Zotero library.
Configure the Zotero binary in `.env` before running it.

```sh
node scripts/measure-chat-memory.mjs baseline 3
# Apply the production change, keeping the measurement workload identical.
node scripts/measure-chat-memory.mjs optimized 3
```

Each run opens and closes one warmup reader, measures eight further reader cycles, then streams 40 ordinary Chat turns of 120 deterministic chunks each.
The runner rejects incomplete workloads and refuses to overwrite an existing run log.
It overrides the scaffold's broad shutdown command so only the process launched by that run is terminated.
Do not run another native suite in the same checkout, edit the measured source, or run heavy jobs during a comparison.

Results are saved under `tmp/issue-469/<label>/`:

- `metadata.json` records the base commit, measured source hash, host, and workload.
- `production.diff` records tracked source changes, including the shared instrumentation.
- `run-N.json` records the built bundle hash, exact memory samples in bytes, panel counts, and rendering measurements.
- `run-N-rss.json` records primary-process resident memory sampled externally every 200 ms.
- `run-N.log` records native workflow execution and failures.

Compare repeated runs using the median and minimum/maximum, including growth from each run's own warm baseline.
Allocated heap, JavaScript GC heap, and resident memory describe different quantities and must be reported separately.
Samples labeled `post-gc` wait for Gecko's memory-minimization callback; samples labeled `pre-gc` do not trigger collection.
The sampled RSS maximum is a lower bound on the true peak, not a continuous profiler measurement.
Resident memory includes Zotero/PDF rendering and native allocations; it is not plugin-exclusive RAM.
Refresh-call timing excludes scheduled rendering work, while frame latency includes scheduling but does not establish compositor completion.
The default native suite separately checks ordinary Chat's rendering and lifecycle invariants in `chatRenderingReuse.workflow.test.ts`.

# Library search latency

This opt-in workload measures how long library retrieval takes on a synthetic library, before and after a production change.
It builds 500 invented papers in a fresh scaffold profile (by default 80 % with a MinerU cache, 20 % plain PDF only), files them into a `Bench` collection and the first 30 into `Bench-30`, and runs 12 fixed queries twice: a cold pass, then a warm pass in the same order.
Cold means no paper text is loaded this session: before every cold query the workload clears the loaded paper text and the retrieval candidate cache (`clearPaperTextCacheForBench`).
The warm pass repeats the same queries without clearing, and each row records `cacheCleared`.
It never calls a model provider and never opens the normal Zotero library.
The workload lives in `test-perf/librarySearch/` because the scaffold treats each test entry as a directory; the runner points the entry at that folder so the chat memory workload does not run with it.
The test skips itself unless `LLM_FOR_ZOTERO_SEARCH_BENCH=1`, which the runner sets.
Configure the Zotero binary in `.env` (or `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`) before running it.

```sh
node scripts/measure-library-search.mjs before 3
# Apply the production change, keeping the measurement workload identical.
node scripts/measure-library-search.mjs after-text 3
node scripts/compare-library-search.mjs before after-text
# A user who never ran MinerU: every paper is a plain PDF.
node scripts/measure-library-search.mjs before-pdf 3 500 1
```

The runner's arguments are `<label> [runs=3] [papers=500] [pdfShare=0.2]`.
`papers` is useful for a quick smoke run; `pdfShare` is the share of papers that are plain PDFs with no MinerU cache (0 to 1), passed to the workload as `LLM_FOR_ZOTERO_SEARCH_BENCH_PDF_SHARE` and recorded in `metadata.json`.
A 500-paper run can take 30 to 60 minutes; start it detached and poll the log.

Results are saved under `tmp/library-search-bench/<label>/`:

- `metadata.json` records the commit, measured source hash, host, and workload.
- `production.diff` records tracked source changes.
- `run-N.json` records per-query elapsed time, retrieval phase timings and counters, corpus build time, index build time and status, and in-process resident memory before and after the index build.
- `run-N-rss.json` records primary-process resident memory sampled externally every 200 ms.
- `run-N.log` records native workflow execution and failures.

`recall@5` is the share of queries whose planted paper is among the top five paper matches, and `snippetHit` is the share whose planted sentence appears in a returned snippet (whitespace collapsed on both sides).
Both are planted-fact hit rates for retrieval; they do not measure LLM answer quality.
The comparison reports medians across runs; the sampled RSS maximum is a lower bound on the true peak.

## Real-library ranking check

The synthetic corpus measures latency, but its planted facts are keyword-exact, so it cannot show how the index ranks real papers.
`scripts/library-index-benchmark.ts` builds the library text index in an in-memory SQLite database from the MinerU caches of a real Zotero data directory, outside Zotero, and compares its ranking with today's per-paper ranking.

```sh
npx tsx scripts/library-index-benchmark.ts --data-dir "$HOME/Zotero" --ids <50+ ids with a MinerU full.md> \
    --queries tmp/real-queries.txt [--expected tmp/real-expected.txt]
```

`--queries` holds one query per line; the optional `--expected` file holds, per query line, the comma-separated attachment ids a reader would accept as the top paper.
Per query it prints the wall time of each path, overlap@8 of (paper, chunk) pairs, the top paper of each path and whether they agree, then a summary line and a Markdown table.
Today's path has no cross-paper full-text score, so the baseline orders every paper's candidates by their per-paper BM25 score; the index scores the same chunks with library-wide document frequencies, which is expected to move the top paper when a term is rare inside one paper but common across the library.
The data directory is read-only: it uses the same copy-on-write overlay as `scripts/retrieval-benchmark.ts` (`installBenchmarkGlobals`).

# Paper switch latency

This opt-in workload measures what happens when you click from one paper to another in the library while the chat pane is open.
It creates two papers in a fresh scaffold profile, seeds each with the same number of chat turns (20 by default), opens the chat pane, and switches between the two papers.
Four warmup switches load both conversations; the measured switches follow.
It never calls a model provider and never opens the normal Zotero library.
The test skips itself unless `LLM_FOR_ZOTERO_PAPER_SWITCH_BENCH=1`, which the runner sets.

```sh
node scripts/measure-paper-switch.mjs before 3
# Apply the production change, keeping the measurement workload identical.
node scripts/measure-paper-switch.mjs after 3
```

The runner's arguments are `<label> [runs=3] [switches=20] [turns=20]`.
Each switch records:

- `selectMs`: how long the `selectItem` call itself blocked;
- `visibleMs`: until the panel shows the other paper's full conversation;
- `settledMs`: until the panel's last change (the panel then stays unchanged for 400 ms);
- `maxFrameGapMs`: the longest gap between animation frames, which is how long the window froze;
- `panelRebuilds`: how many times a new panel root was inserted;
- `chatDraws`: how many times the whole conversation was drawn.

Results are saved under `tmp/paper-switch-bench/<label>/`, with `summary.json` holding the median, minimum and maximum of each value over all runs.
