import {
  semanticContractFixture,
  classifiedFixture,
  semanticResponseFixture,
} from "../test/helpers/semanticIntent";
import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import type { AgentActionContract, AgentToolContext } from "../src/agent/types";

describe("workflow: native source-note copy", function () {
  this.timeout(60000);

  it("copies native content and owns copied embedded images without a confirmation or a second header", async function () {
    const originalMode = getOriginalAgentPermissionMode();
    const source = new Zotero.Item("note");
    source.libraryID = Zotero.Libraries.userLibraryID;
    source.setNote("<h1>Original note</h1>");
    await source.saveTx();
    const destination = new Zotero.Collection();
    destination.libraryID = source.libraryID;
    destination.name = "Native copy destination";
    await destination.saveTx();
    let copied: Zotero.Item | undefined;
    try {
      const win = Zotero.getMainWindow() as any;
      const pixels = Uint8Array.from(
        win.atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBc8AAAAASUVORK5CYII=",
        ),
        (c: string) => c.charCodeAt(0),
      );
      const image = await Zotero.Attachments.importEmbeddedImage({
        blob: new win.Blob([pixels], { type: "image/png" }),
        parentItemID: source.id,
      });
      source.setNote(
        `<p><strong>Original provenance</strong></p><p><strong>Model response:</strong> original-model</p><div><h1>Original note</h1><p>The paper&#039;s preserved paragraph: &amp;lt;literal&amp;gt; and variable_name.</p><img data-attachment-key="${image.key}" alt="Fixture figure"></div><hr><p>Written by LLM-for-Zotero.</p>`,
      );
      await source.saveTx();
      await source.reload(undefined, true);
      const originalHtml = source.getNote();
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("auto");
      const contracts = new ActionContractService(new ZoteroGateway());
      const registry = new AgentToolRegistry(contracts);
      registry.register(
        (Zotero as any).LLMForZotero.api.agent.getToolDefinition("note_write"),
      );
      const contract: AgentActionContract = semanticContractFixture({
        version: 3,
        id: "native-copy",
        hardConstraints: [],
        writeDisposition: "required",
        interpretationSource: "semantic",
        obligations: [
          {
            id: "copy",
            operation: "note_create",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            coverage: "one",
            targetKind: "items",
            parameters: { noteMode: "create" },
          },
        ],
      });
      const context: AgentToolContext = {
        request: {
          conversationKey: source.id,
          mode: "agent",
          userText: `Create one standalone copy of note ${source.id}`,
          libraryID: source.libraryID,
          actionContract: contract,
          actionProgress: contracts.createProgress(contract),
        },
        item: null,
        modelName: "workflow",
        currentAnswerText: "",
      };
      const execution = await registry.prepareExecution(
        {
          id: "copy",
          name: "note_write",
          arguments: {
            mode: "create",
            target: "standalone",
            sourceNoteId: source.id,
            collections: [destination.id],
          },
        },
        context,
        { callerKind: "model" },
      );
      assert.equal(
        execution.kind,
        "result",
        "copy creation must not ask for confirmation",
      );
      if (execution.kind !== "result") return;
      const result = execution.execution.result;
      assert.isTrue(result.ok, JSON.stringify(result.content));
      assert.isTrue(
        result.actionReceipts!.some((receipt) => receipt.status === "applied"),
      );
      const created = destination
        .getChildItems()
        .filter((item) => item.isNote());
      assert.lengthOf(created, 1);
      copied = created[0];
      await copied.reload(undefined, true);
      assert.isFalse(Boolean(copied.parentID));
      const images = copied.getAttachments().map((id) => Zotero.Items.get(id));
      assert.lengthOf(images, 1);
      assert.notEqual(images[0].key, image.key);
      assert.equal(images[0].parentID, copied.id);
      assert.isTrue(await images[0].fileExists());
      assert.equal(
        copied.getNote().replace(images[0].key, image.key),
        originalHtml,
      );
      assert.equal(source.getNote(), originalHtml);
      assert.equal(
        (copied.getNote().match(/Model response:/g) || []).length,
        1,
      );
      const copiedBefore = copied.getNote();
      const editContract: AgentActionContract = {
        ...contract,
        id: "native-encoded-note-edit",
        obligations: [
          {
            id: "edit",
            operation: "note_edit",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            coverage: "one",
            targetKind: "items",
            parameters: { noteMode: "edit", targetNoteId: copied.id },
          },
        ],
      };
      const edit = await registry.prepareExecution(
        {
          id: "edit",
          name: "note_write",
          arguments: {
            mode: "edit",
            targetNoteId: copied.id,
            patches: [
              { find: "preserved paragraph", replace: "reviewed paragraph" },
            ],
          },
        },
        {
          ...context,
          request: {
            ...context.request,
            userText: `In note ${copied.id}, replace only "preserved paragraph" with "reviewed paragraph". Keep all other content.`,
            actionContract: editContract,
            actionProgress: contracts.createProgress(editContract),
          },
        },
      );
      assert.equal(
        edit.kind,
        "result",
        "Auto must emit zero routine note confirmation events",
      );
      if (edit.kind !== "result")
        throw new Error("Unexpected Auto confirmation");
      const applied = edit;
      assert.equal(applied.kind, "result");
      if (applied.kind !== "result") return;
      await copied.reload(undefined, true);
      assert.equal(
        copied.getNote(),
        copiedBefore.replace("preserved paragraph", "reviewed paragraph"),
      );
      assert.equal(
        applied.execution.result.actionReceipts?.[0].verification,
        "verified",
        "native encoding and a literal entity must not cause a false write failure",
      );
    } finally {
      setOriginalAgentPermissionMode(originalMode);
      if (copied) await copied.eraseTx();
      await source.eraseTx();
      await destination.eraseTx();
    }
  });
});
