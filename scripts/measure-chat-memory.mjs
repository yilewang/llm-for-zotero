// Repeated fresh-profile native measurements; no provider calls or user-library access.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { setInterval, clearInterval } from "node:timers";

const [label, count = "3"] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label || "") || !/^[1-9][0-9]*$/.test(count)) {
  throw new Error(
    "Usage: node scripts/measure-chat-memory.mjs <label> [runs=3]",
  );
}
const root = process.cwd();
const output = resolve("tmp/issue-469", label);
mkdirSync(output, { recursive: true });
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sourceFiles = git("ls-files", "src", "addon", "package-lock.json").split(
  "\n",
);
sourceFiles.push(
  "src/modules/contextPanel/chatMemoryReplay.ts",
  "test-isolated/perf/chatMemory.workflow.test.ts",
);
const hash = createHash("sha256");
for (const file of [...new Set(sourceFiles)].sort())
  hash.update(file).update(readFileSync(file));
const metadata = {
  label,
  commit: git("rev-parse", "HEAD"),
  sourceSha256: hash.digest("hex"),
  platform: os.platform(),
  release: os.release(),
  arch: os.arch(),
  cpu: os.cpus()[0].model,
  totalMemoryBytes: os.totalmem(),
  workload:
    "8 reader open/close cycles, 40 ordinary Chat turns x 120 chunks, after one reader warmup",
  rssSamplingIntervalMs: 200,
  measurementBoundary:
    "RSS samples cover the primary Zotero process only; frame timings include scheduling but not compositor completion.",
};
writeFileSync(join(output, "metadata.json"), JSON.stringify(metadata, null, 2));
writeFileSync(
  join(output, "production.diff"),
  git("diff", "--no-ext-diff", "--no-textconv", "--", "src", "addon"),
);
for (let run = 1; run <= Number(count); run++) {
  const logPath = join(output, `run-${run}.log`);
  if (existsSync(logPath)) throw new Error(`Refusing to overwrite ${logPath}`);
  const startedAt = new Date().toISOString();
  console.log(`${label} run ${run}/${count} started ${startedAt}`);
  const child = spawn("npm", ["run", "test:workflow"], {
    cwd: root,
    env: {
      ...process.env,
      ZOTERO_PLUGIN_KILL_COMMAND: "true",
      LLM_FOR_ZOTERO_TEST_ENTRIES: "test-isolated/perf",
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
  const rssSamples = [];
  const timer = setInterval(() => {
    try {
      const lines = execFileSync("ps", ["-axo", "pid=,rss=,command="], {
        encoding: "utf8",
      }).split("\n");
      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (
          !match ||
          !match[3].startsWith(
            "/Applications/Zotero.app/Contents/MacOS/zotero ",
          )
        )
          continue;
        if (
          !match[3].includes(
            `-profile ${root}/.scaffold/test/profile --dataDir`,
          )
        )
          continue;
        rssSamples.push({
          time: Date.now(),
          pid: Number(match[1]),
          residentBytes: Number(match[2]) * 1024,
        });
      }
    } catch {
      /* Process may exit between samples; retain every successful sample. */
    }
  }, metadata.rssSamplingIntervalMs);
  const code = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", resolveExit);
  }).finally(() => clearInterval(timer));
  writeFileSync(logPath, log);
  writeFileSync(
    join(output, `run-${run}-rss.json`),
    JSON.stringify(rssSamples),
  );
  const reportPath = join(root, ".scaffold/test/data/chat-memory.json");
  const report = existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, "utf8"))
    : null;
  const result = {
    ...metadata,
    run,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: code,
    buildSha256: createHash("sha256")
      .update(
        readFileSync(".scaffold/build/addon/content/scripts/llmforzotero.js"),
      )
      .digest("hex"),
    sampledPeakResidentBytes: rssSamples.length
      ? Math.max(...rssSamples.map((s) => s.residentBytes))
      : null,
    report,
  };
  writeFileSync(
    join(output, `run-${run}.json`),
    JSON.stringify(result, null, 2),
  );
  console.log(
    `${label} run ${run} finished: exit=${code}, samples=${rssSamples.length}, turns=${report?.turns.length ?? 0}`,
  );
  if (code !== 0 || report?.turns.length !== 40 || rssSamples.length === 0)
    throw new Error(`Incomplete run; see ${logPath}`);
}
