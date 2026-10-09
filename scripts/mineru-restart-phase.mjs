import { createWorkflowTestCommand } from "./workflow-command.mjs";
import { runWorkflowTestProcess } from "./workflow-process.mjs";

export async function runMineruRestartPhase(
  name,
  { env = process.env, command, run = runWorkflowTestProcess } = {},
) {
  const exitCode = await run(command ?? createWorkflowTestCommand({ env }));
  if (exitCode !== 0) throw new Error(`${name} exited ${exitCode}`);
}
