/**
 * DB upgrade test: does a database written by an older build (default:
 * `main`) open correctly in a newer one (default: this checkout's HEAD)?
 *
 * Upgrade (default):
 *   1. Creates one temporary worktree W at the older commit (always the same
 *      absolute path, because the profile path is part of the conversation
 *      identity and the Claude Code working directory).
 *   2. SEED: runs test-db-upgrade/seed.workflow.test.ts on the older build.
 *      Live turns: upstream 3, Claude Code 2, Codex 2.
 *   3. Copies W's scaffold data directory and profile prefs.js aside.
 *   4. Checks W out at the newer commit, in place.
 *   5. VERIFY: runs test-db-upgrade/verify.workflow.test.ts on the newer
 *      build against those copies (LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT and
 *      LLM_FOR_ZOTERO_PROFILE_PREFS_SNAPSHOT), with the Zotero debug store on
 *      so the test can read the startup log. Live turns: one per system.
 *   6. With --reverse: checks W out at the older commit again and reopens the
 *      DB the newer build wrote (read-only checks, no model calls).
 *   7. Removes W (unless --keep).
 *
 * The test files are copied from this checkout into W/.scaffold/db-upgrade
 * (ignored by git), so both builds run the same tests. When a commit's
 * zotero-plugin.config.ts lacks the prefs-snapshot hook, the runner adds it
 * as an uncommitted change in W for that phase and reverts it afterwards.
 *
 *   LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-flash \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js with that model> \
 *   LLM_FOR_ZOTERO_LIVE_CODEX_PATH=<codex binary> \
 *   node scripts/run-db-upgrade-tests.mjs [--from main] [--to HEAD] [--reverse] [--keep] [--worktree <path>]
 *
 * Rerun only the verify phase in a W kept with --keep, at any commit, on the
 * same seed snapshot (for comparing builds without seeding again):
 *
 *   node scripts/run-db-upgrade-tests.mjs --rerun-verify <ref> [--worktree <path>]
 *
 * Real profile copy (--real-profile, read-only, no model calls): copies a
 * Zotero DB file (default ~/Zotero/zotero.sqlite.bak, Zotero's own
 * consistent backup) into a scratch directory outside any git tree, counts
 * each conversation's rows with node:sqlite, starts this checkout's build on
 * the copy, and compares (test-db-upgrade/realProfile.workflow.test.ts).
 * Prints only counts and pass/fail. Deletes the copy afterwards.
 *
 *   node scripts/run-db-upgrade-tests.mjs --real-profile --scratch <dir> [--source <zotero.sqlite>]
 *
 * Every Zotero this script starts is killed with a command scoped to that
 * run's own test profile; the scaffold's default kill command is never used.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const options = {
  from: "main",
  to: "HEAD",
  reverse: false,
  keep: false,
  worktree: "",
  realProfile: false,
  scratch: "",
  source: path.join(os.homedir(), "Zotero", "zotero.sqlite.bak"),
  rerunVerify: "",
};
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--reverse") options.reverse = true;
  else if (flag === "--keep") options.keep = true;
  else if (flag === "--real-profile") options.realProfile = true;
  else if (flag === "--rerun-verify" && args[i + 1])
    options.rerunVerify = args[++i];
  else if (
    ["--from", "--to", "--worktree", "--scratch", "--source"].includes(flag) &&
    args[i + 1] &&
    !args[i + 1].startsWith("--")
  )
    options[flag.slice(2)] = args[++i];
  else throw new Error(`Unknown or incomplete option: ${flag}`);
}

const git = (cwd, ...argv) =>
  execFileSync("git", ["-C", cwd, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const PREFS_HOOK_MARKER = "LLM_FOR_ZOTERO_PROFILE_PREFS_SNAPSHOT";
const PREFS_HOOK_ANCHOR = `"test:init": async () => {`;
const PREFS_HOOK_PATCH = `
        // Added by scripts/run-db-upgrade-tests.mjs for this run only.
        if (process.env.${PREFS_HOOK_MARKER}) {
          await cp(
            process.env.${PREFS_HOOK_MARKER},
            ".scaffold/test/profile/prefs.js",
          );
        }`;
/** Prefs a phase adds so its test can read the startup log. */
const DEBUG_STORE_PREFS = [
  `user_pref("extensions.zotero.debug.store", true);`,
  `user_pref("extensions.zotero.debug.level", 3);`,
  `user_pref("extensions.zotero.debug.store.limit", 2000000);`,
  `user_pref("extensions.zotero.llmforzotero.logLevel", "info");`,
].join("\n");

const killCommandFor = (checkout) =>
  `pkill -9 -f "${path.join(checkout, ".scaffold", "test", "profile")}" || true`;

/** Copies the phase test and the helpers it imports into checkout/.scaffold. */
async function stageTests(checkout, treeName, testFile) {
  const tree = path.join(checkout, ".scaffold", "db-upgrade", treeName);
  await rm(tree, { recursive: true, force: true });
  const files = [
    `test-db-upgrade/${testFile}`,
    "test-db-upgrade/dbUpgradeShared.ts",
    "test-live-runtimes/runtimeLiveShared.ts",
    "test-live-agent/liveAgentCredentials.ts",
  ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(tree, file)), { recursive: true });
    await cp(path.join(root, file), path.join(tree, file));
  }
  return path.relative(checkout, path.join(tree, "test-db-upgrade"));
}

/** Adds the prefs-snapshot hook to a checkout's config when it lacks it. */
async function ensurePrefsHook(checkout) {
  const configPath = path.join(checkout, "zotero-plugin.config.ts");
  const config = await readFile(configPath, "utf8");
  if (config.includes(PREFS_HOOK_MARKER)) return false;
  if (!config.includes(PREFS_HOOK_ANCHOR))
    throw new Error(`Cannot add the prefs hook to ${configPath}`);
  await writeFile(
    configPath,
    config.replace(PREFS_HOOK_ANCHOR, PREFS_HOOK_ANCHOR + PREFS_HOOK_PATCH),
  );
  return true;
}

async function revertPrefsHook(checkout, patched) {
  if (patched) git(checkout, "checkout", "--", "zotero-plugin.config.ts");
}

function runPhase(checkout, label, entries, extraEnv) {
  console.log(
    `\n=== ${label} (${git(checkout, "rev-parse", "--short", "HEAD")}) ===`,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "test:workflow"],
      {
        cwd: checkout,
        stdio: "inherit",
        env: {
          ...process.env,
          ...extraEnv,
          LLM_FOR_ZOTERO_TEST_ENTRIES: entries,
          ZOTERO_PLUGIN_KILL_COMMAND: killCommandFor(checkout),
        },
      },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`)),
    );
  });
}

async function printReport(checkout, phase) {
  const file = path.join(
    checkout,
    ".scaffold",
    "test",
    "data",
    `llm-db-upgrade-report-${phase}.json`,
  );
  if (existsSync(file))
    console.log(`\n${phase} report:\n${await readFile(file, "utf8")}`);
}

/** Copies the stopped run's data directory and prefs.js aside. */
async function snapshotRun(checkout, name) {
  const dir = path.join(checkout, ".scaffold", "db-upgrade", name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(
    path.join(checkout, ".scaffold", "test", "data"),
    path.join(dir, "data"),
    { recursive: true },
  );
  const prefs = path.join(dir, "prefs.js");
  await cp(
    path.join(checkout, ".scaffold", "test", "profile", "prefs.js"),
    prefs,
  );
  await appendFile(prefs, `\n${DEBUG_STORE_PREFS}\n`);
  return { data: path.join(dir, "data"), prefs };
}

function countPendingDeletions(sqlitePath) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM llm_for_zotero_pending_deletions")
        .get().n,
    );
  } catch {
    return -1;
  } finally {
    db.close();
  }
}

async function prepareCheckout(checkout) {
  await symlink(
    realpathSync(path.join(root, "node_modules")),
    path.join(checkout, "node_modules"),
  );
  if (existsSync(path.join(root, ".env")))
    await cp(path.join(root, ".env"), path.join(checkout, ".env"));
  const cache = path.join(root, ".scaffold", "cache");
  if (existsSync(cache))
    await cp(cache, path.join(checkout, ".scaffold", "cache"), {
      recursive: true,
    });
}

function requireLiveEnv() {
  for (const name of [
    "LLM_FOR_ZOTERO_LIVE_PROFILE_PATH",
    "LLM_FOR_ZOTERO_LIVE_CODEX_PATH",
  ])
    if (!process.env[name]) throw new Error(`${name} must be set`);
}

function checkoutPath() {
  const commonDir = path.resolve(
    root,
    git(root, "rev-parse", "--git-common-dir"),
  );
  return path.resolve(
    options.worktree ||
      path.join(
        path.dirname(commonDir),
        ".claude",
        "worktrees",
        "db-upgrade-tmp",
      ),
  );
}

/**
 * Reruns only the verify phase in a kept W (--keep), at any commit, against
 * the seed snapshot W already holds; for comparing the two builds on the
 * same seeded DB. W is kept.
 */
async function rerunVerify() {
  requireLiveEnv();
  const checkout = checkoutPath();
  const snapshot = path.join(checkout, ".scaffold", "db-upgrade", "after-seed");
  if (!existsSync(path.join(snapshot, "data")))
    throw new Error(`${snapshot} has no seed snapshot; run with --keep first`);
  const sha = git(root, "rev-parse", options.rerunVerify);
  git(checkout, "checkout", "--detach", sha);
  const patched = await ensurePrefsHook(checkout);
  const entries = await stageTests(
    checkout,
    "verify",
    "verify.workflow.test.ts",
  );
  try {
    await runPhase(checkout, "VERIFY rerun", entries, {
      LLM_FOR_ZOTERO_DB_UPGRADE_PHASE: "verify",
      LLM_FOR_ZOTERO_DB_UPGRADE_COMMIT: sha,
      LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: path.join(snapshot, "data"),
      LLM_FOR_ZOTERO_PROFILE_PREFS_SNAPSHOT: path.join(snapshot, "prefs.js"),
    });
  } finally {
    await printReport(checkout, "verify");
    await revertPrefsHook(checkout, patched);
    console.log(`Kept ${checkout}`);
  }
}

async function runUpgrade() {
  requireLiveEnv();
  const fromSha = git(root, "rev-parse", options.from);
  const toSha = git(root, "rev-parse", options.to);
  const checkout = checkoutPath();
  if (existsSync(checkout))
    throw new Error(`${checkout} already exists; remove it or pass --worktree`);
  console.log(
    `DB upgrade: ${fromSha.slice(0, 8)} -> ${toSha.slice(0, 8)} in ${checkout}`,
  );
  git(root, "worktree", "add", "--detach", checkout, fromSha);
  let failed = null;
  try {
    await prepareCheckout(checkout);

    const seedEntries = await stageTests(
      checkout,
      "seed",
      "seed.workflow.test.ts",
    );
    await runPhase(checkout, "SEED on the older build", seedEntries, {
      LLM_FOR_ZOTERO_DB_UPGRADE_PHASE: "seed",
      LLM_FOR_ZOTERO_DB_UPGRADE_COMMIT: fromSha,
    });
    const seed = await snapshotRun(checkout, "after-seed");
    const pending = countPendingDeletions(
      path.join(seed.data, "zotero.sqlite"),
    );
    console.log(
      `Pending deletion rows in the seeded DB: ${pending} (2 expected; fewer means one finalized before Zotero quit, so the startup sweep was not exercised for it)`,
    );

    git(checkout, "checkout", "--detach", toSha);
    let patched = await ensurePrefsHook(checkout);
    const verifyEntries = await stageTests(
      checkout,
      "verify",
      "verify.workflow.test.ts",
    );
    try {
      await runPhase(checkout, "VERIFY on the newer build", verifyEntries, {
        LLM_FOR_ZOTERO_DB_UPGRADE_PHASE: "verify",
        LLM_FOR_ZOTERO_DB_UPGRADE_COMMIT: toSha,
        LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: seed.data,
        LLM_FOR_ZOTERO_PROFILE_PREFS_SNAPSHOT: seed.prefs,
      });
    } finally {
      await printReport(checkout, "verify");
      await revertPrefsHook(checkout, patched);
    }

    if (options.reverse) {
      const verified = await snapshotRun(checkout, "after-verify");
      git(checkout, "checkout", "--detach", fromSha);
      patched = await ensurePrefsHook(checkout);
      const reverseEntries = await stageTests(
        checkout,
        "reverse",
        "verify.workflow.test.ts",
      );
      try {
        await runPhase(
          checkout,
          "REVERSE: the older build on the newer DB",
          reverseEntries,
          {
            LLM_FOR_ZOTERO_DB_UPGRADE_PHASE: "reverse",
            LLM_FOR_ZOTERO_DB_UPGRADE_COMMIT: fromSha,
            LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: verified.data,
            LLM_FOR_ZOTERO_PROFILE_PREFS_SNAPSHOT: verified.prefs,
          },
        );
      } finally {
        await printReport(checkout, "reverse");
        await revertPrefsHook(checkout, patched);
      }
    }
    console.log("\nDB upgrade test passed.");
  } catch (error) {
    failed = error;
  } finally {
    if (options.keep) console.log(`Kept ${checkout}`);
    else {
      try {
        git(root, "worktree", "remove", "--force", checkout);
      } catch (error) {
        console.error(`Could not remove ${checkout}: ${error.message}`);
      }
    }
  }
  if (failed) throw failed;
}

/** Row counts of every plugin conversation, keyed by `system:key`. */
function countConversationRows(sqlitePath) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  const count = (table, where, params) =>
    tables.has(table)
      ? Number(
          db
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
            .get(...params).n,
        )
      : 0;
  const stores = [
    {
      system: "upstream",
      catalogs: [
        "llm_for_zotero_global_conversations",
        "llm_for_zotero_paper_conversations",
      ],
      messages: "llm_for_zotero_chat_messages",
    },
    {
      system: "claude_code",
      catalogs: ["llm_for_zotero_claude_conversations"],
      messages: "llm_for_zotero_claude_messages",
    },
    {
      system: "codex",
      catalogs: ["llm_for_zotero_codex_conversations"],
      messages: "llm_for_zotero_codex_messages",
    },
  ];
  const pending = new Set(
    tables.has("llm_for_zotero_pending_deletions")
      ? db
          .prepare(
            "SELECT conversation_key AS k FROM llm_for_zotero_pending_deletions",
          )
          .all()
          .map((row) => Number(row.k))
      : [],
  );
  const conversations = {};
  try {
    for (const store of stores) {
      for (const catalog of store.catalogs) {
        if (!tables.has(catalog)) continue;
        for (const row of db
          .prepare(`SELECT conversation_key AS k FROM ${catalog}`)
          .all()) {
          const key = Number(row.k);
          conversations[`${store.system}:${key}`] = {
            system: store.system,
            key,
            pendingDeletion: pending.has(key),
            catalogRows: store.catalogs.reduce(
              (sum, table) => sum + count(table, "conversation_key = ?", [key]),
              0,
            ),
            messageRows: count(store.messages, "conversation_key = ?", [key]),
            searchIndexRows: count(
              "llm_for_zotero_conversation_search_index",
              "system = ? AND legacy_conversation_key = ?",
              [store.system, key],
            ),
            registryRows: count(
              "llm_for_zotero_conversation_registry",
              "system = ? AND legacy_conversation_key = ?",
              [store.system, key],
            ),
          };
        }
      }
    }
  } finally {
    db.close();
  }
  return conversations;
}

async function runRealProfile() {
  if (!options.scratch) throw new Error("--real-profile needs --scratch <dir>");
  const scratchRoot = path.resolve(options.scratch);
  await mkdir(scratchRoot, { recursive: true });
  let insideGit = true;
  try {
    git(scratchRoot, "rev-parse", "--is-inside-work-tree");
  } catch {
    insideGit = false;
  }
  if (insideGit) throw new Error(`${scratchRoot} is inside a git tree`);
  const source = path.resolve(options.source);
  await stat(source);
  const work = path.join(scratchRoot, `real-db-${Date.now()}`);
  const data = path.join(work, "data");
  await mkdir(data, { recursive: true });
  let failed = null;
  try {
    // Only the copy is ever opened; the source file is read once by cp.
    await cp(source, path.join(data, "zotero.sqlite"));
    const before = countConversationRows(path.join(data, "zotero.sqlite"));
    const expectedPath = path.join(work, "expected.json");
    const resultPath = path.join(work, "result.json");
    await writeFile(expectedPath, JSON.stringify({ conversations: before }));
    const prefs = path.join(work, "prefs.js");
    await writeFile(
      prefs,
      [
        DEBUG_STORE_PREFS,
        `user_pref("extensions.zotero.llmforzotero.enableClaudeCodeMode", true);`,
        `user_pref("extensions.zotero.llmforzotero.enableCodexAppServerMode", true);`,
        "",
      ].join("\n"),
    );
    const systems = {};
    for (const entry of Object.values(before))
      systems[entry.system] = (systems[entry.system] || 0) + 1;
    console.log(`Conversations in the copy: ${JSON.stringify(systems)}`);
    const entries = await stageTests(
      root,
      "real-profile",
      "realProfile.workflow.test.ts",
    );
    // This checkout is the user's own; never patch its config here.
    const config = await readFile(
      path.join(root, "zotero-plugin.config.ts"),
      "utf8",
    );
    if (!config.includes(PREFS_HOOK_MARKER))
      throw new Error(
        "This checkout's zotero-plugin.config.ts lacks the prefs-snapshot hook",
      );
    try {
      await runPhase(root, "REAL PROFILE COPY on this build", entries, {
        LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT: data,
        LLM_FOR_ZOTERO_PROFILE_PREFS_SNAPSHOT: prefs,
        LLM_FOR_ZOTERO_REAL_PROFILE_EXPECTED: expectedPath,
        LLM_FOR_ZOTERO_REAL_PROFILE_RESULT: resultPath,
      });
    } catch (error) {
      failed = error;
    }
    if (existsSync(resultPath))
      console.log(
        `\nReal profile result (counts only):\n${await readFile(resultPath, "utf8")}`,
      );
    console.log(
      failed ? "\nReal profile check FAILED." : "\nReal profile check passed.",
    );
  } finally {
    await rm(work, { recursive: true, force: true });
    // The scaffold's own data directory now holds a copy of the DB as well.
    await rm(path.join(root, ".scaffold", "test", "data"), {
      recursive: true,
      force: true,
    });
    const left = existsSync(work) ? await readdir(work) : [];
    console.log(
      `Deleted the DB copies${left.length ? " (some files remain!)" : ""}.`,
    );
  }
  if (failed) throw failed;
}

try {
  if (options.realProfile) await runRealProfile();
  else if (options.rerunVerify) await rerunVerify();
  else await runUpgrade();
} catch (error) {
  console.error(String(error?.message || error));
  process.exitCode = 1;
}
