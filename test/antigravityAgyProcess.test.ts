import { assert } from "chai";
import { buildAgyArguments, runAgyTurn } from "../src/antigravity/agyProcess";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";

/** A child like agy 1.4.2: it stays alive after its result until killed. */
function lingeringAgy(lines: string[]) {
  const kills: number[] = [];
  let exited = false;
  const waiters: Array<() => void> = [];
  const exit = () => {
    exited = true;
    waiters.splice(0).forEach((resolve) => resolve());
  };
  const untilExit = () =>
    new Promise<void>((resolve) => {
      if (exited) resolve();
      else waiters.push(resolve);
    });
  const pending = lines.map((line) => `${line}\n`);
  const proc = {
    stdin: { write: async () => undefined, close: async () => undefined },
    stdout: {
      readString: async () => {
        const next = pending.shift();
        if (next !== undefined) return next;
        await untilExit();
        return "";
      },
    },
    stderr: {
      readString: async () => {
        await untilExit();
        return "";
      },
    },
    wait: async () => {
      await untilExit();
      return { exitCode: -9 };
    },
    kill: (timeout: number) => {
      kills.push(timeout);
      exit();
      return Promise.resolve({ exitCode: -9 });
    },
  };
  return { proc, kills, isExited: () => exited };
}

describe("Antigravity agy turn process", function () {
  const original = CodexAppServerProcess.loadSubprocessModule;
  afterEach(function () {
    CodexAppServerProcess.loadSubprocessModule = original;
  });

  it("ends agy once the result is in instead of waiting for it to exit", async function () {
    this.timeout(2000);
    const child = lingeringAgy([
      JSON.stringify({ event: "init", conversation_id: "c1", init: {} }),
      JSON.stringify({
        event: "result",
        result: { conversation_id: "c1", status: "SUCCESS", response: "Hi" },
      }),
    ]);
    CodexAppServerProcess.loadSubprocessModule = async () => ({
      call: async () => child.proc,
    });
    const result = await runAgyTurn({
      binaryPath: "/opt/agy",
      prompt: "Hello",
      onEvent: () => undefined,
    });
    assert.equal(result.response, "Hi");
    assert.isTrue(child.isExited());
    assert.isAbove(child.kills.length, 0);
    assert.isAbove(child.kills[0], 0, "SIGTERM is followed by SIGKILL");
  });

  it("opens extra folders to agy with --add-dir", function () {
    const args = buildAgyArguments({ addDirs: ["/tmp/ctx", " "] });
    assert.deepEqual(args.slice(-2), ["--add-dir", "/tmp/ctx"]);
    assert.equal(args.filter((arg) => arg === "--add-dir").length, 1);
  });
});
