import { assert } from "chai";
import { resolveLiveAgentCredentials } from "./liveAgentCredentials";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";

declare const Zotero: any;

describe("live: selected note rewrite", function () {
  this.timeout(420000);
  for (const paragraph of [false, true])
    it(`${paragraph ? "paragraph rewrite" : "faithful rewrite"}: completes in one verified action without researching the library`, async function () {
      const creds = await resolveLiveAgentCredentials({
        requestedModel: "deepseek-v4-flash",
      });
      assert.isNotNull(creds, "DeepSeek acceptance must execute, not skip");
      const api = Zotero.LLMForZotero.api;
      const fixture = await api.workflowTest.createPaperWithPdfFixture({
        title: "Semantic workflow population coding plan",
        pdfTitle: "Synthetic semantic workflow acceptance paper",
        pages: [
          "This is a synthetic experiment. Simulated neural recordings cover twelve sessions. A linear decoder fitted on session one is tested on remaining sessions. The control shuffles neuron identities.",
        ],
      });
      const note = new Zotero.Item("note");
      note.libraryID = Zotero.Libraries.userLibraryID;
      const selected =
        "Methodology\n\nSimulated neural population recordings across twelve sessions.\nA linear decoder was fitted on session one and tested on the remaining sessions.\nThe control condition shuffled neuron identities.";
      const prefix =
        "<h1>Semantic workflow population coding plan</h1><p>Keep this introduction.</p>";
      const suffix =
        "<h2>Limitations</h2><p>Only simulated data and linear decoders were studied.</p>";
      note.setNote(
        prefix +
          "<h2>Methodology</h2><ul><li>Simulated neural population recordings across twelve sessions.</li><li>A linear decoder was fitted on session one and tested on the remaining sessions.</li><li>The control condition shuffled neuron identities.</li></ul>" +
          suffix,
      );
      await note.saveTx();
      const permission = getOriginalAgentPermissionMode();
      setOriginalAgentPermissionMode("auto");
      const calls: string[] = [],
        writes: any[] = [],
        errors: any[] = [],
        usage: any[] = [];
      let reasoningChars = 0;
      const start = Date.now();
      try {
        const result = await api.agent.runTurn(
          {
            conversationKey: note.id,
            mode: "agent",
            libraryID: note.libraryID,
            userText: paragraph
              ? "Rewrite this part as one concise paragraph."
              : "rewrite this part",
            activeItemId: note.id,
            activeNoteContext: {
              noteId: note.id,
              title: note.getNoteTitle(),
              noteKind: "standalone",
              noteText: note.getNote(),
              noteHtml: note.getNote(),
            },
            selectedTexts: [selected],
            selectedTextSources: ["note-edit"],
            selectedTextNoteContexts: [
              {
                noteItemId: note.id,
                noteItemKey: note.key,
                libraryID: note.libraryID,
                noteKind: "standalone",
                title: note.getNoteTitle(),
              },
            ],
            selectedPaperContexts: [
              {
                libraryID: note.libraryID,
                itemId: fixture.parentItemId,
                contextItemId: fixture.pdfAttachmentId,
                title: "Semantic workflow population coding plan",
              },
            ],
            ...creds,
          },
          (event: any) => {
            if (event.type === "tool_call") calls.push(event.name);
            if (event.type === "tool_result" && event.name === "note_write")
              writes.push(event);
            if (event.type === "tool_error")
              errors.push({ name: event.name, error: event.error });
            if (event.type === "usage") usage.push(event);
            if (event.type === "reasoning")
              reasoningChars += (event.details || event.summary || "").length;
            if (event.type === "confirmation_required")
              void api.agent.resolveConfirmation(event.requestId, true);
          },
        );
        await note.reload(["note"], true);
        await Zotero.File.putContentsAsync(
          `/tmp/note-rewrite-${paragraph ? "paragraph" : "faithful"}-benchmark.json`,
          JSON.stringify(
            {
              elapsedMs: Date.now() - start,
              calls,
              errors,
              usage,
              reasoningChars,
              kind: result.kind,
              html: note.getNote(),
            },
            null,
            2,
          ),
        );
        assert.equal(result.kind, "completed");
        assert.deepEqual(
          calls,
          ["note_write"],
          "a self-contained rewrite needs one note action, no paper search/read or cleanup",
        );
        assert.lengthOf(writes, 1);
        assert.isTrue(writes[0].ok);
        assert.isTrue(
          writes[0].actionReceipts?.some(
            (r: any) => r.verification === "verified",
          ),
        );
        assert.isEmpty(errors);
        assert.equal(
          reasoningChars,
          0,
          "faithful note transformations must not trigger extended reasoning",
        );
        assert.deepEqual(
          [...new Set(usage.map((u) => u.round))],
          [1],
          "the native receipt must finish the rewrite without another model round",
        );
        assert.notMatch(
          note.getNote(),
          /<li[^>]*>\s*(?:<p>\s*<\/p>\s*)?<\/li>/i,
        );
        assert.include(note.getNote(), "Keep this introduction.");
        assert.include(
          note.getNote(),
          "Only simulated data and linear decoders were studied.",
        );
        assert.match(note.getNote(), /twelve|12/);
        assert.match(note.getNote(), /shuffl/i);
        assert.match(note.getNote(), /linear decoder/i);
        if (paragraph) {
          const rewritten = note
            .getNote()
            .split("Keep this introduction.</p>")[1]
            ?.split("<h2>Limitations")[0];
          assert.isString(rewritten);
          assert.notMatch(rewritten, /<(?:ul|ol|li)\b/i);
          assert.lengthOf(rewritten.match(/<p(?:\s|>)/g) || [], 1);
        }
      } finally {
        setOriginalAgentPermissionMode(permission);
        await note.eraseTx();
        await api.workflowTest.cleanupFixture(fixture);
      }
    });
});
