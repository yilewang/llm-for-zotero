import { cp, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// A note batch cut short by the end of one Zotero process and continued in a
// second one. The scaffold empties its data folder on every run, so the
// first run's database is copied aside and the second run starts from that
// copy (LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT). NOTE_BATCH_RESTART_PHASE selects
// the test that runs: the first Zotero ends while the batch writes (SIGKILL
// of its own process id with the default, a forced quit with --quit), so
// that phase is expected to exit without a pass.
const quit = process.argv.includes("--quit");
// --first ends the first Zotero while its first note is written, before any
// row of the batch names a written note.
const first =
  process.argv.includes("--first") ||
  process.argv.includes("--legacy-first-unlanded");
// --absent erases and --changed trashes the note the first Zotero was writing
// when it ended, before "continue"; --undo undoes the batch's action after
// it finishes. Each runs on the killed-process data.
const absent = process.argv.includes("--absent");
const changed = process.argv.includes("--changed");
const undo = process.argv.includes("--undo");
// --undo-first undoes the interrupted batch before "continue".
const undoFirst = process.argv.includes("--undo-first");
// --undo-during-card continues in Safe mode and undoes the interrupted batch
// while the confirmation card is pending.
const undoDuringCard = process.argv.includes("--undo-during-card");
// --standalone writes standalone notes that cite their papers, and edits
// the in-flight note's cited paper before "continue";
// --standalone-undo-first undoes that batch before "continue" instead.
const standaloneUndoFirst = process.argv.includes("--standalone-undo-first");
// --standalone-moved takes the in-flight standalone note out of its folder
// before "continue".
const standaloneMoved = process.argv.includes("--standalone-moved");
// --undo-first-absent undoes the interrupted batch and then erases the note
// in flight before "continue", so the undone action's open step holds
// nothing.
const undoFirstAbsent = process.argv.includes("--undo-first-absent");
// --applied-unsaved sets the last landed row back to pending, as a process
// that ended after the note's step was applied and before its row was
// saved leaves it; --applied-unsaved-undo also undoes the batch first.
const appliedUnsavedUndo = process.argv.includes("--applied-unsaved-undo");
const appliedUnsaved =
  process.argv.includes("--applied-unsaved") || appliedUnsavedUndo;
// --retry sends a new batch over the papers left instead of continuing.
// --retry-crash-original kills that retry batch too (a third Zotero), then
// continues the original batch; --retry-applied-unsaved also sets the
// retry's last landed row back to pending before that.
const retryAppliedUnsaved = process.argv.includes("--retry-applied-unsaved");
const retryCrashOriginal = process.argv.includes("--retry-crash-original");
const retryCrash = retryCrashOriginal || retryAppliedUnsaved;
const retry = process.argv.includes("--retry") || retryCrash;
// Pre-upgrade data: before "continue", the resume phase rewrites the journal
// and the rows to the shape the build before the per-row resume left (no
// `batchItem` in create_note steps; unwritten rows name no action).
// --legacy continues a child batch, --legacy-standalone a standalone one,
// --legacy-standalone-edited a standalone one whose in-flight note cites a
// paper edited before "continue", --legacy-undo-first a child batch undone
// before "continue", and --legacy-twice a batch with two notes on each
// paper, ended during a paper's second note, whose first note the user
// erased. --legacy --first ends the first Zotero during its first note, so
// no row names any action; --legacy-unnamed-action undoes the first
// attempt and leaves the note in flight under a second action that no row
// names, as a pre-upgrade "continue" left it. --legacy-first-unlanded is
// --legacy --first with the first note erased, so it never landed. --legacy-standalone-edited
// then erases the note and continues a second time.
const legacyStandaloneEdited = process.argv.includes(
  "--legacy-standalone-edited",
);
const legacyStandalone =
  process.argv.includes("--legacy-standalone") || legacyStandaloneEdited;
const legacyTwice = process.argv.includes("--legacy-twice");
const legacyUndoFirst = process.argv.includes("--legacy-undo-first");
const legacyUnnamedAction = process.argv.includes("--legacy-unnamed-action");
const legacyFirstUnlanded = process.argv.includes("--legacy-first-unlanded");
const legacy =
  process.argv.includes("--legacy") ||
  legacyFirstUnlanded ||
  legacyStandalone ||
  legacyTwice ||
  legacyUndoFirst ||
  legacyUnnamedAction;
const standalone =
  process.argv.includes("--standalone") ||
  standaloneUndoFirst ||
  standaloneMoved ||
  legacyStandalone;
const target = {
  ...(standalone ? { NOTE_BATCH_RESTART_TARGET: "standalone" } : {}),
  ...(legacyTwice ? { NOTE_BATCH_RESTART_NOTES_PER_PAPER: "2" } : {}),
};
const file = "test-workflows/noteBatchRestart.workflow.test.ts";
const snapshot = ".scaffold/note-batch-restart/data-snapshot";

// The copy must not start before the first Zotero is gone: a copy taken
// while it still writes can leave the second process a database that blocks.
async function waitForTestZotero() {
  if (process.platform === "win32") return;
  const profile = resolve(".scaffold/test/profile");
  for (let waited = 0; waited < 60; waited += 1) {
    const running = spawnSync("pgrep", ["-f", profile]).status === 0;
    if (!running) break;
    await sleep(1000);
  }
  await sleep(1000);
}

function phase(name, env = {}, { expectDeath = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/run-workflow-tests.mjs", file],
      {
        stdio: "inherit",
        env: { ...process.env, ...env, NOTE_BATCH_RESTART_PHASE: name },
      },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 || expectDeath
        ? resolve()
        : reject(new Error(`${name} exited ${code}`)),
    );
  });
}

await phase(
  quit ? "quit" : "crash",
  { ...target, ...(first ? { NOTE_BATCH_RESTART_KILL_AFTER: "1" } : {}) },
  { expectDeath: true },
);
await waitForTestZotero();
await rm(snapshot, { recursive: true, force: true });
await cp(".scaffold/test/data", snapshot, { recursive: true });
if (retryCrash) {
  // A third Zotero: the second one sends the retry batch and is killed
  // while it writes, from the first one's data.
  await phase(
    "retry-crash",
    { LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: snapshot, ...target },
    { expectDeath: true },
  );
  await waitForTestZotero();
  await rm(snapshot, { recursive: true, force: true });
  await cp(".scaffold/test/data", snapshot, { recursive: true });
}
await phase("resume", {
  LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: snapshot,
  ...target,
  ...(absent ? { NOTE_BATCH_RESTART_TAMPER: "absent" } : {}),
  ...(undoFirst || standaloneUndoFirst
    ? { NOTE_BATCH_RESTART_TAMPER: "undo-first" }
    : {}),
  ...(undoDuringCard ? { NOTE_BATCH_RESTART_TAMPER: "undo-during-card" } : {}),
  ...(changed ? { NOTE_BATCH_RESTART_TAMPER: "changed" } : {}),
  ...(standaloneMoved ? { NOTE_BATCH_RESTART_TAMPER: "moved" } : {}),
  ...(undoFirstAbsent
    ? { NOTE_BATCH_RESTART_TAMPER: "undo-first-absent" }
    : {}),
  ...(appliedUnsaved
    ? {
        NOTE_BATCH_RESTART_TAMPER: appliedUnsavedUndo
          ? "applied-unsaved-undo"
          : "applied-unsaved",
      }
    : {}),
  ...(retry
    ? {
        NOTE_BATCH_RESTART_TAMPER: retryCrashOriginal
          ? "retry-crash-original"
          : retryAppliedUnsaved
            ? "retry-applied-unsaved"
            : "retry",
      }
    : {}),
  ...(legacy
    ? {
        NOTE_BATCH_RESTART_TAMPER: legacyStandaloneEdited
          ? "legacy-edited"
          : legacyTwice
            ? "legacy-twice"
            : legacyUndoFirst
              ? "legacy-undo-first"
              : legacyFirstUnlanded
                ? "legacy-first-unlanded"
                : legacyUnnamedAction
                  ? "legacy-unnamed-action"
                  : first
                    ? "legacy-first"
                    : "legacy",
      }
    : {}),
  ...(undo ? { NOTE_BATCH_RESTART_UNDO: "1" } : {}),
});
await rm(snapshot, { recursive: true, force: true });
const tail = legacy
  ? ` from pre-upgrade data${
      legacyStandaloneEdited
        ? " of standalone notes, with a cited paper edited, then erased"
        : legacyStandalone
          ? " of standalone notes"
          : legacyTwice
            ? " with two notes on each paper, one erased"
            : legacyUndoFirst
              ? ", undone before it continued"
              : legacyFirstUnlanded
                ? ", ended before its first note landed"
                : legacyUnnamedAction
                  ? ", undone, with the note in flight under an action no row names"
                  : first
                    ? ", ended during its first note"
                    : ""
    }`
  : retryCrashOriginal
    ? ", retried by a new batch that was killed too, then continued"
    : retryAppliedUnsaved
      ? ", retried by a new batch that was killed too, with a landed note's row unsaved, then continued"
      : retry
        ? ", retried by a new batch"
        : appliedUnsavedUndo
          ? ", with a landed note's row unsaved, undone before it continued"
          : appliedUnsaved
            ? ", with a landed note's row unsaved"
            : undoFirstAbsent
              ? ", undone, with the in-flight note erased"
              : standaloneMoved
                ? " of standalone notes, with the in-flight note moved out of its folder"
                : standaloneUndoFirst
                  ? " of standalone notes, undone before it continued"
                  : standalone
                    ? " of standalone notes, with a cited paper edited"
                    : undoDuringCard
                      ? ", undone while its continue card was open"
                      : undoFirst
                        ? ", undone before it continued"
                        : absent
                          ? ", with the in-flight note erased"
                          : changed
                            ? ", with the in-flight note trashed"
                            : undo
                              ? ", then undone"
                              : first
                                ? ", ended during its first note"
                                : "";
console.log(
  `Verified a note batch across a ${quit ? "force-quit" : "killed"} Zotero${tail}.`,
);
