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
import { readFileMarker, unitStem } from "./workflow-test-file-tracker.mjs";

// Usage:
//   npm run test:workflow                                  every workflow test
//   npm run test:workflow -- test-workflows/foo.workflow.test.ts [more files]
//   npm run test:workflow -- --shard 2/3                   one third, by run time
//   npm run test:workflow -- --parallel 3                  all three thirds at once
//   npm run test:workflow -- --bail                        stop at the first failure
//
// Every selected file runs, even after a failure. At the end the runner lists
// the files that passed, failed, were skipped or never ran, and prints a
// command that reruns only the failed and unrun files.
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const args = ["zotero-plugin", "test", "--no-watch"];
const argv = process.argv.slice(2);
const webChatLive = argv.includes("--webchat-live");
const agentLive = argv.includes("--agent-live");
const bail = argv.includes("--bail");
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
    if (arg === "--webchat-live" || arg === "--agent-live" || arg === "--bail")
      continue;
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
let interrupted = false;

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
    interrupted = true;
    for (const child of children) stopChild(child, signal);
    process.exitCode = 1;
  });
}

/**
 * Runs the scaffold once in `cwd`. Resolves with whether every test passed,
 * the scaffold's summary, and the per-file markers the test page sent.
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
      ...(bail ? { LLM_FOR_ZOTERO_WORKFLOW_BAIL: "1" } : {}),
    },
  });
  children.add(child);

  // The scaffold decides its exit code from the summary line alone, so a run
  // whose Zotero quits before the summary used to pass. We read the output
  // ourselves: any failed test, or no summary at all, fails the run.
  let sawFailure = false;
  let summary = null;
  let quitTimer = null;
  const markers = [];
  const say = (text) =>
    process.stdout.write(prefix ? `${prefix} ${text}\n` : `${text}\n`);

  // Returns whether the line is for the terminal; markers are for us only.
  function readLine(raw) {
    const line = raw.replace(ANSI, "");
    const marker = readFileMarker(line);
    if (marker) {
      markers.push(marker);
      return false;
    }
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
    return true;
  }

  const buffers = new Map();
  const flush = (stream, target, rest) => {
    const lines = ((buffers.get(stream) ?? "") + rest).split("\n");
    buffers.set(stream, lines.pop() ?? "");
    for (const line of lines) {
      if (readLine(line))
        target.write(prefix ? `${prefix} ${line}\n` : `${line}\n`);
    }
  };
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => flush(stream, target, chunk));
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
        resolveRun({ ok: false, summary, markers, signal, code });
        return;
      }
      // Stopped by us after a clean summary counts as a pass.
      const ok =
        summary.failed === 0 && !sawFailure && (signal ? true : code === 0);
      resolveRun({ ok, summary, markers, signal, code });
    });
  });
}

// The folder the scaffold bundles tests from, as zotero-plugin.config.ts
// picks it; the per-file report names files relative to it.
const ENTRIES_DIR =
  process.env.LLM_FOR_ZOTERO_TEST_ENTRIES ||
  (agentLive
    ? "test-live/agent"
    : webChatLive
      ? "test-live/webchat"
      : WORKFLOW_TEST_DIR);

const newFileResult = () => ({
  planned: null,
  started: false,
  passed: 0,
  failures: [],
  crashed: null,
});

/**
 * Runs `files` (null: every file) until each one has run. If Zotero stops
 * before the end, the file it was running counts as failed and a fresh Zotero
 * runs the files that had not started yet. --bail and Ctrl+C never restart.
 */
async function runGroup({ cwd, files, port, prefix }) {
  const all = files ?? listWorkflowTestFiles(ENTRIES_DIR);
  const results = new Map(all.map((file) => [file, newFileResult()]));
  const byStem = new Map(all.map((file) => [unitStem(file), file]));
  const say = (text) =>
    process.stdout.write(prefix ? `${prefix} ${text}\n` : `${text}\n`);
  let selection = files;
  let ok = true;
  for (;;) {
    const run = await runScaffold({ cwd, files: selection, port, prefix });
    ok &&= run.ok;
    const startedNow = new Set();
    for (const marker of run.markers) {
      if (marker.event === "plan") {
        for (const [unit, count] of Object.entries(marker.planned)) {
          const file = byStem.get(unitStem(unit)) ?? unitStem(unit);
          if (!results.has(file)) results.set(file, newFileResult());
          results.get(file).planned = count;
        }
        continue;
      }
      const file = marker.unit
        ? (byStem.get(unitStem(marker.unit)) ?? unitStem(marker.unit))
        : "(outside any test file)";
      if (!results.has(file)) results.set(file, newFileResult());
      const result = results.get(file);
      if (marker.event === "start") {
        result.started = true;
        startedNow.add(file);
      } else if (marker.event === "end") startedNow.delete(file);
      else if (marker.event === "pass") result.passed++;
      else if (marker.event === "fail") {
        result.started = true;
        result.failures.push({ title: marker.title, message: marker.message });
      }
    }
    if (run.summary) break;

    // Zotero stopped mid-run: whatever was running did not finish.
    const how = run.signal
      ? `terminated by ${run.signal}`
      : `exited with code ${run.code}`;
    for (const file of startedNow) {
      results.get(file).crashed = `Zotero ${how} while this file ran`;
    }
    const remaining = [...results.keys()].filter(
      (file) => all.includes(file) && !results.get(file).started,
    );
    if (bail || interrupted || !startedNow.size || !remaining.length) break;
    say(
      `Restarting Zotero for the ${remaining.length} file(s) that have not run yet.`,
    );
    selection = remaining;
  }
  return { ok, results };
}

function classify(results) {
  const groups = { passed: [], failed: [], skipped: [], notRun: [] };
  for (const [file, result] of results) {
    if (result.failures.length || result.crashed) groups.failed.push(file);
    else if (result.passed) groups.passed.push(file);
    // A file with tests that never started: the run stopped before it.
    else if (!result.started && result.planned !== 0) groups.notRun.push(file);
    else groups.skipped.push(file);
  }
  return groups;
}

const MAX_FAILURES_SHOWN = 3;

function printReport(results) {
  const { passed, failed, skipped, notRun } = classify(results);
  const total = results.size;
  console.log(
    `\nWorkflow files: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped, ${notRun.length} not run (of ${total}).`,
  );
  if (failed.length) {
    console.log("\nFailed:");
    for (const file of failed) {
      const { failures, crashed } = results.get(file);
      console.log(`  ${file}`);
      for (const failure of failures.slice(0, MAX_FAILURES_SHOWN))
        console.log(`    ✖ ${failure.title}: ${failure.message}`);
      if (failures.length > MAX_FAILURES_SHOWN)
        console.log(
          `    … ${failures.length - MAX_FAILURES_SHOWN} more failure(s)`,
        );
      if (crashed) console.log(`    ✖ ${crashed}`);
    }
  }
  if (skipped.length) {
    console.log("\nSkipped (every test pending, or no tests):");
    for (const file of skipped) console.log(`  ${file}`);
  }
  if (notRun.length) {
    console.log("\nNot run (the run stopped before them):");
    for (const file of notRun) console.log(`  ${file}`);
  }
  const known = new Set(listWorkflowTestFiles(ENTRIES_DIR));
  const rerun = [...failed, ...notRun].filter((file) => known.has(file));
  if (rerun.length && ENTRIES_DIR === WORKFLOW_TEST_DIR) {
    console.log(
      `\nRerun ${failed.length && notRun.length ? "the failed and unrun" : failed.length ? "the failed" : "the unrun"} files in a fresh Zotero:`,
    );
    console.log(
      `  npm run test:workflow -- ${rerun
        .map((file) => `${WORKFLOW_TEST_DIR}/${file}`)
        .join(" ")}`,
    );
  }
  return failed.length + notRun.length;
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
    const { ok, results } = await runGroup({
      cwd: process.cwd(),
      files,
      port: await freePort(),
    });
    const bad = printReport(results);
    process.exitCode = ok && !bad ? 0 : 1;
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
    runs.push(runGroup({ cwd, files, port, prefix: label }));
  }
  const shards = await Promise.all(runs);
  console.log(
    `\nWorkflow shards finished in ${Math.round((Date.now() - started) / 1000)} s:`,
  );
  for (const [i, { ok }] of shards.entries())
    console.log(`  [${i + 1}/${count}] ${ok ? "passed" : "FAILED"}`);
  const merged = new Map(shards.flatMap(({ results }) => [...results]));
  const bad = printReport(merged);
  process.exitCode = shards.every((shard) => shard.ok) && !bad ? 0 : 1;
}

await main();
