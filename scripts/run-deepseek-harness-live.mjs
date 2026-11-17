import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
mkdirSync(new URL("tmp/", root), { recursive: true });
const child = spawn(
  process.execPath,
  ["scripts/run-workflow-tests.mjs", "--agent-live"],
  {
    cwd: fileURLToPath(root),
    stdio: "inherit",
    env: {
      ...process.env,
      ZOTERO_PLUGIN_KILL_COMMAND:
        process.env.ZOTERO_PLUGIN_KILL_COMMAND || "true",
      LLM_FOR_ZOTERO_TEST_ENTRIES: "test-live/deepseekHarness",
      LLM_FOR_ZOTERO_LIVE_MODEL:
        process.env.LLM_FOR_ZOTERO_LIVE_MODEL || "deepseek-flash",
      LLM_FOR_ZOTERO_HARNESS_NODE: process.execPath,
      LLM_FOR_ZOTERO_HARNESS_WORKER: fileURLToPath(
        new URL("integrations/deepseek-harness/worker.mjs", root),
      ),
      LLM_FOR_ZOTERO_HARNESS_REPORT: fileURLToPath(
        new URL("tmp/deepseek-harness-provider-b.json", root),
      ),
    },
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
