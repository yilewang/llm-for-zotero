import { assert } from "chai";
import { createZoteroScriptTool } from "../src/agent/tools/write/zoteroScript";
import type { AgentToolContext } from "../src/agent/types";

/**
 * The script's only channel back to the model was `env.log`, capped at 8000
 * characters, and its actual return value was discarded — `raceResult` was
 * only ever compared to `"timeout"`. A step that enumerated 400 ids reported
 * roughly 180 of them and nothing said the rest were missing, which is what
 * made multi-step work over a real library impossible.
 */
describe("zotero_script chaining", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  const context: AgentToolContext = {
    request: {
      conversationKey: 3,
      mode: "agent",
      userText: "list",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    journalFallbackApproved: true,
  };

  async function run(script: string) {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: { get: () => null },
      debug: () => undefined,
    };
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "read",
      script,
      description: "enumerate",
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) throw new Error("unreachable");
    const output = await tool.execute(validated.value, context);
    return output.content as Record<string, unknown>;
  }

  it("delivers the script's return value in full", async function () {
    const ids = Array.from({ length: 400 }, (_v, i) => i + 1);
    const result = await run(`return ${JSON.stringify(ids)};`);
    assert.deepEqual(
      result.returnValue,
      ids,
      "all 400 ids must survive; the log cap is what used to lose them",
    );
  });

  it("returns structured data, not just strings", async function () {
    const result = await run(
      "return { total: 2, items: [{ id: 1 }, { id: 2 }] };",
    );
    assert.deepEqual(result.returnValue, {
      total: 2,
      items: [{ id: 1 }, { id: 2 }],
    });
  });

  it("flags a truncated log instead of silently dropping it", async function () {
    const result = await run(
      "for (let i = 0; i < 2000; i += 1) env.log('a'.repeat(20)); return 'done';",
    );
    assert.isTrue(
      result.outputTruncated,
      "a silently truncated log is how a chain loses data without noticing",
    );
    assert.include(String(result.output), "log truncated");
    assert.equal(
      result.returnValue,
      "done",
      "the return value is unaffected by the log cap",
    );
  });
});

/**
 * Write mode had no coverage at all — both chaining tests above run in read
 * mode, where env.snapshot returns early. The widened snapshot then called
 * getNote() unguarded; that method exists on every Zotero.Item's prototype
 * but throws for anything that is not a note, so env.snapshot — the tool's
 * own mandatory first step — aborted every write script before its first
 * mutation.
 */
describe("zotero_script write-mode snapshotting", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  const context: AgentToolContext = {
    request: {
      conversationKey: 4,
      mode: "agent",
      userText: "tag",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    journalFallbackApproved: true,
  };

  function installItem(over: Record<string, unknown>) {
    const item = {
      id: 51,
      isNote: () => false,
      isAttachment: () => false,
      // Real Zotero throws here for a journalArticle. The old code called it
      // through a `typeof === "function"` guard, which always passes.
      getNote: () => {
        throw new Error(
          "getNote() can only be called on notes and attachments",
        );
      },
      getField: () => "",
      getTags: () => [],
      getCollections: () => [],
      getCreatorsJSON: () => [],
      toJSON: () => ({ itemType: "journalArticle" }),
      addTag: () => undefined,
      saveTx: async () => undefined,
      ...over,
    };
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: { get: () => item },
      debug: () => undefined,
    };
    return item;
  }

  it("snapshots a regular item without throwing on getNote", async function () {
    installItem({});
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      script:
        "const item = Zotero.Items.get(51); env.snapshot(item); item.addTag('x'); await item.saveTx(); return 'ok';",
      description: "tag one item",
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) return;

    const result = (await tool.execute(validated.value, context))
      .content as Record<string, unknown>;

    assert.isUndefined(
      result.error,
      `write scripts must not abort while snapshotting: ${String(result.error)}`,
    );
    assert.equal(result.returnValue, "ok");
    assert.equal(result.itemsAffected, 1, "the item was still snapshotted");
  });

  it("still snapshots a real note's HTML", async function () {
    installItem({
      isNote: () => true,
      getNote: () => "<p>body</p>",
    });
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      script:
        "const n = Zotero.Items.get(51); env.snapshot(n); await n.saveTx(); return 'ok';",
      description: "touch a note",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const result = (await tool.execute(validated.value, context))
      .content as Record<string, unknown>;
    assert.isUndefined(result.error);
    assert.equal(result.itemsAffected, 1);
  });
});

/**
 * `mode` was a declaration, not a boundary. The evaluator compiled in the
 * plugin's own realm, where `globalThis.Zotero`, `IOUtils` and `ChromeUtils`
 * are ambient, so binding Zotero as a parameter fenced nothing — a read-mode
 * script could reach the unwrapped global in one line and write freely.
 *
 * The sandbox is the enforcement. Where it is unavailable the tool still
 * runs (falling back to the old compile) rather than refusing outright, so
 * these cover the parts that hold either way.
 */
describe("zotero_script scope control", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  const context: AgentToolContext = {
    request: { conversationKey: 6, mode: "agent", userText: "x", libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    journalFallbackApproved: true,
  };

  it("refuses Zotero.DB to write scripts, which no mechanism can invert", async function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: { queryAsync: async () => [] },
      Items: { get: () => null },
      debug: () => undefined,
    };
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "write",
      script:
        "env.addInverse({ version: 1, kind: 'library_operations', operations: [] }); await Zotero.DB.queryAsync('DELETE FROM items'); return 'done';",
      description: "raw sql",
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) return;

    const result = (await tool.execute(validated.value, context))
      .content as Record<string, unknown>;
    assert.isDefined(result.error, "raw SQL must not silently succeed");
    assert.include(String(result.error), "Zotero.DB");
  });

  it("still allows Zotero.DB to read scripts, which change nothing", async function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: { queryAsync: async () => [{ n: 3 }] },
      Items: { get: () => null },
      debug: () => undefined,
    };
    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "read",
      script:
        "const rows = await Zotero.DB.queryAsync('SELECT 1'); return rows.length;",
      description: "count",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const result = (await tool.execute(validated.value, context))
      .content as Record<string, unknown>;
    assert.isUndefined(result.error);
    assert.equal(result.returnValue, 1);
  });
});

/**
 * The sandbox branch was unreachable in every runtime: the constructor was
 * looked up on `globalThis.Cu` (which the plugin scope does not define)
 * falling back to `ChromeUtils.Sandbox` (which does not exist), while the
 * evaluator was read off `ChromeUtils` separately. Constructor and evaluator
 * came from two different objects, so every script silently took the
 * in-realm fallback while the commit message claimed otherwise — and 3557
 * green tests never touched the branch, because none installed a fake Cu.
 */
describe("zotero_script sandbox engagement", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;
  const originalComponents = (
    globalThis as typeof globalThis & { Components?: unknown }
  ).Components;
  const originalServices = (
    globalThis as typeof globalThis & { Services?: unknown }
  ).Services;

  afterEach(function () {
    const g = globalThis as typeof globalThis & Record<string, unknown>;
    g.Zotero = originalZotero;
    g.Components = originalComponents;
    g.Services = originalServices;
  });

  const context: AgentToolContext = {
    request: { conversationKey: 8, mode: "agent", userText: "x", libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    journalFallbackApproved: true,
  };

  it("compiles inside the sandbox when Components.utils is available", async function () {
    const g = globalThis as typeof globalThis & Record<string, unknown>;
    let sandboxBuilt = 0;
    let evaluated = 0;
    g.Zotero = { Items: { get: () => null }, debug: () => undefined };
    g.Services = {
      scriptSecurityManager: { getSystemPrincipal: () => ({}) },
    };
    g.Components = {
      utils: {
        Sandbox: function FakeSandbox(this: Record<string, unknown>) {
          sandboxBuilt += 1;
          return this;
        },
        evalInSandbox: (source: string) => {
          evaluated += 1;
          // Faithful enough: compile the same factory the real call would.
          return (0, eval)(source);
        },
      },
    };

    const tool = createZoteroScriptTool({
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      mode: "read",
      script: "return 7;",
      description: "seven",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = (await tool.execute(validated.value, context))
      .content as Record<string, unknown>;

    assert.equal(sandboxBuilt, 1, "the sandbox constructor must be reached");
    assert.equal(evaluated, 1, "the evaluator must come from the same object");
    assert.equal(result.returnValue, 7);
  });

  it("fails closed when no sandbox is available", async function () {
    const g = globalThis as typeof globalThis & Record<string, unknown>;
    g.Components = undefined;
    g.Services = undefined;
    g.Zotero = {
      DB: { queryAsync: async () => [] },
      Items: { get: () => null },
      debug: () => undefined,
    };

    const tool = createZoteroScriptTool();
    const validated = tool.validate({
      mode: "write",
      script:
        "env.addInverse({ version: 1, kind: 'library_operations', operations: [] }); await Zotero.DB.queryAsync('x');",
      description: "sql",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const result = (await tool.execute(validated.value, context))
      .content as Record<string, unknown>;
    assert.include(String(result.error), "sandbox is unavailable");
  });
});
