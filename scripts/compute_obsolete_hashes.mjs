#!/usr/bin/env node
/**
 * Check the upgrade fingerprints of the built-in skills against git history.
 *
 * For every text of `src/agent/skills/<name>.md` in the history of a `v*`
 * release tag or of HEAD, compute the three hashes `initUserSkills` compares:
 *   - raw:       djb2 of the file as shipped (the legacy flat copy);
 *   - canonical: djb2 of the shipped file with the native `name:` line that
 *                `ensureNativeSkillName` inserts into a canonical copy;
 *   - body:      `hashSkillForUpgrade` (managed block, else the instruction
 *                body), the value the plugin stores after it writes a file.
 * The current text (the working tree's and HEAD's) is shipped, not previous,
 * and is not required. Any other hash that src/agent/skills/
 * builtinSkillHashes.ts does not list is MISSING, and the script exits 1.
 * It also exits 1 when the clone has no `v*` tag, since it then cannot see
 * what shipped. `npm test` and `npm run release` run it.
 *
 * Usage: npx tsx scripts/compute_obsolete_hashes.mjs [options] [file.md ...]
 *   --emit        write the missing hashes, with comments, into the module
 *   --verbose     print every text with its hashes and origin
 *   --all-refs    also read texts that only unmerged branches hold
 *   --skip-on-ci  do nothing when CI is set (the release runner publishes an
 *                 already tagged commit; the check ran before tagging)
 *
 * The obsolete files' raw hashes (OBSOLETE_SKILL_FILES in userSkills.ts)
 * come from the same `git show <sha>:<path>` texts: pass a retired file's
 * old path with --verbose to print them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import {
  BUILTIN_BOOTSTRAP_BODY_HASHES,
  BUILTIN_BOOTSTRAP_RAW_HASHES,
} from "../src/agent/skills/builtinSkillHashes.ts";
import { parseSkill } from "../src/agent/skills/skillLoader.ts";
import {
  hashBody,
  hashSkillForUpgrade,
} from "../src/agent/skills/managedBlock.ts";

const SKILLS_DIR = "src/agent/skills";
const HASH_MODULE = `${SKILLS_DIR}/builtinSkillHashes.ts`;
const args = process.argv.slice(2);
const allRefs = args.includes("--all-refs");
const emit = args.includes("--emit");
const verbose = args.includes("--verbose");
const requested = args.filter((arg) => !arg.startsWith("--"));

if (args.includes("--skip-on-ci") && process.env.CI) {
  console.log("Built-in skill hash check skipped on CI.");
  process.exit(0);
}

function git(...gitArgs) {
  return execFileSync("git", gitArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitShow(revision, path) {
  try {
    return git("show", `${revision}:${path}`);
  } catch {
    return null; // the revision does not hold the file
  }
}

function lines(text) {
  return text.split("\n").filter(Boolean);
}

function withNativeName(raw, id) {
  if (/^name:\s*.+$/m.test(raw)) return null;
  const rows = raw.split("\n");
  const start = rows.findIndex((line) => line.trim() === "---");
  if (start < 0) return null;
  rows.splice(start + 1, 0, `name: ${id}`);
  return rows.join("\n");
}

function compareTags(a, b) {
  const parse = (tag) =>
    tag
      .replace(/^v\.?/, "")
      .split(/[.-]/)
      .map((part) => Number(part) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** Where a text shipped: the release tags that hold it, or its commits. */
function describeOrigin(tags, shas, released) {
  if (tags.length) {
    const sorted = [...tags].sort(compareTags);
    const range =
      sorted.length === 1
        ? sorted[0]
        : `${sorted[0]}–${sorted[sorted.length - 1]}`;
    return `as released in ${range} (${shas.join(", ")})`;
  }
  if (!emit && !verbose) return `at ${shas.join(", ")}`; // tags not read
  return shas.some((sha) => released.has(sha))
    ? `at ${shas.join(", ")}, between releases`
    : `at ${shas.join(", ")}, not yet released`;
}

/** Insert entries before a list's closing bracket, or add the list. */
function insertEntries(source, listName, key, entryLines) {
  const start = source.indexOf(`export const ${listName}`);
  const end = source.indexOf("\n};", start);
  if (start < 0 || end < 0) throw new Error(`${listName} not found`);
  const keyAt = source.indexOf(`\n  "${key}": [`, start);
  const body = entryLines.map((line) => `    ${line}`).join("\n");
  if (keyAt >= 0 && keyAt < end) {
    const close = source.indexOf("\n  ],", keyAt);
    return `${source.slice(0, close)}\n${body}${source.slice(close)}`;
  }
  return `${source.slice(0, end)}\n  "${key}": [\n${body}\n  ],${source.slice(end)}`;
}

const releaseTags = lines(git("tag", "-l", "v*")).sort(compareTags);
if (!releaseTags.length) {
  console.error(
    "No v* release tag in this clone, so the shipped texts are unknown. Fetch the tags (git fetch --tags) and rerun.",
  );
  process.exit(1);
}
const released = new Set(
  lines(git("rev-list", ...releaseTags)).map((sha) => sha.slice(0, 8)),
);
const revisions = allRefs ? ["--all"] : [...releaseTags, "HEAD"];
const listed = {
  raw: BUILTIN_BOOTSTRAP_RAW_HASHES,
  body: BUILTIN_BOOTSTRAP_BODY_HASHES,
};
const isListed = (kind, key, hash) =>
  Boolean(listed[kind][key]?.includes(hash));
const files = requested.length
  ? requested
  : readdirSync(SKILLS_DIR).filter((file) => file.endsWith(".md"));
let moduleSource = emit ? readFileSync(HASH_MODULE, "utf8") : "";
let missingCount = 0;
let textCount = 0;

for (const filename of files) {
  const path = filename.includes("/") ? filename : `${SKILLS_DIR}/${filename}`;
  const key = path.split("/").pop();
  let workingTree = null;
  try {
    workingTree = readFileSync(path, "utf8");
  } catch {
    /* a retired file: every text is historical */
  }
  // The shipped text is current, not previous: neither the working tree's
  // nor HEAD's copy needs a list entry.
  const current = new Set([workingTree, gitShow("HEAD", path)]);
  const currentBodies = new Set(
    [...current]
      .filter((raw) => raw !== null)
      .map((raw) => hashSkillForUpgrade(raw, parseSkill(raw).instruction)),
  );

  // Tags whose copy of the file is each text, so a comment can name the
  // releases that shipped it. The plain check skips this slow pass.
  const tagsByText = new Map();
  for (const tag of emit || verbose ? releaseTags : []) {
    const raw = gitShow(tag, path);
    if (raw !== null)
      tagsByText.set(raw, [...(tagsByText.get(raw) || []), tag]);
  }
  const texts = new Map();
  for (const sha of lines(
    git("log", ...revisions, "--format=%H", "--", path),
  ).reverse()) {
    const raw = gitShow(sha, path);
    if (raw !== null) {
      texts.set(raw, [...(texts.get(raw) || []), sha.slice(0, 8)]);
    }
  }

  const rawEntries = [];
  const bodyEntries = new Map();
  if (verbose) console.log(`\n== ${key}`);
  for (const [raw, shas] of texts) {
    if (current.has(raw)) continue;
    textCount++;
    const skill = parseSkill(raw);
    const origin = describeOrigin(tagsByText.get(raw) || [], shas, released);
    const rawHash = hashBody(raw);
    const named = withNativeName(raw, skill.id);
    const namedHash = named === null ? null : hashBody(named);
    const bodyHash = hashSkillForUpgrade(raw, skill.instruction);
    const rawMissing = [rawHash, namedHash].filter(
      (hash) => hash !== null && !isListed("raw", key, hash),
    );
    const bodyMissing =
      !currentBodies.has(bodyHash) && !isListed("body", key, bodyHash);
    if (rawMissing.length) {
      const variants = [
        rawMissing.includes(rawHash) ? "shipped" : null,
        rawMissing.includes(namedHash) ? "canonical" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      rawEntries.push(
        `// v${skill.version} ${origin}, ${variants}.`,
        ...rawMissing.map((hash) => `"${hash}",`),
      );
    }
    if (bodyMissing) {
      const entry = bodyEntries.get(bodyHash) || {
        version: skill.version,
        origins: [],
      };
      entry.origins.push(origin);
      bodyEntries.set(bodyHash, entry);
    }
    missingCount += rawMissing.length + (bodyMissing ? 1 : 0);
    const mark = (hash, missing) => (missing ? `${hash} MISSING` : hash);
    const row = [
      `v${skill.version}`,
      `raw ${mark(rawHash, rawMissing.includes(rawHash))}`,
      namedHash === null
        ? "canonical (has name:)"
        : `canonical ${mark(namedHash, rawMissing.includes(namedHash))}`,
      `body ${currentBodies.has(bodyHash) ? `${bodyHash} (current)` : mark(bodyHash, bodyMissing)}`,
      origin,
    ].join(" | ");
    if (verbose) console.log(row);
    else if (rawMissing.length || bodyMissing) console.log(`${key}: ${row}`);
  }
  if (emit && rawEntries.length) {
    moduleSource = insertEntries(
      moduleSource,
      "BUILTIN_BOOTSTRAP_RAW_HASHES",
      key,
      rawEntries,
    );
  }
  if (emit && bodyEntries.size) {
    const entryLines = [];
    for (const [hash, { version, origins }] of bodyEntries) {
      entryLines.push(`// v${version} ${origins.join("; ")}.`, `"${hash}",`);
    }
    moduleSource = insertEntries(
      moduleSource,
      "BUILTIN_BOOTSTRAP_BODY_HASHES",
      key,
      entryLines,
    );
  }
}

console.log(
  `Built-in skill hashes: ${textCount} previous texts of ${files.length} skills checked against ${releaseTags.length} v* tags (newest ${releaseTags[releaseTags.length - 1]}) and HEAD.`,
);
if (emit && missingCount) {
  writeFileSync(HASH_MODULE, moduleSource);
  console.log(
    `Wrote ${missingCount} missing hash(es) to ${HASH_MODULE}; run prettier on it and review the comments.`,
  );
} else if (missingCount) {
  console.error(
    `${missingCount} shipped hash(es) missing from ${HASH_MODULE}. Run this script with --emit to add them.`,
  );
  process.exitCode = 1;
}
