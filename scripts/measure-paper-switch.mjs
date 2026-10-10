// Repeated fresh-profile measurements of switching papers in the library side
// panel; no provider calls, no user library.
import { spawn, execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";

const [label, count = "3", switches = "20", turns = "20"] =
  process.argv.slice(2);
if (
  !/^[a-z0-9-]+$/.test(label || "") ||
  !/^[1-9][0-9]*$/.test(count) ||
  !/^[1-9][0-9]*$/.test(switches) ||
  !/^[1-9][0-9]*$/.test(turns)
) {
  throw new Error(
    "Usage: node scripts/measure-paper-switch.mjs <label> [runs=3] [switches=20] [turns=20]",
  );
}
const root = process.cwd();
const output = resolve("tmp/paper-switch-bench", label);
mkdirSync(output, { recursive: true });
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
writeFileSync(
  join(output, "metadata.json"),
  JSON.stringify(
    {
      label,
      commit: git("rev-parse", "HEAD"),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0].model,
      workload: `2 papers x ${turns} seeded turns, ${switches} measured switches after 4 warmup switches, no model calls`,
    },
    null,
    2,
  ),
);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
};

const reportPath = join(root, ".scaffold/test/data/paper-switch-bench.json");
const all = [];
for (let run = 1; run <= Number(count); run++) {
  const logPath = join(output, `run-${run}.log`);
  if (existsSync(logPath)) throw new Error(`Refusing to overwrite ${logPath}`);
  rmSync(reportPath, { force: true });
  console.log(`${label} run ${run}/${count} started`);
  const child = spawn("npm", ["run", "test:workflow"], {
    cwd: root,
    env: {
      ...process.env,
      ZOTERO_PLUGIN_KILL_COMMAND: "true",
      LLM_FOR_ZOTERO_TEST_ENTRIES: "test-perf/paperSwitch",
      LLM_FOR_ZOTERO_PAPER_SWITCH_BENCH: "1",
      LLM_FOR_ZOTERO_PAPER_SWITCH_BENCH_SWITCHES: switches,
      LLM_FOR_ZOTERO_PAPER_SWITCH_BENCH_TURNS: turns,
      LLM_FOR_ZOTERO_PAPER_SWITCH_BENCH_LABEL: label,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const code = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", resolveExit);
  });
  writeFileSync(logPath, log);
  if (code !== 0 || !existsSync(reportPath))
    throw new Error(`run ${run} failed (exit ${code}); see ${logPath}`);
  copyFileSync(reportPath, join(output, `run-${run}.json`));
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.samples.length !== Number(switches))
    throw new Error(`Incomplete run; see ${logPath}`);
  all.push(...report.samples);
}

const summary = {};
for (const key of [
  "selectMs",
  "visibleMs",
  "settledMs",
  "maxFrameGapMs",
  "panelRebuilds",
  "chatDraws",
]) {
  const values = all.map((sample) => sample[key]);
  summary[key] = {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`${label}: ${all.length} switches`);
console.table(summary);
