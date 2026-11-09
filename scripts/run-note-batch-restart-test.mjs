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
const first = process.argv.includes("--first");
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
const standalone = process.argv.includes("--standalone") || standaloneUndoFirst;
const target = standalone ? { NOTE_BATCH_RESTART_TARGET: "standalone" } : {};
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
await phase("resume", {
  LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: snapshot,
  ...target,
  ...(absent ? { NOTE_BATCH_RESTART_TAMPER: "absent" } : {}),
  ...(undoFirst || standaloneUndoFirst
    ? { NOTE_BATCH_RESTART_TAMPER: "undo-first" }
    : {}),
  ...(undoDuringCard ? { NOTE_BATCH_RESTART_TAMPER: "undo-during-card" } : {}),
  ...(changed ? { NOTE_BATCH_RESTART_TAMPER: "changed" } : {}),
  ...(undo ? { NOTE_BATCH_RESTART_UNDO: "1" } : {}),
});
await rm(snapshot, { recursive: true, force: true });
const tail = standaloneUndoFirst
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
