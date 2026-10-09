import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

// Scaffold 0.8.2 can exit zero when Zotero closes before sending its "end"
// event. Require the terminal reporter summary as well as a successful exit.
// Fail closed if the reporter format changes; never infer completion from
// individual passing tests. Keep only a bounded partial line per output stream.
export function createWorkflowCompletionTracker() {
  const streams = new Map();
  const summaries = [];
  let outputAfterSummary = false;
  const inspect = (line) => {
    const plain = stripVTControlCharacters(line).trim();
    const match = plain.match(
      /^[✔✖]\s+Test run completed - (\d+) passed(?:, (\d+) failed)?$/,
    );
    const benignMetadata =
      plain === 'Native workflow exit: {"code":0,"signal":null}' ||
      plain === "Native workflow runtime version unavailable" ||
      /^Native workflow runtime: (?:unknown|(?:Version|BuildID)=[^,\r\n]+(?:, (?:Version|BuildID)=[^,\r\n]+)*)$/.test(
        plain,
      );
    if (summaries.length && plain && !benignMetadata) {
      outputAfterSummary = true;
    }
    if (match && summaries.length < 2) {
      summaries.push({
        passed: Number(match[1]),
        failed: Number(match[2] ?? 0),
      });
    }
  };
  return {
    write(stream, chunk) {
      const state = streams.get(stream) ?? { text: "", oversized: false };
      for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        const terminated = part.endsWith("\n");
        if (!state.oversized) {
          state.text += part;
          if (state.text.length > 16384) {
            state.text = "";
            state.oversized = true;
          }
        }
        // Discard oversized content, but do not discard evidence after completion.
        if (state.oversized && summaries.length) outputAfterSummary = true;
        if (terminated) {
          if (!state.oversized) inspect(state.text);
          state.text = "";
          state.oversized = false;
        }
      }
      streams.set(stream, state);
    },
    finish() {
      for (const state of streams.values()) {
        if (!state.oversized && state.text) inspect(state.text);
      }
      streams.clear();
      return (
        summaries.length === 1 &&
        !outputAfterSummary &&
        summaries[0].passed > 0 &&
        summaries[0].failed === 0
      );
    },
  };
}

export async function runWorkflowTestProcess(
  { command, args, env },
  {
    stdout = process.stdout,
    stderr = process.stderr,
    signalSource = process,
  } = {},
) {
  const tracker = createWorkflowCompletionTracker();
  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env,
  });
  let spawnFailed = false;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    // Scaffold installs a SIGINT cleanup handler (not SIGTERM). Ask it to
    // close its disposable Zotero instance even when this wrapper gets TERM.
    child.kill("SIGINT");
  };
  signalSource.on("SIGINT", interrupt);
  signalSource.on("SIGTERM", interrupt);
  for (const [name, destination] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    child[name].setEncoding("utf8");
    child[name].on("data", (chunk) => tracker.write(name, chunk));
    child[name].pipe(destination, { end: false });
  }
  return await new Promise((resolve) => {
    child.on("error", (error) => {
      spawnFailed = true;
      stderr.write(`Workflow test process failed: ${error.message}\n`);
    });
    // "close", not "exit": drain both output streams before checking evidence.
    child.on("close", (code, signal) => {
      signalSource.removeListener("SIGINT", interrupt);
      signalSource.removeListener("SIGTERM", interrupt);
      const completed = tracker.finish();
      if (signal) {
        stderr.write(`Workflow tests terminated by ${signal}\n`);
      }
      if (!completed) {
        stderr.write(
          "Workflow tests did not report exactly one successful, nonempty completed run.\n",
        );
      }
      resolve(
        spawnFailed || signal || interrupted
          ? 1
          : !completed
            ? code || 1
            : (code ?? 1),
      );
    });
  });
}
