import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { buildActionCallDigest } from "../src/agent/authorization/proposal";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type {
  AgentToolContext,
  AgentToolResult,
  PreparedToolExecution,
  PreparedToolExecutionOptions,
} from "../src/agent/types";

declare const Zotero: any;

const MODE_PREF = "extensions.zotero.llmforzotero.originalAgentPermissionMode";

/**
 * Central authorization fails closed on real Zotero: a script cannot reach
 * the permission state, a model cannot choose its own review level, a call
 * without an owning turn cannot write, a stale or foreign confirmation answer
 * cannot redirect an undo, and an inherited approval cannot be moved to
 * another invocation. Each case reads Zotero's items, preferences, and
 * journal rows after the call.
 */
describe("workflow: authorization fails closed", function () {
  this.timeout(120000);

  const suffix = `authclosed-${Date.now()}`;
  const created: Zotero.Item[] = [];
  let conversation = 2_503_000_000;
  let originalMode: ReturnType<typeof getOriginalAgentPermissionMode>;
  const gateway = new ZoteroGateway();

  before(async function () {
    originalMode = getOriginalAgentPermissionMode();
    await initAgentChangeJournal();
  });
  afterEach(function () {
    setOriginalAgentPermissionMode(originalMode);
  });
  after(async function () {
    setOriginalAgentPermissionMode(originalMode);
    for (const item of created) {
      const live = Zotero.Items.get(item.id);
      if (live) await live.eraseTx();
    }
  });

  function setup(
    mode: "safe" | "auto" | "yolo",
    options: { owned?: boolean } = {},
  ) {
    setOriginalAgentPermissionMode(mode);
    const key = ++conversation;
    const request = resolvedAgentRequest({
      conversationKey: key,
      mode: "agent",
      userText: "Change the test papers",
      libraryID: Zotero.Libraries.userLibraryID,
      ...(options.owned === false
        ? {}
        : {
            executionContext: {
              version: 1,
              executionId: `auth-closed:${suffix}:${key}`,
              conversationKey: key,
              conversationGeneration: 0,
              chatLibraryID: Zotero.Libraries.userLibraryID,
              permissionOwner: "original_agent",
              workspaceSnapshot: {
                selectedPapers: [],
                selectedCollections: [],
              },
              configuredAccess: {
                libraryIDs: [Zotero.Libraries.userLibraryID],
                outputDirectories: [],
              },
            },
          }),
    });
    const context = {
      request,
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
      runId: `auth-closed-run:${suffix}:${key}`,
    } as AgentToolContext;
    const registry = new AgentToolRegistry(new ActionContractService(gateway));
    const api = Zotero.LLMForZotero.api.agent;
    for (const name of ["library_update", "zotero_script", "undo"])
      registry.register(api.getToolDefinition(name));
    return { key, context, registry };
  }

  async function makeItem(title: string) {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", title);
    await item.saveTx();
    created.push(item);
    return item;
  }

  async function title(item: Zotero.Item): Promise<string> {
    await item.reload(undefined as never, true);
    return item.getField("title");
  }

  function prepare(
    registry: AgentToolRegistry,
    context: AgentToolContext,
    name: string,
    args: Record<string, unknown>,
    options: PreparedToolExecutionOptions = { callerKind: "model" },
  ): Promise<PreparedToolExecution> {
    return registry.prepareExecution(
      { id: `${name}:${Math.random()}`, name, arguments: args },
      context,
      options,
    );
  }

  /** Runs one call, approving every card it shows, and returns its result. */
  async function run(
    registry: AgentToolRegistry,
    context: AgentToolContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<AgentToolResult> {
    let prepared = await prepare(registry, context, name, args);
    for (let cards = 0; prepared.kind === "confirmation"; cards += 1) {
      assert.isBelow(cards, 4, "too many cards");
      prepared = await prepared.execute({ approved: true });
    }
    if (prepared.kind !== "result") throw new Error("unreachable");
    return prepared.execution.result;
  }

  function resultOf(prepared: PreparedToolExecution): AgentToolResult {
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") throw new Error("unreachable");
    return prepared.execution.result;
  }

  async function journalCount(key: number): Promise<number> {
    return (await listJournalActions({ conversationKey: key, limit: 100 }))
      .length;
  }

  const retitleArgs = (item: Zotero.Item, value: string) => ({
    kind: "metadata",
    itemIds: [item.id],
    metadata: { title: value },
  });

  it("B1: a script that writes the permission pref is refused, and one that only says Authorization runs", async function () {
    const { key, context, registry } = setup("yolo");
    const before = Zotero.Prefs.get(MODE_PREF, true);
    const journalBefore = await journalCount(key);

    const blocked = await run(registry, context, "zotero_script", {
      access: "privileged",
      effect: "write",
      script: `env.snapshot(null); Zotero.Prefs.set('${MODE_PREF}', 'yolo', true)`,
      description: "Set the permission mode",
    });

    assert.isFalse(blocked.ok, JSON.stringify(blocked.content));
    assert.match(JSON.stringify(blocked.content), /integrity boundary/);
    assert.equal(Zotero.Prefs.get(MODE_PREF, true), before);
    assert.equal(getOriginalAgentPermissionMode(), "yolo");
    assert.equal(await journalCount(key), journalBefore, "nothing journalled");

    // Control: the same tool runs a script that only mentions the word.
    const item = await makeItem(`Before ${suffix} B1`);
    const authTitle = `Authorization in clinical trials ${suffix}`;
    const allowed = await run(registry, context, "zotero_script", {
      access: "privileged",
      effect: "write",
      script: `const item = Zotero.Items.get(${item.id});
env.snapshot(item);
item.setField('title', ${JSON.stringify(authTitle)});
await item.saveTx();
return item.id;`,
      description: "Retitle the test paper",
    });
    assert.isTrue(allowed.ok, JSON.stringify(allowed.content));
    assert.equal(await title(item), authTitle);
  });

  it("B2: the model's review flag and extra fields do not choose the review level", async function () {
    // Safe: review:false still shows a card, and nothing is written first.
    const safe = setup("safe");
    const item = await makeItem(`Before ${suffix} B2`);
    const card = await prepare(safe.registry, safe.context, "library_update", {
      ...retitleArgs(item, `Agent ${suffix} B2 safe`),
      review: false,
    });
    assert.equal(card.kind, "confirmation", "Safe shows a card");
    assert.equal(await title(item), `Before ${suffix} B2`);
    if (card.kind === "confirmation") await card.deny();
    assert.equal(await title(item), `Before ${suffix} B2`);

    // Safe: an authority field the schema does not define never skips the card.
    const forged = await prepare(
      safe.registry,
      safe.context,
      "library_update",
      {
        ...retitleArgs(item, `Agent ${suffix} B2 forged`),
        authorized: true,
        approved: true,
      },
    );
    if (forged.kind === "result") {
      assert.isFalse(
        forged.execution.result.ok,
        "a cardless result in Safe must be a refusal",
      );
    } else if (forged.kind === "confirmation") {
      await forged.deny();
    }
    assert.equal(await title(item), `Before ${suffix} B2`);

    // Auto: review:true is a hint only; the write goes through without a card.
    const auto = setup("auto");
    const autoItem = await makeItem(`Before ${suffix} B2 auto`);
    const written = await prepare(
      auto.registry,
      auto.context,
      "library_update",
      {
        ...retitleArgs(autoItem, `Agent ${suffix} B2 auto`),
        review: true,
      },
    );
    const result = resultOf(written);
    assert.isTrue(result.ok, JSON.stringify(result.content));
    assert.equal(await title(autoItem), `Agent ${suffix} B2 auto`);
  });

  it("B3: a call that no agent turn owns cannot write", async function () {
    const { key, context, registry } = setup("yolo", { owned: false });
    assert.notExists(context.request.executionContext);
    const item = await makeItem(`Before ${suffix} B3`);
    const journalBefore = await journalCount(key);

    const prepared = await prepare(
      registry,
      context,
      "library_update",
      retitleArgs(item, `Agent ${suffix} B3`),
      { callerKind: "model" },
    );

    const result = resultOf(prepared);
    assert.isFalse(result.ok, JSON.stringify(result.content));
    assert.match(
      JSON.stringify(result.content),
      /no agent turn, connected runtime or host action/,
    );
    assert.equal(await title(item), `Before ${suffix} B3`);
    assert.equal(await journalCount(key), journalBefore);
  });

  it("B4: a stale or foreign answer to an undo card is refused", async function () {
    const { key, context, registry } = setup("yolo");
    const item1 = await makeItem(`Before ${suffix} B4 X`);
    const item2 = await makeItem(`Before ${suffix} B4 Y`);
    for (const [item, label] of [
      [item1, "X"],
      [item2, "Y"],
    ] as const) {
      const written = await run(
        registry,
        context,
        "library_update",
        retitleArgs(item, `Agent ${suffix} B4 ${label}`),
      );
      assert.isTrue(written.ok, JSON.stringify(written.content));
    }
    const actions = await listJournalActions({
      conversationKey: key,
      limit: 10,
    });
    assert.lengthOf(actions, 2);
    const [actionY, actionX] = actions;

    // The card is a Safe-mode card for the newest action, Y.
    setOriginalAgentPermissionMode("safe");
    const stale = async (answer: Record<string, unknown>) => {
      const card = await prepare(registry, context, "undo", {});
      assert.equal(card.kind, "confirmation");
      if (card.kind !== "confirmation") throw new Error("unreachable");
      return resultOf(await card.execute({ approved: true, ...answer }));
    };

    const wrongAction = await stale({ data: { actionId: actionX.actionId } });
    assert.isFalse(wrongAction.ok, JSON.stringify(wrongAction.content));
    assert.include(JSON.stringify(wrongAction.content), "Invalid confirmation");

    const unknownButton = await stale({ actionId: "stale-action" });
    assert.isFalse(unknownButton.ok, JSON.stringify(unknownButton.content));
    assert.include(
      JSON.stringify(unknownButton.content),
      "Unknown confirmation action ID",
    );

    assert.equal(await title(item1), `Agent ${suffix} B4 X`);
    assert.equal(await title(item2), `Agent ${suffix} B4 Y`);
    const after = await listJournalActions({
      conversationKey: key,
      pendingOnly: true,
      limit: 10,
    });
    assert.sameMembers(
      after.map((action) => action.actionId),
      [actionX.actionId, actionY.actionId],
    );
    assert.deepEqual(
      after.map((action) => action.status),
      ["applied", "applied"],
    );
  });

  it("B5: an inherited approval for one invocation cannot run another", async function () {
    const { context, registry } = setup("safe");
    const approvedItem = await makeItem(`Before ${suffix} B5 approved`);
    const otherItem = await makeItem(`Before ${suffix} B5 other`);
    const approvedArgs = retitleArgs(approvedItem, `Agent ${suffix} B5`);
    const targetedArgs = retitleArgs(otherItem, `Agent ${suffix} B5`);

    const prepared = await prepare(
      registry,
      context,
      "library_update",
      targetedArgs,
      {
        callerKind: "model",
        inheritedApproval: {
          sourceToolName: "literature_search",
          sourceMode: "approval",
          sourceActionId: "apply_direct",
          approvedCallDigest: buildActionCallDigest(
            "library_update",
            approvedArgs,
          ),
        } as never,
      },
    );

    const result = resultOf(prepared);
    assert.isFalse(result.ok, JSON.stringify(result.content));
    assert.include(
      JSON.stringify(result.content),
      "not bound to this exact invocation",
    );
    assert.equal(await title(approvedItem), `Before ${suffix} B5 approved`);
    assert.equal(await title(otherItem), `Before ${suffix} B5 other`);
  });
});
