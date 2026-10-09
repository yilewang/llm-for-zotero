import { assert } from "chai";
import { classifyRunCommandInvocation } from "../src/agent/tools/write/commandAnalysis";
import { authorizeOriginalAction } from "../src/agent/authorization/policy";
import { buildActionProposal } from "../src/agent/authorization/proposal";
import { parseShellCommands } from "../src/agent/tools/write/shellSyntax";

describe("shell effect analysis for automatic execution", function () {
  const originalIO = (globalThis as any).IOUtils;
  const originalZotero = (globalThis as any).Zotero;
  beforeEach(function () {
    (globalThis as any).IOUtils = { exists: async () => false };
    // These default examples use POSIX syntax. Windows-specific cases below
    // select Windows explicitly rather than inheriting the machine running CI.
    (globalThis as any).Zotero = {
      ...originalZotero,
      isWin: false,
      isMac: true,
    };
  });
  afterEach(function () {
    (globalThis as any).IOUtils = originalIO;
    (globalThis as any).Zotero = originalZotero;
  });
  const decision = async (command: string) => {
    const plan = await classifyRunCommandInvocation({ command });
    return authorizeOriginalAction(
      buildActionProposal({
        tool: { spec: { name: "run_command" } } as never,
        input: { command },
        plan,
      }),
      { mode: "auto" },
    );
  };
  for (const command of [
    "touch /tmp/new.txt",
    "mkdir /tmp/new-dir",
    "cp /tmp/source.txt /tmp/new.txt",
    "printf '%s' hello > /tmp/new.txt",
  ]) {
    it(`automatically permits an understood new output: ${command}`, async function () {
      assert.equal((await decision(command)).kind, "execute");
    });
  }
  for (const command of [
    "python3 /tmp/unknown.py > /tmp/new.txt",
    "cat /tmp/source > /tmp/new.txt && rm -rf /tmp/backups",
    "echo $(python3 /tmp/unknown.py) > /tmp/new.txt",
    "cat /tmp/source | python3 /tmp/unknown.py",
    "find /tmp -exec rm {} +",
    "git diff",
    "git diff --no-ext-diff --no-textconv --output=/tmp/out",
  ]) {
    it(`does not treat one output as proof for all effects: ${command}`, async function () {
      assert.equal((await decision(command)).kind, "model_review");
    });
  }
  it("requires review of an overwrite without recovery", async function () {
    (globalThis as any).IOUtils.exists = async () => true;
    assert.equal(
      (await decision("cp /tmp/source /tmp/existing")).kind,
      "model_review",
    );
  });
  it("does not treat quoted command-like text as an effect", async function () {
    assert.equal(
      (await decision("echo 'authorization && rm -rf / > out'")).kind,
      "execute",
    );
  });
  it("treats command-like prose in a new document as ordinary file content", async function () {
    assert.equal(
      (await decision('printf "%s" "rm authorization" > /tmp/new.txt')).kind,
      "execute",
    );
  });
  it("recognizes a deliberately helper-free diff", async function () {
    assert.equal(
      (await decision("git diff --no-ext-diff --no-textconv --stat")).kind,
      "execute",
    );
  });
  it("preserves Windows path separators during analysis", async function () {
    (globalThis as any).Zotero = { isWin: true };
    const command = String.raw`dir "C:\My Notes" && type C:\notes\report.txt`;
    assert.deepEqual(
      parseShellCommands(command)?.map(({ words }) => words),
      [
        ["dir", String.raw`C:\My Notes`],
        ["type", String.raw`C:\notes\report.txt`],
      ],
    );
    assert.equal((await decision(command)).kind, "execute");
  });
  for (const command of [
    String.raw`echo 'text & del /s C:\backup'`,
    String.raw`echo text # & del /s C:\backup`,
  ]) {
    it(`does not let POSIX quoting hide Windows effects: ${command}`, async function () {
      (globalThis as any).Zotero = { isWin: true };
      assert.equal((await decision(command)).kind, "model_review");
    });
  }
  it("recognizes read-only Windows command composition", async function () {
    (globalThis as any).Zotero = { isWin: true };
    assert.equal((await decision("dir C:\\notes & echo done")).kind, "execute");
  });
});
