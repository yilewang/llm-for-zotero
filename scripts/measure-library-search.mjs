// Repeated fresh-profile library search measurements; no provider calls, no user library.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { setInterval, clearInterval } from "node:timers";

const [label, count = "3", papers = "500", pdfShare = "0.2"] =
  process.argv.slice(2);
if (
  !/^[a-z0-9-]+$/.test(label || "") ||
  !/^[1-9][0-9]*$/.test(count) ||
  !/^[1-9][0-9]*$/.test(papers) ||
  !/^(0(\.[0-9]+)?|1(\.0+)?)$/.test(pdfShare)
) {
  throw new Error(
    "Usage: node scripts/measure-library-search.mjs <label> [runs=3] [papers=500] [pdfShare=0.2]",
  );
}
const root = process.cwd();
const output = resolve("tmp/library-search-bench", label);
mkdirSync(output, { recursive: true });
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const hash = createHash("sha256");
for (const file of git(
  "ls-files",
  "src",
  "addon",
  "package-lock.json",
  "test-isolated/perf",
  "test/helpers/syntheticLibraryCorpus.ts",
)
  .split("\n")
  .sort()) {
  hash.update(file).update(readFileSync(file));
}
writeFileSync(
  join(output, "metadata.json"),
  JSON.stringify(
    {
      label,
      papers: Number(papers),
      pdfShare: Number(pdfShare),
      commit: git("rev-parse", "HEAD"),
      sourceSha256: hash.digest("hex"),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0].model,
      totalMemoryBytes: os.totalmem(),
      rssSamplingIntervalMs: 200,
      workload: `${papers} synthetic papers (${Math.round((1 - Number(pdfShare)) * 100)}% MinerU cache, ${Math.round(Number(pdfShare) * 100)}% plain PDF), 12 queries x cold (paper text cache cleared before each) + warm, no model calls`,
    },
    null,
    2,
  ),
);
writeFileSync(
  join(output, "production.diff"),
  git("diff", "--no-ext-diff", "--no-textconv", "--", "src", "addon"),
);

const reportPath = join(root, ".scaffold/test/data/library-search-bench.json");
for (let run = 1; run <= Number(count); run++) {
  const logPath = join(output, `run-${run}.log`);
  if (existsSync(logPath)) throw new Error(`Refusing to overwrite ${logPath}`);
  // Never copy a report left behind by an earlier run.
  rmSync(reportPath, { force: true });
  const startedAt = Date.now();
  console.log(
    `${label} run ${run}/${count} started ${new Date(startedAt).toISOString()}`,
  );
  const child = spawn("npm", ["run", "test:workflow"], {
    cwd: root,
    env: {
      ...process.env,
      ZOTERO_PLUGIN_KILL_COMMAND: "true",
      // The scaffold globs each entry as a directory, so the workload lives
      // in its own folder to keep the other test-isolated/perf workload out of the run.
      LLM_FOR_ZOTERO_TEST_ENTRIES: "test-isolated/perf/librarySearch",
      LLM_FOR_ZOTERO_SEARCH_BENCH: "1",
      LLM_FOR_ZOTERO_SEARCH_BENCH_PAPERS: papers,
      LLM_FOR_ZOTERO_SEARCH_BENCH_LABEL: label,
      LLM_FOR_ZOTERO_SEARCH_BENCH_PDF_SHARE: pdfShare,
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
      for (const line of execFileSync("ps", ["-axo", "pid=,rss=,command="], {
        encoding: "utf8",
      }).split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (
          match &&
          match[3].includes(`-profile ${root}/.scaffold/test/profile`) &&
          match[3].includes("--dataDir")
        ) {
          rssSamples.push({
            atMs: Date.now(),
            rssBytes: Number(match[2]) * 1024,
          });
        }
      }
    } catch {
      /* ps failed; keep sampling */
    }
  }, 200);
  const code = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", resolveExit);
  }).finally(() => clearInterval(timer));
  writeFileSync(logPath, log);
  writeFileSync(
    join(output, `run-${run}-rss.json`),
    JSON.stringify(rssSamples),
  );
  if (code !== 0 || !existsSync(reportPath))
    throw new Error(`run ${run} failed (exit ${code}); see ${logPath}`);
  copyFileSync(reportPath, join(output, `run-${run}.json`));
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  console.log(
    `${label} run ${run} done in ${Math.round((Date.now() - startedAt) / 1000)} s: queries=${report.queries.length}, rssSamples=${rssSamples.length}`,
  );
  if (!report.queries.length || rssSamples.length === 0)
    throw new Error(`Incomplete run; see ${logPath}`);
}
