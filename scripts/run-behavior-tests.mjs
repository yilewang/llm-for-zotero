import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout } from "node:timers";
import { tsImport } from "tsx/esm/api";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const { catalog, selectSteps } = await tsImport(
  "../test-behavior/catalog.ts",
  import.meta.url,
);
const args = process.argv.slice(2);
const options = {
  tier: "full",
  select: [],
  model: "deepseek-v4-flash",
  reasoning: "high",
  collection: "Representation_Drift",
  timeout: 21600,
};
let list = false;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--list") {
    list = true;
    continue;
  }
  if (
    ![
      "--tier",
      "--select",
      "--model",
      "--reasoning",
      "--collection",
      "--timeout",
    ].includes(flag) ||
    !args[i + 1] ||
    args[i + 1].startsWith("--")
  )
    throw new Error(`Unknown or incomplete option: ${flag}`);
  const value = args[++i];
  if (flag === "--select") options.select.push(...value.split(","));
  else if (flag === "--timeout") options.timeout = Number(value);
  else options[flag.slice(2)] = value;
}
if (!Number.isFinite(options.timeout) || options.timeout < 30)
  throw new Error("--timeout must be at least 30 seconds");
const selected = selectSteps(options.tier, options.select);
if (list) {
  for (const row of selected)
    console.log(`${row.id} [${row.mode}] ${row.acceptance}`);
  console.log(
    `Selected ${selected.length}/${catalog.length}. This command does not launch Zotero or call a model.`,
  );
} else {
  // Only this explicit command sets the startup trigger. No release/build hook
  // depends on its presence, report status, or report age.
  try {
    process.loadEnvFile(path.join(root, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const profile = process.env.ZOTERO_PLUGIN_PROFILE_PATH?.trim();
  const data = process.env.ZOTERO_PLUGIN_DATA_DIR?.trim();
  if (
    !profile ||
    !data ||
    !path.basename(profile).endsWith(".zotero-dev") ||
    path.basename(data) !== "zotero-dev"
  )
    throw new Error(
      "Refusing to run: .env must explicitly select a .zotero-dev profile and zotero-dev data directory.",
    );
  const git = (...argv) =>
    execFileSync("git", argv, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  const commit = git("rev-parse", "HEAD");
  const status = git("status", "--porcelain=v1");
  const sourceHash = createHash("sha256").update(git("diff", "HEAD", "--"));
  for (const file of git("ls-files", "--others", "--exclude-standard")
    .split("\n")
    .filter(Boolean)
    .sort())
    sourceHash.update(file).update(await readFile(path.join(root, file)));
  const fingerprint = `${commit.slice(0, 12)}-${sourceHash.digest("hex").slice(0, 12)}`;
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const reportDir = path.join(
    root,
    "tmp",
    "behavior-reports",
    fingerprint,
    runId,
  );
  await mkdir(reportDir, { recursive: true });
  const requestPath = path.join(reportDir, "request.json");
  const request = {
    schemaVersion: 1,
    runId,
    reportDir,
    root,
    ...options,
    selectedIds: selected.map((row) => row.id),
    commit,
    dirty: Boolean(status),
    sourceStatus: status,
    fingerprint,
    profile,
    data,
    platform: process.platform,
    createdAt: new Date().toISOString(),
  };
  await writeFile(requestPath, JSON.stringify(request, null, 2));
  console.log(
    `Manual live behavior run: ${runId}\nReport: ${reportDir}\nSelected: ${selected.length}/${catalog.length}; ${options.model}, ${options.reasoning} reasoning.\nOnly zotero-dev will be used. Fixtures and artifacts are retained for inspection.`,
  );
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (argv, env) =>
    new Promise((resolve, reject) => {
      const child = spawn(npm, argv, { cwd: root, stdio: "inherit", env });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`npm ${argv.join(" ")} exited ${code}`)),
      );
    });
  await run(["run", "build"], {
    ...process.env,
    LLM_FOR_ZOTERO_BEHAVIOR_REQUEST: "",
  });
  const child = spawn(npm, ["run", "start"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      LLM_FOR_ZOTERO_BEHAVIOR_REQUEST: requestPath,
      LLM_FOR_ZOTERO_LIVE_MODEL: options.model,
      LLM_FOR_ZOTERO_LIVE_REASONING: options.reasoning,
    },
  });
  let launchError;
  let closed = false;
  child.once("error", (error) => {
    launchError = error;
  });
  child.once("close", () => {
    closed = true;
  });
  let stopping = false;
  const stop = () => {
    stopping = true;
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const deadline = Date.now() + options.timeout * 1000;
  try {
    while (Date.now() < deadline && !stopping) {
      if (launchError) throw launchError;
      try {
        const done = JSON.parse(
          await readFile(path.join(reportDir, "done.json"), "utf8"),
        );
        console.log(
          `\n${await readFile(path.join(reportDir, "summary.md"), "utf8")}`,
        );
        process.exitCode = done.exitCode;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (closed)
        throw new Error(
          "Zotero launcher closed before a completed report was written",
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!(await stat(path.join(reportDir, "done.json")).catch(() => null)))
      throw new Error(
        stopping
          ? "Interrupted by operator"
          : "Runner deadline exceeded; inspect partial evidence",
      );
  } catch (error) {
    await writeFile(
      path.join(reportDir, "runner-error.json"),
      JSON.stringify(
        {
          status: "BLOCKED",
          error: error.message,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
