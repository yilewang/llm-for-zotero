import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { createRunCommandTool } from "../src/agent/tools/write/runCommand";
import type { AgentToolContext } from "../src/agent/types";

const screenshotCommand =
  'ls -la /tmp/acv2-vault-20260827-2022 && echo "---" && ls -la /tmp/acv2-vault-20260827-2022/Exports';

describe("Auto and YOLO command authorization workflow", function () {
  const originalZotero = globalThis.Zotero;
  let mode: "safe" | "auto" | "yolo";
  let executions: string[];
  let reviews: any[];
  let verdict: any;
  let context: AgentToolContext;
  let registry: AgentToolRegistry;

  beforeEach(async function () {
    mode = "auto";
    executions = [];
    reviews = [];
    verdict = {
      decision: "execute",
      reason: "The command implements the user's explicit request.",
    };
    globalThis.Zotero = {
      // The fixture commands below are POSIX; do not classify them as cmd.exe
      // merely because this mocked unit workflow runs on a Windows machine.
      isWin: false,
      isMac: true,
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => mode },
      Items: { get: () => null },
      Collections: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    context = {
      request: {
        conversationKey: 17,
        conversationGeneration: 3,
        mode: "agent",
        userText: "Convert the report using our conversion script.",
        libraryID: 1,
        executionContext: {
          version: 1,
          executionId: "auto-review-run",
          conversationKey: 17,
          conversationGeneration: 3,
          chatLibraryID: 1,
          permissionOwner: "original_agent",
          workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
          configuredAccess: {
            libraryIDs: [1],
            outputDirectories: ["/exports"],
          },
        },
      },
      runId: "auto-review-run",
      item: null,
      currentAnswerText: "",
      modelName: "fixture",
      reviewAction: async (review: unknown) => {
        reviews.push(review);
        return verdict;
      },
    } as unknown as AgentToolContext;
    registry = new AgentToolRegistry(new ActionContractService({} as never));
    const tool = createRunCommandTool();
    // Exercise the real validation, analysis, authorization and controller;
    // only the native subprocess boundary is replaced in this unit workflow.
    tool.execute = async (input) => {
      executions.push(input.command);
      return { content: { exitCode: 0 }, effect: "none" };
    };
    registry.register(tool);
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  function prepare(command: string, options = {}) {
    return registry.prepareExecution(
      { id: "command-call", name: "run_command", arguments: { command } },
      context,
      options,
    );
  }

  for (const command of [
    screenshotCommand,
    "ls -lah /tmp",
    "cat '/tmp/a && b.txt' | head -n 5",
    "pwd; ls -al /tmp\necho done",
  ]) {
    it(`runs read-only shell syntax without model review: ${command}`, async function () {
      const result = await prepare(command);
      assert.equal(result.kind, "result");
      assert.deepEqual(executions, [command]);
      assert.lengthOf(reviews, 0);
    });
  }

  it("reviews an unfamiliar justified command once, including execution revalidation", async function () {
    const result = await prepare("python3 /tmp/convert.py /tmp/report.md");
    assert.equal(result.kind, "result");
    assert.lengthOf(executions, 1);
    assert.lengthOf(reviews, 1);
    assert.equal(reviews[0].input.command, executions[0]);
  });

  it("reviews an intermediate crop command with the script and preceding tool evidence", async function () {
    context.request.userText =
      "Crop the requested figure and save it in my Zotero note.";
    const completed = [
      {
        name: "file_io",
        ok: true,
        input: {
          action: "write",
          filePath: "/tmp/bands.py",
          content:
            "from pathlib import Path\nprint(Path('/tmp/p3.pgm').stat().st_size)",
        },
        content: { success: true, filePath: "/tmp/bands.py" },
      },
    ];
    context.readCurrentTurnActions = () => completed;
    const result = await prepare(
      "cd /tmp && python3 /tmp/bands.py /tmp/p3.pgm",
    );
    assert.equal(result.kind, "result");
    assert.deepEqual(reviews[0].currentTurnActions, completed);
    assert.equal(reviews[0].userRequest, context.request.userText);
    assert.lengthOf(reviews, 1);
  });

  it("shows the reviewer's concrete reason when intent is unclear", async function () {
    verdict = {
      decision: "confirm",
      reason: "The request does not identify which backup directory to delete.",
    };
    const result = await prepare("rm -rf /tmp/backups");
    assert.equal(result.kind, "confirmation");
    if (result.kind !== "confirmation") return;
    assert.include(result.action.description, verdict.reason);
    assert.lengthOf(executions, 0);
    assert.lengthOf(reviews, 1);
    const approved = await result.execute({ approved: true });
    assert.equal(approved.kind, "result");
    assert.lengthOf(executions, 1);
    assert.lengthOf(reviews, 1);
  });

  it("does not let a generic forceConfirmation override Auto", async function () {
    const result = await prepare("python3 /tmp/convert.py", {
      forceConfirmation: true,
    });
    assert.equal(result.kind, "result");
    assert.lengthOf(reviews, 1);
    assert.lengthOf(executions, 1);
  });

  it("rechecks changed context before execution and explains the resulting confirmation", async function () {
    const result = await prepare("python3 /tmp/convert.py", {
      executeWithLock: async <T>(run: () => Promise<T>) => {
        context.request.history = [
          {
            role: "user",
            content: "The source is shared; preserve its content.",
          },
        ];
        verdict = {
          decision: "confirm",
          reason: "The script may replace the newly identified shared source.",
        };
        return run();
      },
    });
    assert.equal(result.kind, "confirmation");
    if (result.kind !== "confirmation") return;
    assert.include(result.action.description, verdict.reason);
    assert.lengthOf(reviews, 2);
    assert.lengthOf(executions, 0);
  });

  it("reassesses edited commands instead of reusing the old model verdict", async function () {
    verdict = { decision: "confirm", reason: "Unknown conversion target." };
    await prepare("python3 /tmp/convert.py one");
    verdict = { decision: "execute", reason: "Explicitly requested output." };
    await prepare("python3 /tmp/convert.py two");
    assert.lengthOf(reviews, 2);
    assert.deepEqual(executions, ["python3 /tmp/convert.py two"]);
  });

  for (const command of [
    "python3 /tmp/unknown.py",
    "rm -rf /tmp/backups",
    "sudo installer --target /usr/local",
  ]) {
    it(`YOLO executes without review or confirmation: ${command}`, async function () {
      mode = "yolo";
      const result = await prepare(command, { forceConfirmation: true });
      assert.equal(result.kind, "result");
      assert.deepEqual(executions, [command]);
      assert.lengthOf(reviews, 0);
    });
  }

  it("Safe still reviews writes without paying for a model review", async function () {
    mode = "safe";
    const result = await prepare("python3 /tmp/convert.py");
    assert.equal(result.kind, "confirmation");
    assert.lengthOf(executions, 0);
    assert.lengthOf(reviews, 0);
  });
});
