import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const args = ["zotero-plugin", "test", "--no-watch", "--abort-on-fail"];
const webChatLive = process.argv.includes("--webchat-live");
const agentLive = process.argv.includes("--agent-live");

const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    LLM_FOR_ZOTERO_WORKFLOW_TESTS: "1",
    ...(webChatLive ? { LLM_FOR_ZOTERO_WEBCHAT_LIVE: "1" } : {}),
    ...(agentLive ? { LLM_FOR_ZOTERO_AGENT_LIVE: "1" } : {}),
  },
});

// Wait for the child process and its inherited stdio streams to close before
// allowing this wrapper to finish. Exiting on the earlier "exit" event can
// tear down the scaffold's esbuild service pipe while it is still draining,
// which intermittently prints a post-test Go deadlock despite a successful run.
child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Workflow tests terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
