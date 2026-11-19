import { assert } from "chai";
import { buildCodexLaunchInvocation } from "../src/utils/codexAppServerProcess";
import { resolveRealPath } from "../src/utils/geckoFs";
import { loadGeckoSubprocess } from "../src/utils/geckoSubprocess";
import {
  getRuntimeCpuArch,
  getRuntimePlatformInfo,
} from "../src/utils/runtimePlatform";

/**
 * npm installs `codex` as a Node script (@openai/codex/bin/codex.js) that
 * replaces itself with the native binary through `process.execve`. A Node
 * process that Zotero started is killed (SIGKILL) at that execve, so on macOS
 * and Linux the app server must start the package's native binary directly,
 * with the environment the script would give it.
 */
describe("workflow: Codex installed with npm", function () {
  this.timeout(30000);

  const info = getRuntimePlatformInfo();
  const arch = getRuntimeCpuArch();
  const triple =
    arch &&
    (info.platform === "macos"
      ? `${arch}-apple-darwin`
      : `${arch}-unknown-linux-musl`);
  const platformPackage = `codex-${info.platform === "macos" ? "darwin" : "linux"}-${arch === "aarch64" ? "arm64" : "x64"}`;
  let root = "";

  async function run(command: string, args: string[]) {
    const Subprocess = await loadGeckoSubprocess();
    const proc = await Subprocess.call({ command, arguments: args });
    const result = await proc.wait?.();
    assert.equal(result?.exitCode, 0, `${command} ${args.join(" ")}`);
  }

  async function writeFile(path: string, text: string, mode = 0o644) {
    await IOUtils.makeDirectory(PathUtils.parent(path)!, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.writeUTF8(path, text);
    await IOUtils.setPermissions(path, mode);
  }

  /** An npm global prefix: bin/codex links to the package's bin/codex.js. */
  async function installNpmCodex(nativeAt: "nested" | "hoisted" | "none") {
    const lib = PathUtils.join(root, "lib", "node_modules", "@openai");
    const packageRoot = PathUtils.join(lib, "codex");
    await writeFile(
      PathUtils.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }),
    );
    await writeFile(
      PathUtils.join(packageRoot, "bin", "codex.js"),
      "#!/usr/bin/env node\n",
      0o755,
    );
    await IOUtils.makeDirectory(PathUtils.join(root, "bin"), {
      ignoreExisting: true,
    });
    const link = PathUtils.join(root, "bin", "codex");
    await run("/bin/ln", [
      "-s",
      "../lib/node_modules/@openai/codex/bin/codex.js",
      link,
    ]);
    let native = "";
    if (nativeAt !== "none") {
      const packageDir =
        nativeAt === "nested"
          ? PathUtils.join(
              packageRoot,
              "node_modules",
              "@openai",
              platformPackage,
            )
          : PathUtils.join(lib, platformPackage);
      native = PathUtils.join(packageDir, "vendor", triple!, "bin", "codex");
      await writeFile(native, "#!/bin/sh\n", 0o755);
    }
    return { link, packageRoot, native };
  }

  beforeEach(async function () {
    if (info.platform === "windows" || !triple) this.skip();
    root = PathUtils.join(
      PathUtils.tempDir,
      `llm-codex-npm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await IOUtils.makeDirectory(root, { createAncestors: true });
  });

  afterEach(async function () {
    if (root)
      await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
    root = "";
  });

  for (const nativeAt of ["nested", "hoisted"] as const) {
    it(`starts the native binary of a ${nativeAt} platform package, not the Node script`, async function () {
      const { link, packageRoot, native } = await installNpmCodex(nativeAt);
      const invocation = await buildCodexLaunchInvocation(link, info);
      assert.equal(invocation.command, resolveRealPath(native));
      assert.deepEqual(invocation.args, ["app-server"]);
      assert.equal(
        invocation.environment?.CODEX_MANAGED_PACKAGE_ROOT,
        resolveRealPath(packageRoot),
      );
      assert.equal(invocation.environment?.CODEX_MANAGED_BY_NPM, "1");
      assert.include(
        (invocation.environment?.PATH || "").split(":"),
        PathUtils.join(root, "bin"),
        "PATH keeps the directory codex was found in (its node)",
      );
    });
  }

  it("keeps the Node script when the platform package is missing, so its own error shows", async function () {
    const { link } = await installNpmCodex("none");
    const invocation = await buildCodexLaunchInvocation(link, info);
    assert.equal(invocation.command, link);
    assert.deepEqual(invocation.args, ["app-server"]);
  });

  it("starts a native codex as it is", async function () {
    const native = PathUtils.join(root, "bin", "codex");
    await writeFile(native, "#!/bin/sh\n", 0o755);
    const invocation = await buildCodexLaunchInvocation(native, info);
    assert.equal(invocation.command, native);
    assert.isUndefined(invocation.environment?.CODEX_MANAGED_PACKAGE_ROOT);
  });
});
