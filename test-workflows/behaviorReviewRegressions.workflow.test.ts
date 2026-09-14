import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { createQueryLibraryTool } from "../src/agent/tools/read/queryLibrary";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentActionContract, AgentToolContext } from "../src/agent/types";
import { semanticContractFixture } from "../test/helpers/semanticIntent";

describe("workflow: behavior audit shared-owner regressions", function () {
  this.timeout(60000);

  function writeContext(
    operation: string,
    parameters: Record<string, unknown>,
    text: string,
  ) {
    const contracts = new ActionContractService(new ZoteroGateway());
    const contract: AgentActionContract = semanticContractFixture({
      version: 3,
      id: `behavior-review-${Date.now()}`,
      hardConstraints: [],
      writeDisposition: "required",
      interpretationSource: "semantic",
      obligations: [
        {
          id: "write",
          operation: operation as never,
          proofDomain: "zotero_state",
          capability:
            operation === "create_collection"
              ? "zotero.collections"
              : "zotero.notes",
          coverage: "one",
          targetKind: "items",
          parameters,
        },
      ],
    });
    const context: AgentToolContext = {
      request: {
        conversationKey: 2500900001,
        mode: "agent",
        libraryID: Zotero.Libraries.userLibraryID,
        userText: text,
        actionContract: contract,
        actionProgress: contracts.createProgress(contract),
      },
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
    };
    return { registry: new AgentToolRegistry(contracts), context };
  }

  it("returns a verified receipt for a natively created collection without a review", async function () {
    const originalMode = getOriginalAgentPermissionMode();
    const name = `Behavior receipt collection ${Date.now()}`;
    const libraryID = Zotero.Libraries.userLibraryID;
    try {
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("auto");
      const { registry, context } = writeContext(
        "create_collection",
        { collectionName: name, parentCollectionId: null },
        `Create one collection named "${name}" in My Library. Do not merge them yet and do not create any papers or notes.`,
      );
      registry.register(
        (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
          "collection_update",
        ),
      );
      const execution = await registry.prepareExecution(
        {
          id: "collection-create",
          name: "collection_update",
          arguments: { action: "create", libraryID, name },
        },
        context,
        { callerKind: "model" },
      );
      assert.equal(execution.kind, "result");
      if (execution.kind !== "result") return;
      const created = Zotero.Collections.getByLibrary(libraryID, true).filter(
        (collection) => collection.name === name,
      );
      assert.lengthOf(created, 1);
      assert.isFalse(Boolean(created[0].deleted));
      assert.isTrue(
        execution.execution.result.ok,
        JSON.stringify(execution.execution.result.content),
      );
      assert.equal(
        execution.execution.result.actionReceipts?.[0].verification,
        "verified",
      );
      assert.equal(
        execution.execution.result.actionReceipts?.[0].status,
        "applied",
      );
    } finally {
      setOriginalAgentPermissionMode(originalMode);
      for (const collection of Zotero.Collections.getByLibrary(
        libraryID,
        true,
      ).filter((collection) => collection.name === name))
        await collection.eraseTx();
    }
  });

  it("searches only the native trash when deleted:true is requested", async function () {
    const items: Zotero.Item[] = [];
    const title = `Behavior deleted search ${Date.now()}`;
    try {
      for (const deleted of [false, true]) {
        const item = new Zotero.Item("journalArticle");
        item.libraryID = Zotero.Libraries.userLibraryID;
        item.setField("title", title);
        item.deleted = deleted;
        await item.saveTx();
        items.push(item);
      }
      const tool = createQueryLibraryTool(new ZoteroGateway());
      for (const deleted of [false, true]) {
        const parsed = tool.validate({
          entity: "items",
          mode: "search",
          libraryID: items[0].libraryID,
          text: title,
          filters: { deleted },
          limit: 10,
        });
        assert.isTrue(parsed.ok);
        if (!parsed.ok) return;
        const result = (await tool.execute(parsed.value, {
          request: {},
          item: null,
        } as never)) as any;
        assert.deepEqual(
          result.results.map((row: { itemId: number }) => row.itemId),
          [items[deleted ? 1 : 0].id],
        );
      }
    } finally {
      for (const item of items) await item.eraseTx();
    }
  });

  it("allows a confined read script to inspect a native item while a note-write obligation is pending", async function () {
    const originalMode = getOriginalAgentPermissionMode();
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote("<p>Unchanged source</p>");
    await note.saveTx();
    try {
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("auto");
      const { registry, context } = writeContext(
        "note_edit",
        { targetNoteId: note.id },
        `Edit note ${note.id}.`,
      );
      registry.register(
        (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
          "zotero_script",
        ),
      );
      const execution = await registry.prepareExecution(
        {
          id: "read-before-edit",
          name: "zotero_script",
          arguments: {
            access: "library",
            effect: "read",
            description: "Read the current note title",
            script: `return Zotero.Items.get(${note.id}).getField("title");`,
          },
        },
        context,
        { callerKind: "model" },
      );
      assert.equal(execution.kind, "result");
      if (execution.kind !== "result") return;
      assert.isTrue(
        execution.execution.result.ok,
        JSON.stringify(execution.execution.result.content),
      );
      assert.include(
        JSON.stringify(execution.execution.result.content),
        "Unchanged source",
      );
      assert.isEmpty(execution.execution.result.actionReceipts || []);
      assert.equal(note.getNote(), "<p>Unchanged source</p>");
    } finally {
      setOriginalAgentPermissionMode(originalMode);
      await note.eraseTx();
    }
  });

  for (const example of [
    {
      name: "attribute text",
      html: '<p title="alpha">alpha</p>',
      find: "alpha",
      replacement: "delta",
      text: "delta",
      attribute: "alpha",
    },
    {
      name: "astral entities",
      html: "<p>&#x1F9E0; A &amp; B</p>",
      find: "A & B",
      replacement: "C & D",
      text: "🧠 C & D",
    },
    {
      name: "inline boundaries",
      html: "<p>alpha <em>beta</em> gamma.</p>",
      find: "alpha beta",
      replacement: "delta",
      text: "delta gamma.",
    },
  ]) {
    it(`edits native visible text across ${example.name} while preserving its structure`, async function () {
      const originalMode = getOriginalAgentPermissionMode();
      const note = new Zotero.Item("note");
      note.libraryID = Zotero.Libraries.userLibraryID;
      note.setNote(example.html);
      await note.saveTx();
      try {
        await initAgentChangeJournal();
        setOriginalAgentPermissionMode("auto");
        const { registry, context } = writeContext(
          "note_edit",
          { noteMode: "edit", targetNoteId: note.id },
          `In note ${note.id}, replace only "${example.find}" with "${example.replacement}".`,
        );
        registry.register(
          (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
            "note_write",
          ),
        );
        const execution = await registry.prepareExecution(
          {
            id: "patch",
            name: "note_write",
            arguments: {
              mode: "edit",
              targetNoteId: note.id,
              patches: [{ find: example.find, replace: example.replacement }],
            },
          },
          context,
          { callerKind: "model" },
        );
        assert.equal(
          execution.kind,
          "result",
          "Auto must emit zero routine note confirmations",
        );
        if (execution.kind !== "result")
          throw new Error("Unexpected Auto confirmation");
        const applied = execution;
        assert.equal(applied.kind, "result");
        if (applied.kind !== "result") return;
        assert.isTrue(
          applied.execution.result.ok,
          JSON.stringify(applied.execution.result.content),
        );
        await note.reload(undefined, true);
        const template = Zotero.getMainWindow().document.createElement(
          "template",
        ) as HTMLTemplateElement;
        template.innerHTML = note.getNote();
        assert.equal(template.content.textContent?.trim(), example.text);
        if ("attribute" in example)
          assert.equal(
            template.content.querySelector("p")?.getAttribute("title"),
            example.attribute,
          );
        if (example.name === "inline boundaries")
          assert.match(note.getNote(), /<em><\/em>/);
        assert.equal(
          applied.execution.result.actionReceipts?.[0].verification,
          "verified",
        );
      } finally {
        setOriginalAgentPermissionMode(originalMode);
        await note.eraseTx();
      }
    });
  }
});
