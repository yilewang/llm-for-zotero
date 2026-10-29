# Manually invoked live-Zotero behavior suite

This is a maintainer-invoked behavior audit, not a release gate.
It runs only when you explicitly invoke it.
Build, test, CI, release, version and publish commands neither invoke it nor inspect its results or their age.
You remain free to release without running it, or after reviewing a failed report.

## Run it

Configure `.env` to point to a disposable profile whose directory name ends in `.zotero-dev` and a data directory named `zotero-dev`.
The runner checks both the launch configuration and the actual running profile before creating fixtures.
Configure `deepseek-v4-flash` with usable credentials in that profile's model preferences.
Live runs send selected paper text and library-search metadata to that provider and consume API usage.
Do not use a dev profile containing material you do not want sent to the configured provider.

```sh
# Inspect the catalog without launching Zotero, writing fixtures or calling a model.
npm run test:behavior -- --list

# Live smoke: 11 checks, including a six-round visible paper conversation.
npm run test:behavior:smoke

# All checks in the current catalog.
npm run test:behavior

# Select a journey or an individual check; required dependencies are included.
npm run test:behavior:smoke -- --select modes.auto.note
npm run test:behavior -- --select paper,library

# Crop-to-note regression with the Geva paper and commentary PDF in zotero-dev.
npm run test:behavior -- --select figures --model deepseek-flash
```

`--model`, `--reasoning`, and `--timeout` are explicit overrides.
The defaults are `deepseek-v4-flash`, `high`, and a six-hour overall deadline.
Ordinary Agent turns have a twelve-minute cancellation deadline.
The runner ends the run as BLOCKED if Zotero quits or stops writing its heartbeat for two minutes.
It also ends the run as BLOCKED if Zotero does not start the suite within ten minutes.
Do not edit/rebuild the plugin or launch another suite while a run is active.
The development launcher watches source changes, and a reload would invalidate the running test.
An already-started request is never silently replayed after a reload.

The command runs `npm run build`, then `npm run start`, using the existing development launcher.
The trigger is compiled out of normal production builds.
The development startup trigger is present only when this command supplies an explicit request file.
The suite uses the real Original Agent and central authorization policy; it does not use mock model responses.
It does not test Claude Code, Codex or WebChat.

## What the catalog covers

| Journey                                  | Main mode                       | Observable acceptance                                                                                                                                                      |
| ---------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paper conversation and research material | Auto                            | Six visible composer turns; one durable child note; a filed standalone note; targeted editing; Obsidian Markdown; real cropped figures where a suitable paper is available |
| Library curation                         | YOLO, with an Auto merge canary | Exact tags; add versus move; collection union without paper loss; metadata; Related links; trash/restore; five real imports                                                |
| Mode conformance                         | Safe / Auto / YOLO              | Read, note, metadata, file, explicit no-write and related-paper review behavior                                                                                            |
| Recovery                                 | Safe / Auto                     | Cancellation without mutations; honest handling of a missing figure                                                                                                        |
| Figure extraction                        | Auto / YOLO                     | Semantic skills before work; real bundled Python crops from the active PDF; native embedded images; crop-only note content; no confirmations or script detours             |

`catalog.ts` is the authoritative list of stable check IDs, dependencies, acceptance statements and evidence types.
`--list` shows the complete selected list and expected mode.

## Evidence and judgments

Evidence is local and Gitignored:

```text
tmp/behavior-reports/<source-fingerprint>/<run-id>/
  request.json               Requested selection and environment, no credentials
  build.json                 Runtime bundle hash, commit, dirty state, Zotero version
  fixtures.json              Exact fixture identities
  run.json                   Per-check results and coverage, including unselected checks
  events.jsonl               Incrementally persisted live tool/confirmation events
  summary.md                 Human-readable result
  manual-review.md           Your quality and computer-use review
  <check-id>/
    before.json / after.json / diff.json
    turn-*.json / turn-*-answer.md
  vault/                     Actual exported Markdown and figure assets
  done.json                  Completion marker and command exit status
```

Native snapshots are reloaded from Zotero, not inferred from the assistant's prose.
They preserve metadata, notes, creators, collections, relations, attachments and trash state across available libraries.
Unordered membership/tag lists are normalized, but creator order is preserved.
Zotero version counters and modification timestamps are excluded from semantic comparisons.
The fixture items and output files remain available for inspection; there is no broad cleanup command or best-effort destructive rollback.
Only suite-owned preference changes are restored at normal completion.
An interrupted process can leave preferences or partial fixture effects behind; inspect the report before starting a fresh run.

| Status                  | Meaning                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `PASS`                  | The selected machine assertions passed; this is not a universal product guarantee          |
| `FAIL`                  | An observed outcome violated an assertion, including unexpected confirmations              |
| `BLOCKED`               | A prerequisite or running environment prevented evaluation                                 |
| `BLOCKED_BY_DEPENDENCY` | An earlier required checkpoint did not succeed                                             |
| `REVIEW_REQUIRED`       | Machine checks passed, but prose quality, relevance or figure quality requires your review |
| `SKIPPED_BY_SELECTION`  | You did not select this check; it is not a pass                                            |

The invoked command exits nonzero for failure or blocking, so shell callers can distinguish unsuccessful execution.
`REVIEW_REQUIRED` alone does not make the command fail, but remains explicit in the report.
No report status controls any release command.

Auto and YOLO confirmations are never blindly approved.
Unexpected cards are cancelled and recorded as failures, while an explicitly cataloged exceptional-risk review may be approved after its proposal and unchanged pre-state are checked.
Approval probes check native state and vault file hashes before approval.
Safe reviews every external write, including new-note creation, before mutation.
Auto runs routine reversible same-library changes directly and reviews cross-library, destructive, ambiguous, and out-of-scope effects.
Verified note creation must produce a saved-note card linking the actual native note.
The cancellation probe proposes a metadata edit.
For note content-review cards, the proposed tool call must target the exact paper and its final content must match the displayed review payload.
Other approval cards must expose their targets.
They then approve the card as the test operator and inspect the resulting state and receipts.
Related-paper discovery expects an import-review card in every mode and cancels it to verify that no import occurs.
That interaction is deliberately distinct from an explicit request to import five papers.

Programmatic screenshots and UI diagnostics are useful evidence, but are not a substitute for computer-use inspection.
The paper journey drives a real visible composer and observes the actual UI-to-Agent request.
It also compares interactive quote citations in a normal chat render, the generated document card and its larger window, including expansion and readable labels.
The synthetic paper has explicitly fictional author-year metadata so this comparison tests author-year citation presentation.
Missing-author fallback labels are a separate product behavior, not evidence of a metadata-complete citation regression.
The remaining probes use the real Agent API, not UI button clicks.

## Extend it without hiding failures

Add a catalog entry, an executable step and an exact-state oracle.
Start with a failing suite/behavior test before implementing a new driver capability.
Use stable fixture names plus the unique run marker, and record exact native identities in the fixture manifest.
Declare real dependencies instead of letting one failed step cause misleading cascades.
Assert required tools, evidence, receipts, final state and meaningful content; do not compare a model's entire answer to a golden string.
Do not relax counts to percentages or approve unexpected prompts to make the suite pass.
Do not fix product bugs inside the test driver.

The legacy `test:agent:live` tests remain available as older specialized tests; they are not evidence from this standardized suite.
Their automatic confirmation handling should not be used to judge Auto/YOLO conformance.

## Explicit coverage limits

The figure journey includes one Auto command probe that writes and runs a temporary Python script to read a crop's dimensions while preserving the image and native Zotero state.
This is evidence for routine intermediate script execution, not general command-execution conformance.
The current live catalog does not yet automate real-process restart/resume, timeout-after-effect retry, stale approval payload edits, duplicate-item merge, or group-library fixture creation.
Existing unit/workflow coverage of those mechanisms is not presented as live-suite coverage.
These need dedicated scenarios before this suite can claim to cover them.
No quality judge is run; you inspect the generated documents yourself.
