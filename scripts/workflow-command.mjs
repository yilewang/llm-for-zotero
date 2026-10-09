import { fileURLToPath, URL } from "node:url";

export function resolveWorkflowScaffoldEntrypoint() {
  return fileURLToPath(new URL("./workflow-scaffold.mjs", import.meta.url));
}

export function createWorkflowTestCommand({
  argv = process.argv,
  env = process.env,
  execPath = process.execPath,
  scaffoldBin = resolveWorkflowScaffoldEntrypoint(),
} = {}) {
  const webChatLive = argv.includes("--webchat-live");
  const agentLive = argv.includes("--agent-live");

  return {
    command: execPath,
    args: [scaffoldBin, "--workflow-child"],
    env: {
      ...env,
      NODE_ENV: "test",
      LLM_FOR_ZOTERO_WORKFLOW_TESTS: "1",
      ...(webChatLive ? { LLM_FOR_ZOTERO_WEBCHAT_LIVE: "1" } : {}),
      ...(agentLive ? { LLM_FOR_ZOTERO_AGENT_LIVE: "1" } : {}),
    },
  };
}
