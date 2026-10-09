import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { channel } from "node:diagnostics_channel";

// Scaffold 0.8.2 also discards the native process's exit code. Preserve its
// normal cleanup/test-failure behavior only after a verified native exit zero.
export function attachNativeExitGuard(
  runner,
  {
    beforeExit,
    onAbnormalExit,
    report = console.error,
    diagnostics = false,
    native = runner.zotero?.zotero,
  },
) {
  const original = runner.onZoteroExit;
  if (!native?.prependListener || typeof original !== "function") {
    throw new Error("Scaffold native-process lifecycle is unavailable");
  }
  let nativeExit = null;
  let finished = false;
  let stderrTail = "";
  let stdoutTail = "";
  // Scaffold drains stdout but leaves stderr piped and unread. Drain it too:
  // a full OS pipe can block the native process, including during shutdown.
  // Only the explicit disposable-fixture diagnostic emits a bounded tail.
  native.stderr?.setEncoding("utf8");
  native.stderr?.on("data", (chunk) => {
    if (diagnostics) stderrTail = (stderrTail + chunk).slice(-16384);
  });
  if (diagnostics) {
    // Mozilla AsyncShutdown uses dump(), hence native stdout rather than
    // the console service. Scaffold otherwise drains and discards this.
    native.stdout?.setEncoding("utf8");
    native.stdout?.on("data", (chunk) => {
      stdoutTail = (stdoutTail + chunk).slice(-16384);
    });
  }
  native.prependListener("close", (code, signal) => {
    nativeExit = { code, signal };
    report(`Native workflow exit: ${JSON.stringify(nativeExit)}`);
    if ((code !== 0 || signal) && stderrTail) {
      report(`Native workflow stderr tail:\n${stderrTail}`);
    }
    if ((code !== 0 || signal) && stdoutTail) {
      report(`Native workflow stdout tail:\n${stdoutTail}`);
    }
  });
  runner.onZoteroExit = () => {
    if (finished) return;
    finished = true;
    const failCleanup = (error) => {
      report(
        `Workflow cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return onAbnormalExit(1);
    };
    const exitAfterCleanup = () => {
      if (!nativeExit || nativeExit.code !== 0 || nativeExit.signal) {
        const code = nativeExit?.code;
        return onAbnormalExit(
          Number.isInteger(code) && code > 0 && code <= 255 ? code : 1,
        );
      }
      return original.call(runner);
    };
    if (!beforeExit) return exitAfterCleanup();
    return Promise.resolve()
      .then(beforeExit)
      .then(exitAfterCleanup, failCleanup);
  };
  // Also handle a close before Scaffold finishes connecting its debugger and
  // registers its own callback. The once guard makes the later callback safe.
  native.on("close", () => runner.onZoteroExit());
}

export function observeWorkflowNativeProcess(
  runner,
  options,
  getBinary = () => process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH,
) {
  const events = channel("child_process");
  let attached = false;
  let ownedNative = null;
  let stopRequested = false;
  let resolveOwnedClose;
  const ownedClose = new Promise((resolveClose) => {
    resolveOwnedClose = resolveClose;
  });
  const normalized = (path) => {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  const observe = ({ process: native }) => {
    // Node publishes child_process from the constructor, before spawnfile
    // and pipes exist. "spawn" is emitted before child output/exit events.
    native.once("spawn", () => {
      const binary = getBinary();
      if (!binary || normalized(native.spawnfile) !== normalized(binary))
        return;
      if (attached)
        throw new Error("Unexpected second native workflow process");
      attachNativeExitGuard(runner, { ...options, native });
      attached = true;
      ownedNative = native;
      native.once("close", () => resolveOwnedClose());
      if (stopRequested) native.kill("SIGTERM");
    });
  };
  events.subscribe(observe);
  return {
    stop() {
      events.unsubscribe(observe);
    },
    assertAttached() {
      if (!attached) throw new Error("Native workflow spawn was not observed");
    },
    requestOwnedStop() {
      stopRequested = true;
      if (
        !ownedNative ||
        ownedNative.exitCode !== null ||
        ownedNative.signalCode !== null
      )
        return false;
      return ownedNative.kill("SIGTERM");
    },
    waitForOwnedClose() {
      if (!attached) throw new Error("Native workflow spawn was not observed");
      return ownedClose;
    },
  };
}

export function installOwnedNativeSignalHandlers(
  observer,
  signalSource = process,
) {
  const stopOwnedNative = () => observer.requestOwnedStop();
  signalSource.on("SIGINT", stopOwnedNative);
  signalSource.on("SIGTERM", stopOwnedNative);
  return () => {
    signalSource.removeListener("SIGINT", stopOwnedNative);
    signalSource.removeListener("SIGTERM", stopOwnedNative);
  };
}

async function reportWorkflowRuntimeVersion(binary) {
  if (!binary) return;
  for (const iniPath of [
    join(dirname(binary), "app", "application.ini"),
    join(dirname(binary), "application.ini"),
  ]) {
    try {
      const ini = await readFile(iniPath, "utf8");
      const version = ini
        .split(/\r?\n/)
        .filter((line) => /^(Version|BuildID)=/.test(line));
      console.log(
        `Native workflow runtime: ${version.join(", ") || "unknown"}`,
      );
      return;
    } catch {
      // Zotero distributions use either an app subdirectory or the root.
    }
  }
  console.log("Native workflow runtime version unavailable");
}

export async function runWorkflowScaffold({
  abortOnFail = true,
  configure,
  diagnostics = false,
} = {}) {
  const { Config, Test } = await import("zotero-plugin-scaffold");
  const context = await Config.loadConfig({
    test: { abortOnFail, watch: false },
  });
  if (configure) await configure(context);
  const runner = new Test(context);
  const observer = observeWorkflowNativeProcess(runner, {
    diagnostics,
    beforeExit: () => runner.testBundler?.esbuildContext?.dispose?.(),
    onAbnormalExit(code) {
      // Same cleanup hooks as Scaffold's onZoteroExit, but never rewrite an
      // abnormal native status to zero merely because assertions passed.
      runner.reporter.stop();
      void context.hooks.callHook("test:exit", context);
      process.exit(code);
    },
  });
  // Never call Scaffold's machine-wide cancellation fallback. Stop only the
  // native process observed for this disposable workflow run.
  const removeSignalHandlers = installOwnedNativeSignalHandlers(observer);
  try {
    await runner.run();
    observer.assertAttached();
    await reportWorkflowRuntimeVersion(
      process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH,
    );
    // Scaffold resolves run() after startup. Keep cancellation ownership until
    // the native test process actually closes.
    await observer.waitForOwnedClose();
  } finally {
    removeSignalHandlers();
    observer.stop();
  }
}

if (process.argv.includes("--workflow-child")) {
  await runWorkflowScaffold({ diagnostics: process.env.CI === "true" });
}
