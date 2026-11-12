import { assert } from "chai";
import { resolveLiveAgentCredentials } from "./liveAgentCredentials";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../../src/agent/originalAgentPermissionMode";
import { canonicalNoteHtml } from "../../src/utils/noteHtml";
import { renderRawNoteHtml } from "../../src/services/notes/noteRendering";

declare const Zotero: any;

describe("live: concise skill guidance", function () {
  this.timeout(600000);

  it("preserves an existing answer, scopes statistics, and completes an ordinary review", async function () {
    assert.isTrue(Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"));
    const credentials = await resolveLiveAgentCredentials();
    assert.isOk(
      credentials,
      "This opt-in acceptance needs a configured provider",
    );
    const api = Zotero.LLMForZotero.api;
    const workflow = api.workflowTest;
    const mode = getOriginalAgentPermissionMode();
    const fixtures: any[] = [];
    const runs: any[] = [];
    const collection = new Zotero.Collection();
    collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = `Concise skill acceptance ${Date.now()}`;
    await collection.saveTx();
    const base = {
      mode: "agent",
      libraryID: collection.libraryID,
      conversationKind: "global",
      ...credentials,
    };
    const corpus = [
      {
        libraryID: collection.libraryID,
        collectionId: collection.id,
        name: collection.name,
      },
    ];
    async function turn(request: any) {
      const events: any[] = [];
      const result = await api.agent.runTurn(
        { ...base, ...request },
        (event: any) => {
          if (
            ["tool_call", "tool_result", "usage", "status"].includes(event.type)
          )
            events.push(event);
          if (event.type === "confirmation_required") {
            // These fixtures authorize only the concrete save requested below.
            void api.agent.resolveConfirmation(
              event.requestId,
              event.action.toolName !== "request_user_input",
            );
          }
        },
      );
      runs.push({
        request: request.userText,
        skills: request.forcedSkillIds,
        result,
        events,
      });
      assert.equal(
        result.kind,
        "completed",
        JSON.stringify({ kind: result.kind, text: result.text }),
      );
      return { result, events };
    }
    try {
      setOriginalAgentPermissionMode("auto");
      for (const [index, text] of [
        "Study A measured a synthetic population decoder in five mice over twelve sessions. Accuracy fell from 84 percent to 82 percent despite changing individual neural responses. The observational design does not identify a causal mechanism.",
        "Study B measured a synthetic population decoder in ten mice over six sessions in a different cortical area. Accuracy stayed near 80 percent. The different cortical area and shorter observation period limit direct comparison with Study A.",
      ].entries()) {
        const fixture = await workflow.createPaperWithPdfFixture({
          title: `Skill evidence ${index + 1}`,
          pdfTitle: `Skill source ${index + 1}`,
          pages: [text],
        });
        fixtures.push(fixture);
        const paper = Zotero.Items.get(fixture.parentItemId);
        paper.addToCollection(collection.id);
        await paper.saveTx();
      }
      const answer =
        "# Preserved observation\n\nExact coefficient: **0.125**.\n\nThis is a synthetic example, not an empirical estimate.";
      const saved = await turn({
        conversationKey: 920461,
        forcedSkillIds: ["write-note"],
        selectedCollectionContexts: corpus,
        history: [
          { role: "user", content: "State the observation." },
          {
            role: "assistant",
            content: answer,
            messageId: "concise-skill-answer",
          },
        ],
        userText: `Save the preceding assistant answer unchanged as one standalone Zotero note in collection ${collection.id}. Preserve every word and heading; do not add content.`,
      });
      await collection.reload(undefined, true);
      const notes = collection
        .getChildItems()
        .filter((item: any) => item.isNote());
      assert.lengthOf(notes, 1);
      assert.equal(
        canonicalNoteHtml(notes[0].getNote()),
        canonicalNoteHtml(renderRawNoteHtml(answer)),
      );
      const writes = saved.events.filter(
        (event: any) =>
          event.type === "tool_call" && event.name === "note_write",
      );
      assert.isTrue(
        writes.some((event: any) => Boolean(event.args?.sourceMessageId)),
        "saving unchanged uses the stored answer identity",
      );

      const statistics = await turn({
        conversationKey: 920462,
        forcedSkillIds: ["library-analysis"],
        selectedCollectionContexts: corpus,
        userText:
          "How many regular bibliographic items are in the selected collection? Exclude notes and attachments. Answer in one sentence with the count; do not modify anything.",
      });
      assert.match(statistics.result.text, /\b2\b|\btwo\b/i);
      assert.isFalse(
        statistics.events.some(
          (event: any) =>
            event.type === "tool_call" && event.name === "note_write",
        ),
      );

      const review = await turn({
        conversationKey: 920463,
        forcedSkillIds: ["literature-review"],
        selectedPaperContexts: fixtures.map((fixture, index) => ({
          libraryID: collection.libraryID,
          itemId: fixture.parentItemId,
          contextItemId: fixture.pdfAttachmentId,
          title: `Skill evidence ${index + 1}`,
        })),
        userText:
          "Write a short narrative review of these two synthetic studies, connecting their findings and explaining the limits of the comparison. Use only these papers and finalize a review document. Do not start a Plan or save a Zotero note.",
      });
      const calls = review.events
        .filter((event: any) => event.type === "tool_call")
        .map((event: any) => event.name);
      assert.include(calls, "submit_document");
      assert.notInclude(calls, "research_update");
      assert.notInclude(calls, "note_write");
      assert.isTrue(
        review.events.some(
          (event: any) =>
            event.type === "tool_result" &&
            event.name === "submit_document" &&
            event.ok,
        ),
      );
    } finally {
      setOriginalAgentPermissionMode(mode);
      await Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/skill-guidance-live-report.json`,
        JSON.stringify({ model: credentials!.model, runs }, null, 2),
      );
      await collection.reload(undefined, true);
      for (const item of collection.getChildItems())
        if (item.isNote()) await item.eraseTx();
      for (const fixture of fixtures) await workflow.cleanupFixture(fixture);
      await collection.eraseTx();
      await workflow.reset();
    }
  });
});
