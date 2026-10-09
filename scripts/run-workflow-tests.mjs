import { createWorkflowTestCommand } from "./workflow-command.mjs";
import { runWorkflowTestProcess } from "./workflow-process.mjs";

process.exitCode = await runWorkflowTestProcess(createWorkflowTestCommand());
