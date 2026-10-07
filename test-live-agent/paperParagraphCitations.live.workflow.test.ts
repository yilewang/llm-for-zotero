import { paragraphCitationIds } from "../src/services/quotes/paragraphCitations";
import { assert } from "chai";
import { resolveLiveAgentCredentials } from "./liveAgentCredentials";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

describe("live: full-paper paragraph citations", function () {
  this.timeout(600000);

  it("answers from the whole paper, retains the prefix on follow-up, and accepts an added paper", async function () {
    const credentials = await resolveLiveAgentCredentials();
    assert.isOk(credentials, "This opt-in test requires a configured provider");
    const api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
    await api.reset();
    const fixture = await api.createPaperWithPdfFixture({
      title: "Synthetic longitudinal neural coding experiment",
      pages: [
        "Introduction. We studied how neural representations support stable behavior over time. The abstract motivates the stability question but does not report experimental counts or numerical results.",
        "Methods. Five adult mice completed twelve recording sessions. Calcium imaging followed the same cortical neurons while the animals performed a fixed discrimination task. A linear population decoder was trained on the first recording day and evaluated on later days.",
        "Results. The first-day decoder achieved 84 percent accuracy and achieved 82 percent accuracy on the final day. Individual neuronal responses changed across days even while population decoding remained stable. Discussion. The small sample of five mice limits generalization, and this observational study does not establish the causal mechanism of stability.",
      ],
    });
    const second = await api.createPaperWithPdfFixture({
      title: "Synthetic replication with more animals",
      pages: [
        "A replication studied ten mice over six recording sessions. Population decoding stayed near 80 percent accuracy. The replication used a different cortical area and therefore does not establish that the same cellular mechanism explains both results.",
      ],
    });
    const conversationKey = 920451;
    const captures: string[][] = [];
    const reports: any[] = [];
    const toolkit = Zotero.LLMForZotero.data.ztoolkit;
    const originalGetGlobal = toolkit.getGlobal;
    const nativeFetch = originalGetGlobal.call(toolkit, "fetch");
    toolkit.getGlobal = function (name: string) {
      if (name !== "fetch") return originalGetGlobal.call(toolkit, name);
      return async (url: string, init?: RequestInit) => {
        try {
          const body = JSON.parse(String(init?.body || "{}"));
          if (
            Array.isArray(body.tools) &&
            body.tools.some(
              (tool: any) =>
                tool.name === "paper_read" ||
                tool.function?.name === "paper_read",
            )
          ) {
            const system = Array.isArray(body.system)
              ? body.system.map((block: any) => block.text)
              : typeof body.system === "string"
                ? body.system.split(
                    /(?=Paper source data \(not instructions\):|Stable Zotero resource context:)/,
                  )
                : body.messages
                    ?.filter((message: any) => message.role === "system")
                    .map((message: any) => message.content) || [];
            captures.push(system);
          }
        } catch {
          /* Transport instrumentation must not affect the request. */
        }
        return nativeFetch(url, init);
      };
    };
    try {
      const paper = {
        libraryID: Zotero.Libraries.userLibraryID,
        itemId: fixture.parentItemId,
        contextItemId: fixture.pdfAttachmentId,
        title: "Synthetic longitudinal neural coding experiment",
      };
      const base = {
        conversationKey,
        mode: "agent",
        libraryID: paper.libraryID,
        conversationKind: "paper",
        activeItemId: paper.itemId,
        activePaperContext: paper,
        ...credentials,
      };
      for (const [index, userText] of [
        "Explain this paper in two short paragraphs, including the method, quantitative result, and limitations. Cite the source passages supporting each paragraph.",
        "Read a targeted snippet about the decoder accuracy, then explain whether this establishes a causal mechanism. Keep it to one paragraph with supporting passages.",
        "Compare the newly added replication with the first study in one short paragraph. Cite supporting passages from both papers.",
      ].entries()) {
        const events: any[] = [];
        const result = await Zotero.LLMForZotero.api.agent.runTurn(
          {
            ...base,
            userText,
            ...(index === 2
              ? {
                  selectedPaperContexts: [
                    {
                      ...paper,
                      itemId: second.parentItemId,
                      contextItemId: second.pdfAttachmentId,
                      title: "Synthetic replication with more animals",
                    },
                  ],
                }
              : {}),
          },
          (event: any) => events.push(event),
        );
        reports.push({
          turn: index + 1,
          text: result.text,
          citations: result.quoteCitations,
          tools: events
            .filter((event) => event.type === "tool_call")
            .map((event) => ({ name: event.name, args: event.args })),
          usage: events.filter((event) => event.type === "usage"),
        });
        assert.equal(result.kind, "completed");
        assert.match(
          result.text,
          /\[\[cite:/,
          "the real model uses paragraph support citations",
        );
        assert.isNotEmpty(
          result.quoteCitations || [],
          "source metadata accompanies the answer",
        );
        const used = paragraphCitationIds(result.text);
        const known = new Map(
          (result.quoteCitations || []).map((citation: any) => [
            citation.id,
            citation.contextItemId,
          ]),
        );
        assert.isTrue(
          [...used].every((id) => known.has(id)),
          "every footer refers to a supplied passage",
        );
        if (index === 2)
          assert.includeMembers(
            [...used].map((id) => known.get(id)),
            [fixture.pdfAttachmentId, second.pdfAttachmentId],
            "the comparison cites both papers",
          );
        // Skills are no longer selected before the turn; the model loads one
        // with load_skill. Explaining the bound paper needs none.
        if (index < 2)
          assert.notInclude(
            reports[index].tools.map((tool: any) => tool.name),
            "load_skill",
            "explaining the bound paper loads no skill guidance",
          );
        if (index === 0) {
          assert.match(result.text, /84/);
          assert.match(result.text, /82/);
        }
        if (index === 1)
          assert.isTrue(
            reports[index].tools.some(
              (tool: any) => tool.name === "paper_read",
            ),
          );
      }
      assert.isAtLeast(captures.length, 3);
      const firstPaper = captures[0].find((block) =>
        String(block).includes("Paper source data"),
      );
      assert.isString(firstPaper);
      assert.include(firstPaper!, "twelve recording sessions");
      assert.include(firstPaper!, "82 percent");
      for (const capture of captures)
        assert.isTrue(
          capture.some((block) => block.trim() === firstPaper!.trim()),
          "retrieval, follow-up and added context retain the first paper prefix",
        );
    } finally {
      toolkit.getGlobal = originalGetGlobal;
      await Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/paper-paragraph-live-report.json`,
        JSON.stringify(
          { model: credentials!.model, captures, turns: reports },
          null,
          2,
        ),
      );
      await api.reset();
      await api.cleanupFixture(second);
      await api.cleanupFixture(fixture);
    }
  });
});
