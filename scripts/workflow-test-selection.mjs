import { readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { URL } from "node:url";

// Run only some workflow test files. The scaffold bundles every test under the
// entries folder and lists each one as a <script> in its test page; we drop the
// <script> tags of the files that are not selected, so Zotero never loads them.
// The selection travels from scripts/run-workflow-tests.mjs to the scaffold's
// test:bundleTests hook through this variable, as a JSON list of file paths
// relative to the workflow test folder.
export const WORKFLOW_TEST_FILES_ENV = "LLM_FOR_ZOTERO_WORKFLOW_FILES";
export const WORKFLOW_TEST_DIR = "test-workflows";
export const GENERATED_TEST_PAGE_PATH =
  ".scaffold/test/resource/content/index.xhtml";

// Measured seconds per file, from a CI run. A file it does not list is
// estimated from its number of tests, so a new file still lands somewhere
// sensible; refresh the numbers when the shards drift apart.
const MEASURED_SECONDS = JSON.parse(
  readFileSync(
    new URL("./workflow-test-timings.json", import.meta.url),
    "utf8",
  ),
);
const SECONDS_PER_UNMEASURED_TEST = 2;

const TEST_FILE_PATTERN = /\.(spec|test)\.[jt]s$/;

function toPosix(path) {
  return path.split(sep).join("/");
}

export function listWorkflowTestFiles(dir = WORKFLOW_TEST_DIR) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEST_FILE_PATTERN.test(entry.name))
        files.push(toPosix(relative(dir, path)));
    }
  };
  walk(dir);
  return files.sort();
}

export function estimateWorkflowFileSeconds(
  file,
  source,
  measured = MEASURED_SECONDS,
) {
  if (Object.hasOwn(measured, file)) return measured[file];
  const tests = source.match(/^\s*it\(/gm)?.length ?? 1;
  return tests * SECONDS_PER_UNMEASURED_TEST;
}

/**
 * Splits files into `count` groups of about equal run time and returns group
 * `index` (1-based). Longest file first, each to the lightest group so far;
 * ties keep the alphabetical order, so every shard computes the same split.
 */
export function selectShard(files, secondsOf, index, count) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`Shard count must be a positive integer, got ${count}`);
  if (!Number.isInteger(index) || index < 1 || index > count)
    throw new Error(`Shard index must be between 1 and ${count}, got ${index}`);
  const groups = Array.from({ length: count }, () => ({
    seconds: 0,
    files: [],
  }));
  const ordered = [...files].sort(
    (a, b) => secondsOf(b) - secondsOf(a) || a.localeCompare(b),
  );
  for (const file of ordered) {
    const lightest = groups.reduce((min, group) =>
      group.seconds < min.seconds ? group : min,
    );
    lightest.seconds += secondsOf(file);
    lightest.files.push(file);
  }
  return groups[index - 1].files.sort();
}

/** "foo/bar.workflow.test.ts" -> "units/foo/bar.workflow.test.js" */
export function bundledUnitPath(file) {
  return `units/${file.replace(/\.ts$/, ".js")}`;
}

/** Removes the <script> tag of every bundled test that is not selected. */
export function filterTestPage(source, selectedFiles) {
  const keep = new Set(selectedFiles.map(bundledUnitPath));
  const missing = [...keep].filter(
    (unit) => !source.includes(`<script src="${unit}"></script>`),
  );
  if (missing.length)
    throw new Error(
      `Selected workflow tests were not bundled: ${missing.join(", ")}`,
    );
  return source.replace(
    /^[ \t]*<script src="(units\/[^"]+)"><\/script>\r?\n?/gm,
    (tag, unit) => (keep.has(unit) ? tag : ""),
  );
}

export async function applyWorkflowTestSelection(
  path = GENERATED_TEST_PAGE_PATH,
  env = process.env,
) {
  const raw = env[WORKFLOW_TEST_FILES_ENV];
  if (!raw) return;
  const selected = JSON.parse(raw);
  const source = await readFile(path, "utf8");
  await writeFile(path, filterTestPage(source, selected), "utf8");
}

/**
 * The top-level entries a parallel shard's folder links to: everything but
 * the scaffold's own output, which each shard keeps for itself, and git.
 */
export function shardCheckoutEntries(entries) {
  return entries.filter((entry) => entry !== ".scaffold" && entry !== ".git");
}
