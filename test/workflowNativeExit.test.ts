import { assert } from "chai";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import {
  attachNativeExitGuard,
  installOwnedNativeSignalHandlers,
  observeWorkflowNativeProcess,
} from "../scripts/workflow-scaffold.mjs";

describe("workflow native exit guard", function () {
  function fixture() {
    const native = new EventEmitter();
    const abnormal: number[] = [];
    let normalCalls = 0;
    const runner = {
      zotero: { zotero: native },
      onZoteroExit() {
        normalCalls++;
      },
    };
    // Mirror Scaffold's already-installed callback, which looks up the
    // instance handler at close time. The new observer must run before it.
    native.on("close", () => runner.onZoteroExit());
    attachNativeExitGuard(runner, {
      onAbnormalExit: (code: number) => abnormal.push(code),
      report: () => {},
    });
    return { native, runner, abnormal, normalCalls: () => normalCalls };
  }

  it("retains Scaffold's test-result cleanup after a native exit zero", function () {
    const test = fixture();
    test.native.emit("close", 0, null);
    assert.equal(test.normalCalls(), 1);
    assert.isEmpty(test.abnormal);
  });

  it("disposes workflow build resources before normal exit", async function () {
    const native = new EventEmitter();
    const order: string[] = [];
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const runner = {
      zotero: { zotero: native },
      onZoteroExit() {
        order.push("exit");
      },
    };
    native.on("close", () => runner.onZoteroExit());
    attachNativeExitGuard(runner, {
      beforeExit: async () => {
        order.push("cleanup-start");
        await cleanup;
        order.push("cleanup-end");
      },
      onAbnormalExit: () => order.push("abnormal"),
      report: () => {},
    });

    native.emit("close", 0, null);
    await Promise.resolve();
    assert.deepEqual(order, ["cleanup-start"]);
    releaseCleanup();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["cleanup-start", "cleanup-end", "exit"]);
  });

  it("fails closed when workflow build cleanup fails", async function () {
    const native = new EventEmitter();
    const reports: string[] = [];
    const abnormal: number[] = [];
    let normalCalls = 0;
    const runner = {
      zotero: { zotero: native },
      onZoteroExit() {
        normalCalls++;
      },
    };
    native.on("close", () => runner.onZoteroExit());
    attachNativeExitGuard(runner, {
      beforeExit: async () => {
        throw new Error("esbuild dispose failed");
      },
      onAbnormalExit: (code: number) => abnormal.push(code),
      report: (message: string) => reports.push(message),
    });

    native.emit("close", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(normalCalls, 0);
    assert.deepEqual(abnormal, [1]);
    assert.include(reports.at(-1), "esbuild dispose failed");
  });

  for (const [code, signal, expected] of [
    [139, null, 139],
    [7, null, 7],
    [null, "SIGTERM", 1],
    [-1, null, 1],
    [0, "SIGSEGV", 1],
  ]) {
    it(`rejects native status ${code}/${signal} even if assertions passed`, function () {
      const test = fixture();
      test.native.emit("close", code, signal);
      assert.deepEqual(test.abnormal, [expected]);
      assert.equal(test.normalCalls(), 0);
    });
  }

  it("fails closed when the native lifecycle callback lacks an exit record", function () {
    const test = fixture();
    test.runner.onZoteroExit();
    assert.deepEqual(test.abnormal, [1]);
    assert.equal(test.normalCalls(), 0);
  });

  it("fails clearly if a dependency update changes the native lifecycle", function () {
    assert.throws(
      () => attachNativeExitGuard({}, { onAbnormalExit: () => {} }),
      "Scaffold native-process lifecycle is unavailable",
    );
  });

  it("drains native stderr and bounds explicit abnormal-exit diagnostics", function () {
    const native = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
    });
    const reports: string[] = [];
    const runner = { zotero: { zotero: native }, onZoteroExit() {} };
    attachNativeExitGuard(runner, {
      onAbnormalExit: () => {},
      diagnostics: true,
      report: (message: string) => reports.push(message),
    });
    native.stderr.write("x".repeat(20000));
    native.stderr.write("shutdown detail");
    native.emit("close", 139, null);
    assert.equal(native.stderr.readableLength, 0);
    assert.lengthOf(reports, 2);
    assert.include(reports[1], "shutdown detail");
    assert.isBelow(reports[1].length, 16500);
  });

  for (const exitCode of [0, 139]) {
    it(`captures bounded native stdout only on abnormal exit (${exitCode})`, function () {
      const native = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
      });
      const reports: string[] = [];
      const runner = { zotero: { zotero: native }, onZoteroExit() {} };
      attachNativeExitGuard(runner, {
        onAbnormalExit: () => {},
        diagnostics: true,
        report: (message: string) => reports.push(message),
      });
      native.stdout.write("x".repeat(20000));
      native.stdout.write("AsyncShutdown timeout: fixture connection");
      native.emit("close", exitCode, null);
      assert.equal(native.stdout.readableLength, 0);
      assert.lengthOf(reports, exitCode === 0 ? 1 : 2);
      if (exitCode !== 0) {
        assert.include(reports[1], "AsyncShutdown timeout");
        assert.isBelow(reports[1].length, 16500);
      }
    });
  }

  it("does not print native stderr without explicit diagnostics", function () {
    const native = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
    });
    const reports: string[] = [];
    const runner = { zotero: { zotero: native }, onZoteroExit() {} };
    attachNativeExitGuard(runner, {
      onAbnormalExit: () => {},
      report: (message: string) => reports.push(message),
    });
    native.stderr.write("private diagnostic");
    native.emit("close", 139, null);
    assert.equal(native.stderr.readableLength, 0);
    assert.lengthOf(reports, 1);
    assert.notInclude(reports[0], "private diagnostic");
  });

  it("observes early native failure and drains stderr before runner startup finishes", async function () {
    const abnormal: number[] = [];
    let normalCalls = 0;
    // No runner.zotero assignment or Scaffold close callback exists yet.
    const runner = {
      onZoteroExit() {
        normalCalls++;
      },
    };
    const observer = observeWorkflowNativeProcess(
      runner,
      {
        onAbnormalExit: (code: number) => abnormal.push(code),
        report: () => {},
      },
      () => process.execPath,
    );
    try {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.stderr.write('x'.repeat(200000)); process.exitCode = 139;",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      await once(child, "close");
      observer.assertAttached();
      assert.deepEqual(abnormal, [139]);
      assert.equal(normalCalls, 0);
    } finally {
      observer.stop();
    }
  });

  it("cancels only the observed native process", async function () {
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    await once(unrelated, "spawn");
    const abnormal: number[] = [];
    const signals = new EventEmitter();
    const observer = observeWorkflowNativeProcess(
      { onZoteroExit() {} },
      {
        onAbnormalExit: (code: number) => abnormal.push(code),
        report: () => {},
      },
      () => process.execPath,
    );
    const removeSignalHandlers = installOwnedNativeSignalHandlers(
      observer,
      signals,
    );
    let owned: ReturnType<typeof spawn> | null = null;
    try {
      owned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      await once(owned, "spawn");
      observer.assertAttached();
      const ownedClose = observer.waitForOwnedClose();
      signals.emit("SIGTERM");
      await ownedClose;
      assert.isNull(unrelated.exitCode);
      assert.deepEqual(abnormal, [1]);
      assert.equal(signals.listenerCount("SIGINT"), 1);
      assert.equal(signals.listenerCount("SIGTERM"), 1);
    } finally {
      removeSignalHandlers();
      observer.stop();
      const ownedRunning =
        owned?.exitCode === null && owned.signalCode === null;
      const unrelatedRunning =
        unrelated.exitCode === null && unrelated.signalCode === null;
      if (ownedRunning) owned.kill("SIGKILL");
      if (unrelatedRunning) unrelated.kill("SIGKILL");
      await Promise.allSettled([
        ...(unrelatedRunning ? [once(unrelated, "close")] : []),
        ...(owned && ownedRunning ? [once(owned, "close")] : []),
      ]);
      assert.equal(signals.listenerCount("SIGINT"), 0);
      assert.equal(signals.listenerCount("SIGTERM"), 0);
    }
  });

  it("fails closed if no matching native process was observed", function () {
    const observer = observeWorkflowNativeProcess(
      { onZoteroExit() {} },
      { onAbnormalExit: () => {} },
      () => "__not_a_native_workflow_binary__",
    );
    try {
      assert.throws(() => observer.assertAttached(), "spawn was not observed");
    } finally {
      observer.stop();
    }
  });
});
