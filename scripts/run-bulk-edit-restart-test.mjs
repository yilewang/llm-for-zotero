import { cp, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// A checkpointed bulk edit stopped in one Zotero process and continued in a
// second one. The scaffold empties its data folder on every run, so the
// first run's stopped database is copied aside and the second run starts
// from that copy (LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT). Each phase runs the whole
// file; W5D_RESTART_PHASE selects the one restart test that runs: the
// workflow file skips every other test while it is set.
//
// With --crash the first Zotero is killed (SIGKILL) between two items of the
// batch instead of stopping it: the first run is then expected to end without
// a result, and the second must find the batch in the journal and finish it.
const crash = process.argv.includes("--crash");
const file = "test-workflows/libraryBulkEdits.workflow.test.ts";
const snapshot = ".scaffold/bulk-edit-restart/data-snapshot";

// The scaffold stops a Zotero that does not quit within 15 s, and the copy
// must not start before that Zotero is gone: a copy taken while it still
// writes can leave the second process a database that blocks its first
// transaction. Waits for every process on the test profile to exit.
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
        env: { ...process.env, ...env, W5D_RESTART_PHASE: name },
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

if (crash) await phase("crash", {}, { expectDeath: true });
else await phase("interrupt");
await waitForTestZotero();
await rm(snapshot, { recursive: true, force: true });
await cp(".scaffold/test/data", snapshot, { recursive: true });
await phase("resume", { LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: snapshot });
await rm(snapshot, { recursive: true, force: true });
console.log(
  crash
    ? "Verified a checkpointed bulk edit across a killed Zotero."
    : "Verified a checkpointed bulk edit across two Zotero processes.",
);
