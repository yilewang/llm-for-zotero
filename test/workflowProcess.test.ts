import { assert } from "chai";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  createWorkflowCompletionTracker,
  runWorkflowTestProcess,
} from "../scripts/workflow-process.mjs";

describe("workflow process completion evidence", function () {
  it("accepts a complete colored summary split across chunks", function () {
    const tracker = createWorkflowCompletionTracker();
    for (const chunk of [
      "\u001b[3",
      "2m ✔ Test run com",
      "pleted - 13 passed\u001b[0m\r",
      "\n",
    ]) {
      tracker.write("stdout", chunk);
    }
    assert.isTrue(tracker.finish());
  });

  it("accepts a final summary without a trailing newline", function () {
    const tracker = createWorkflowCompletionTracker();
    tracker.write("stdout", "✔ Test run completed - 13 passed");
    assert.isTrue(tracker.finish());
  });

  it("does not combine partial stdout and stderr lines", function () {
    const tracker = createWorkflowCompletionTracker();
    tracker.write("stdout", "✔ Test run completed - ");
    tracker.write("stderr", "13 passed\n");
    assert.isFalse(tracker.finish());
  });

  for (const metadata of [
    'Native workflow exit: {"code":0,"signal":null}',
    "Native workflow runtime: Version=8.0.1, BuildID=20261008000000",
    "Native workflow runtime: BuildID=20261008000000",
    "Native workflow runtime: unknown",
    "Native workflow runtime version unavailable",
    " \t",
  ]) {
    it(`allows benign post-summary metadata: ${metadata}`, function () {
      const tracker = createWorkflowCompletionTracker();
      tracker.write("stdout", "✔ Test run completed - 13 passed\n");
      tracker.write("stderr", metadata + "\n");
      assert.isTrue(tracker.finish());
    });
  }

  for (const ending of ["\n", ""]) {
    it(`rejects oversized trailing output ${ending ? "with" : "without"} a newline`, function () {
      const tracker = createWorkflowCompletionTracker();
      tracker.write("stdout", "✔ Test run completed - 13 passed\n");
      tracker.write("stderr", "x".repeat(10000));
      tracker.write("stderr", "x".repeat(10000) + ending);
      assert.isFalse(tracker.finish());
    });
  }

  for (const [name, output] of [
    ["missing completion", "✔ one individual test 123ms\n"],
    ["failed completion", "✖ Test run completed - 13 passed, 1 failed\n"],
    ["empty suite", "✔ Test run completed - 0 passed\n"],
    [
      "duplicate summaries",
      "✔ Test run completed - 13 passed\n✔ Test run completed - 13 passed\n",
    ],
    ["quoted summary", 'debug: "✔ Test run completed - 13 passed"\n'],
    ["truncated summary", "✔ Test run completed - 13 pass"],
    ["unprefixed debug output", "Test run completed - 13 passed\n"],
    [
      "more tests after summary",
      "✔ Test run completed - 13 passed\n✔ another test 14ms\n",
    ],
    [
      "oversized line",
      "x".repeat(20000) + "✔ Test run completed - 13 passed\n",
    ],
    [
      "plain cleanup error",
      "✔ Test run completed - 13 passed\nfatal cleanup error\n",
    ],
    [
      "unterminated cleanup error",
      "✔ Test run completed - 13 passed\nfatal cleanup error",
    ],
    [
      "nonzero native exit metadata",
      '✔ Test run completed - 13 passed\nNative workflow exit: {"code":139,"signal":null}\n',
    ],
    [
      "signaled native exit metadata",
      '✔ Test run completed - 13 passed\nNative workflow exit: {"code":0,"signal":"SIGTERM"}\n',
    ],
    [
      "error after benign native metadata",
      '✔ Test run completed - 13 passed\nNative workflow exit: {"code":0,"signal":null}\nfatal cleanup error\n',
    ],
  ]) {
    it(`rejects ${name}`, function () {
      const tracker = createWorkflowCompletionTracker();
      tracker.write("stdout", output);
      assert.isFalse(tracker.finish());
    });
  }

  it("recovers its bounded buffer after an oversized diagnostic line", function () {
    const tracker = createWorkflowCompletionTracker();
    tracker.write("stdout", "x".repeat(20000));
    tracker.write("stdout", "\n✔ Test run completed - 13 passed\n");
    assert.isTrue(tracker.finish());
  });

  async function run(source: string, command = process.execPath) {
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const code = await runWorkflowTestProcess(
      {
        command,
        args: ["--input-type=module", "-e", source],
        env: process.env,
      },
      { stdout: sink, stderr: sink },
    );
    return { code, output };
  }

  it("rejects exit zero without terminal completion", async function () {
    const result = await run('console.log("✔ one individual test 123ms")');
    assert.equal(result.code, 1);
    assert.include(result.output, "did not report");
  });

  it("waits for completion and forwards output without changing a valid exit", async function () {
    const result = await run('console.log("✔ Test run completed - 13 passed")');
    assert.equal(result.code, 0);
    assert.include(result.output, "13 passed");
  });

  it("preserves a nonzero exit even after a successful summary", async function () {
    const result = await run(
      'console.log("✔ Test run completed - 13 passed"); process.exitCode = 7;',
    );
    assert.equal(result.code, 7);
  });

  it("rejects trailing stderr cleanup errors even if the child exits zero", async function () {
    const result = await run(
      'console.log("✔ Test run completed - 13 passed"); setTimeout(() => console.error("fatal cleanup error"), 50);',
    );
    assert.equal(result.code, 1);
    assert.include(result.output, "fatal cleanup error");
    assert.include(result.output, "did not report");
  });

  it("rejects a failed summary even if the child exits zero", async function () {
    const result = await run(
      'console.error("✖ Test run completed - 13 passed, 1 failed")',
    );
    assert.equal(result.code, 1);
  });

  it("fails clearly when the child cannot be spawned", async function () {
    const result = await run("", "__missing_workflow_test_executable__");
    assert.equal(result.code, 1);
    assert.include(result.output, "Workflow test process failed:");
  });

  it("forwards wrapper cancellation and removes its signal listeners", async function () {
    const signals = new EventEmitter();
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        if (output.includes("child ready")) signals.emit("SIGTERM");
        callback();
      },
    });
    const code = await runWorkflowTestProcess(
      {
        command: process.execPath,
        args: [
          "-e",
          'setInterval(() => {}, 1000); console.log("child ready");',
        ],
        env: process.env,
      },
      { stdout: sink, stderr: sink, signalSource: signals },
    );
    assert.equal(code, 1);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  });
});
