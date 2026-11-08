import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, relative, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import {
  WORKFLOW_TEST_DIR,
  WORKFLOW_TEST_FILES_ENV,
  estimateWorkflowFileSeconds,
  listWorkflowTestFiles,
  selectShard,
  shardCheckoutEntries,
} from "./workflow-test-selection.mjs";

// Usage:
//   npm run test:workflow                                  every workflow test
//   npm run test:workflow -- test-workflows/foo.workflow.test.ts [more files]
//   npm run test:workflow -- --shard 2/3                   one third, by run time
//   npm run test:workflow -- --parallel 3                  all three thirds at once
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const args = ["zotero-plugin", "test", "--no-watch"];
const argv = process.argv.slice(2);
const webChatLive = argv.includes("--webchat-live");
const agentLive = argv.includes("--agent-live");
const posix = process.platform !== "win32";

// After the last test reports, Zotero can take more than a minute to quit.
// The result is already known by then, so we stop waiting after this long.
const QUIT_GRACE_MS = 15_000;

// Parallel shards each run in their own folder here, so each has its own
// build, profile and data folder.
const SHARD_ROOT = ".scaffold/shards";

function parseOptions() {
  const files = [];
  let shard = null;
  let parallel = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--webchat-live" || arg === "--agent-live") continue;
    if (arg === "--shard") {
      const match = /^(\d+)\/(\d+)$/.exec(argv[++i] ?? "");
      if (!match) throw new Error("--shard takes the form <index>/<count>");
      shard = { index: Number(match[1]), count: Number(match[2]) };
      continue;
    }
    if (arg === "--parallel") {
      parallel = Number(argv[++i]);
      if (!Number.isInteger(parallel) || parallel < 1)
        throw new Error("--parallel takes a shard count, such as 3");
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    files.push(arg);
  }
  if (shard && parallel) throw new Error("Use --shard or --parallel, not both");
  if ((files.length || shard || parallel) && (webChatLive || agentLive))
    throw new Error("Live runs choose their own tests; drop the file list");

  const all = listWorkflowTestFiles();
  let selected = null;
  if (files.length) {
    selected = files.map((file) => {
      const name = relative(WORKFLOW_TEST_DIR, resolve(file)).replaceAll(
        "\\",
        "/",
      );
      if (!all.includes(name))
        throw new Error(`Not a workflow test file: ${file}`);
      return name;
    });
  }
  const secondsOf = (file) =>
    estimateWorkflowFileSeconds(
      file,
      readFileSync(resolve(WORKFLOW_TEST_DIR, file), "utf8"),
    );
  if (shard)
    selected = selectShard(
      selected ?? all,
      secondsOf,
      shard.index,
      shard.count,
    );
  if (parallel) {
    const pool = selected ?? all;
    return Array.from({ length: parallel }, (_, i) =>
      selectShard(pool, secondsOf, i + 1, parallel),
    ).filter((group) => group.length);
  }
  return [selected];
}

/** A TCP port no one listens on right now, for one test Zotero's HTTP server. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Links every top-level entry of this checkout into `dir`, except .scaffold. */
function prepareShardCheckout(dir) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  }
  for (const entry of shardCheckoutEntries(readdirSync("."))) {
    symlinkSync(resolve(entry), join(dir, entry));
  }
}

// The scaffold colors its output; read the words, not the color codes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

const children = new Set();

function stopChild(child, signal) {
  try {
    if (posix) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

// A detached group does not get the terminal's Ctrl+C, so pass it on.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) stopChild(child, signal);
    process.exitCode = 1;
  });
}

/**
 * Runs the scaffold once in `cwd` and resolves with whether every test passed.
 * `prefix` marks each output line when several runs share the terminal.
 */
function runScaffold({ cwd, files, port, prefix }) {
  const profile = resolve(cwd, ".scaffold/test/profile");
  // Its own process group on POSIX, so stopping it also stops Zotero and Xvfb.
  const child = spawn(command, args, {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    detached: posix,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LLM_FOR_ZOTERO_WORKFLOW_TESTS: "1",
      LLM_FOR_ZOTERO_TEST_HTTP_PORT: String(port),
      // The scaffold's default stops every Zotero on the machine at the end
      // of a run, the user's own and other runs' included. Stop only ours.
      ...(posix && !process.env.ZOTERO_PLUGIN_KILL_COMMAND
        ? { ZOTERO_PLUGIN_KILL_COMMAND: `pkill -9 -f "${profile}" || true` }
        : {}),
      ...(files ? { [WORKFLOW_TEST_FILES_ENV]: JSON.stringify(files) } : {}),
      ...(webChatLive ? { LLM_FOR_ZOTERO_WEBCHAT_LIVE: "1" } : {}),
      ...(agentLive ? { LLM_FOR_ZOTERO_AGENT_LIVE: "1" } : {}),
    },
  });
  children.add(child);

  // The scaffold decides its exit code from the summary line alone, so a run
  // whose Zotero quits before the summary used to pass. We read the output
  // ourselves: any failed test, or no summary at all, fails the run.
  let sawFailure = false;
  let summary = null;
  let quitTimer = null;
  const say = (text) =>
    process.stdout.write(prefix ? `${prefix} ${text}\n` : `${text}\n`);

  function readLine(raw) {
    const line = raw.replace(ANSI, "");
    if (/^\s*✖/.test(line)) sawFailure = true;
    const match = /Test run completed - (\d+) passed(?:, (\d+) failed)?/.exec(
      line,
    );
    if (match) {
      summary = { passed: Number(match[1]), failed: Number(match[2] ?? 0) };
      quitTimer ??= setTimeout(() => {
        say(
          `Zotero did not quit within ${QUIT_GRACE_MS / 1000} s of the last test; stopping it.`,
        );
        stopChild(child, "SIGKILL");
      }, QUIT_GRACE_MS);
    }
  }

  const buffers = new Map();
  const flush = (stream, target, rest) => {
    const lines = ((buffers.get(stream) ?? "") + rest).split("\n");
    buffers.set(stream, lines.pop() ?? "");
    for (const line of lines) {
      if (prefix) target.write(`${prefix} ${line}\n`);
      readLine(line);
    }
  };
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (!prefix) target.write(chunk);
      flush(stream, target, chunk);
    });
  }

  return new Promise((resolveRun) => {
    child.on("error", (error) => {
      say(String(error));
      sawFailure = true;
    });
    // Wait for the child process and its stdio streams to close before
    // settling. Exiting on the earlier "exit" event can tear down the
    // scaffold's esbuild service pipe while it is still draining, which
    // intermittently prints a post-test Go deadlock despite a successful run.
    child.on("close", (code, signal) => {
      children.delete(child);
      if (quitTimer) clearTimeout(quitTimer);
      flush(child.stdout, process.stdout, "\n");
      flush(child.stderr, process.stderr, "\n");
      if (!summary) {
        say(
          signal
            ? `Workflow tests terminated by ${signal} before they finished`
            : "Workflow tests ended without a result summary",
        );
        resolveRun({ ok: false, summary });
        return;
      }
      // Stopped by us after a clean summary counts as a pass.
      const ok =
        summary.failed === 0 && !sawFailure && (signal ? true : code === 0);
      resolveRun({ ok, summary });
    });
  });
}

async function main() {
  let groups;
  try {
    groups = parseOptions();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (groups.length === 1) {
    const [files] = groups;
    if (files)
      console.log(
        `Running ${files.length} workflow test file(s):\n  ${files.join("\n  ")}`,
      );
    const { ok } = await runScaffold({
      cwd: process.cwd(),
      files,
      port: await freePort(),
    });
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const count = groups.length;
  const started = Date.now();
  const runs = [];
  const ports = new Set();
  for (const [i, files] of groups.entries()) {
    const label = `[${i + 1}/${count}]`;
    const cwd = resolve(SHARD_ROOT, String(i + 1));
    prepareShardCheckout(cwd);
    console.log(`${label} ${files.length} file(s): ${files.join(", ")}`);
    let port = await freePort();
    while (ports.has(port)) port = await freePort();
    ports.add(port);
    runs.push(runScaffold({ cwd, files, port, prefix: label }));
  }
  const results = await Promise.all(runs);
  console.log(
    `\nWorkflow shards finished in ${Math.round((Date.now() - started) / 1000)} s:`,
  );
  for (const [i, { ok, summary }] of results.entries())
    console.log(
      `  [${i + 1}/${count}] ${ok ? "passed" : "FAILED"}: ${
        summary
          ? `${summary.passed} passed, ${summary.failed} failed`
          : "no result summary"
      }`,
    );
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}

await main();
