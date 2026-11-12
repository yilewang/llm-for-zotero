import { cp, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// A v1 plan-document database upgraded by a real Zotero start. The scaffold
// empties its data folder on every run, so the seed run's database is copied
// aside and the verify run starts from that copy
// (LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT). DOCUMENT_STORE_UPGRADE_PHASE selects
// which test of the workflow file runs.
const file = "test-workflows/documentStoreUpgrade.workflow.test.ts";
const snapshot = ".scaffold/document-store-upgrade/data-snapshot";

// The copy must not start before the seed Zotero is gone: a copy taken while
// it still writes can leave the next process a database that blocks.
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

function phase(name, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/run-workflow-tests.mjs", file],
      {
        stdio: "inherit",
        env: { ...process.env, ...env, DOCUMENT_STORE_UPGRADE_PHASE: name },
      },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)),
    );
  });
}

await phase("seed");
await waitForTestZotero();
await rm(snapshot, { recursive: true, force: true });
await cp(".scaffold/test/data", snapshot, { recursive: true });
await phase("verify", { LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: snapshot });
await rm(snapshot, { recursive: true, force: true });
console.log("Verified a v1 plan-document database upgraded by a Zotero start.");
