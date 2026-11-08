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

await phase(quit ? "quit" : "crash", {}, { expectDeath: true });
await waitForTestZotero();
await rm(snapshot, { recursive: true, force: true });
await cp(".scaffold/test/data", snapshot, { recursive: true });
await phase("resume", { LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: snapshot });
await rm(snapshot, { recursive: true, force: true });
console.log(
  quit
    ? "Verified a note batch across a force-quit Zotero."
    : "Verified a note batch across a killed Zotero.",
);
