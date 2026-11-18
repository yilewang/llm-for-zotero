import "./hostSurfaceBootstrap";
import { assert } from "chai";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { loadPlanDocument } from "../src/agent/documents/store";
import { normalizeExecutionOutput } from "../src/agent/tools/execution/results";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

const TOPICS = [
  "locally linear embedding manifold learning",
  "isomap geodesic distances dimensionality reduction",
  "t-SNE neighbour embedding visualisation",
  "UMAP uniform manifold approximation",
  "principal component analysis linear dimensionality reduction",
  "laplacian eigenmaps spectral embedding",
  "diffusion maps manifold geometry",
  "autoencoders nonlinear dimensionality reduction",
  "hippocampal place cells representational drift",
  "grid cells entorhinal cortex path integration",
  "dopamine reward prediction error",
  "transformer attention language models",
  "convolutional networks image classification",
  "reinforcement learning policy gradients",
  "bayesian inference variational methods",
  "graph neural networks message passing",
];
const PAPER_COUNT = 32;
const PAGES = 12;

function pageText(topic: string, paper: number, page: number): string {
  const heading =
    page === 1
      ? "Abstract. Introduction."
      : page === 4
        ? "2 Methods."
        : page === 8
          ? "3 Results."
          : page === 11
            ? "4 Discussion."
            : "";
  const sentences: string[] = [heading];
  for (let index = 0; index < 22; index += 1) {
    sentences.push(
      `In study ${paper}, page ${page}, sentence ${index}, we examine ${topic} and report how the method behaves on high-dimensional data with neighbourhood structure, reconstruction weights and low-dimensional coordinates.`,
    );
  }
  return sentences.join(" ");
}

type McpPayload = {
  ok: boolean;
  result: any;
  documentEvidenceRefs?: Array<{ evidenceRef: string; itemKey: string }>;
};

/**
 * What an MCP client's model reads. A library_retrieve result is sent whole:
 * the client has no tool-result handle to page rows a sized view would leave
 * out. A targeted paper_read shows its passages once. Every row keeps its
 * citation ids and evidence refs, and a short evidence ref is citable. Real
 * items with multi-page PDFs, called through the installed plugin's MCP
 * endpoint.
 */
describe("workflow: MCP tool result size", function () {
  this.timeout(600000);
  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  async function call(
    name: string,
    args: Record<string, unknown>,
    scopeToken?: string,
    expectOk = true,
  ): Promise<{ payload: McpPayload; bytes: number }> {
    const EndpointClass = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
    const [status, , body] = await new EndpointClass().init({
      method: "POST",
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
        ...(scopeToken ? { [ZOTERO_MCP_SCOPE_HEADER]: scopeToken } : {}),
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
    assert.equal(status, 200);
    const response = JSON.parse(body);
    assert.isOk(response.result, body.slice(0, 1000));
    const text = response.result.content[0].text as string;
    const payload = JSON.parse(text) as McpPayload;
    assert.equal(payload.ok, expectOk, text.slice(0, 500));
    return { payload, bytes: text.length };
  }

  function itemKey(itemId: unknown): string {
    return Zotero.Items.get(Number(itemId)).key;
  }

  /** Every shown passage's paper has an evidence ref, and its quote a record. */
  function assertShownRowsCitable(payload: McpPayload) {
    const refKeys = new Set(
      (payload.documentEvidenceRefs || []).map((ref) => ref.itemKey),
    );
    const quoteIds = new Set(
      ((payload.result.quoteCitations || []) as Array<{ id: string }>).map(
        (citation) => citation.id,
      ),
    );
    for (const snippet of payload.result.snippets as Array<
      Record<string, unknown>
    >) {
      assert.isTrue(
        refKeys.has(itemKey(snippet.itemId)),
        `an evidence ref for the paper of ${snippet.snippetId}`,
      );
      if (snippet.quoteCitationId)
        assert.isTrue(
          quoteIds.has(String(snippet.quoteCitationId)),
          `the quote record of ${snippet.snippetId}`,
        );
    }
  }

  before(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (let paper = 1; paper <= PAPER_COUNT; paper += 1) {
      const topic = TOPICS[(paper - 1) % TOPICS.length];
      const title = `${topic} (study ${paper})`;
      const pages: string[] = [];
      for (let page = 1; page <= PAGES; page += 1)
        pages.push(pageText(topic, paper, page));
      fixtures.push(
        await api.createPaperWithPdfFixture({
          title,
          pdfTitle: title,
          pages,
          creators: ["Roweis", "Saul"],
          date: "2001",
        }),
      );
    }
  });

  after(async function () {
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await api.reset();
  });

  it("sends library_retrieve whole, with the refs and quotes of every row", async function () {
    const tool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
      "library_retrieve",
    );
    for (const intent of ["enumerate", "summarize"]) {
      const args = {
        query: "manifold learning dimensionality reduction",
        queryVariants: ["manifold learning", "dimensionality reduction"],
        intent,
      };
      const { payload } = await call("library_retrieve", args);
      const result = payload.result;
      // The same call run directly: the client reads every row it returns.
      const validated = tool.validate(args);
      assert.isTrue(validated.ok, JSON.stringify(validated));
      const whole = normalizeExecutionOutput(
        await tool.execute(validated.value, {
          item: null,
          currentAnswerText: "",
          modelName: "workflow",
          request: resolvedAgentRequest({
            conversationKey: 1,
            mode: "agent",
            userText: "Which papers are about manifold learning?",
            libraryID: Zotero.Libraries.userLibraryID,
          }),
          runId: `mcp-whole:${intent}:${Date.now()}`,
        }),
      ).content as {
        snippets: Array<{ snippetId: string }>;
        paperMatches: unknown[];
      };
      assert.notProperty(result, "omitted", intent);
      assert.isNotEmpty(whole.snippets, intent);
      assert.sameMembers(
        (result.snippets as Array<{ snippetId: string }>).map(
          (snippet) => snippet.snippetId,
        ),
        whole.snippets.map((snippet) => snippet.snippetId),
        `${intent}: every passage`,
      );
      assert.lengthOf(
        result.paperMatches,
        whole.paperMatches.length,
        `${intent}: every paper`,
      );
      assertShownRowsCitable(payload);
    }
  });

  it("shows a targeted paper_read's passages once, with their quote records", async function () {
    const { payload } = await call("paper_read", {
      mode: "targeted",
      target: { itemId: fixtures[0].parentItemId },
      query: "summary of the method and its main result",
    });
    const result = payload.result;
    assert.notProperty(result, "results", "the grouped rows are not repeated");
    const passages = (
      result.papers as Array<{ passages: Array<Record<string, unknown>> }>
    ).flatMap((paper) => paper.passages);
    assert.isNotEmpty(passages);
    const quoteIds = new Set(
      (result.quoteCitations as Array<{ id: string }>).map(
        (citation) => citation.id,
      ),
    );
    for (const citation of result.quoteCitations as Array<
      Record<string, unknown>
    >) {
      // The host's match bookkeeping stays out of the model's records.
      for (const field of [
        "sourceMatchKind",
        "sourceMatchSource",
        "sourceFingerprint",
        "allowShortQuoteText",
      ])
        assert.notProperty(citation, field);
      if ("sourceMatchText" in citation)
        assert.notEqual(citation.sourceMatchText, citation.quoteText);
      assert.isString(citation.quoteText);
      assert.isString(citation.citationLabel);
    }
    for (const passage of passages) {
      assert.isString(passage.text);
      for (const id of (passage.quoteCitationIds as string[]) || [])
        assert.isTrue(quoteIds.has(id), `quote record ${id}`);
    }
    assert.include(
      (payload.documentEvidenceRefs || []).map((ref) => ref.itemKey),
      itemKey(fixtures[0].parentItemId),
    );
  });
  it("cites a short evidence ref an MCP read returned in a submitted document", async function () {
    const paper = Zotero.Items.get(fixtures[0].parentItemId);
    const runId = `mcp-short-ref:${Date.now()}`;
    // Registered in the installed plugin's MCP server, whose scopes this
    // bundle's copy of the module does not share.
    const scope = api.registerScopedMcpScope({
      conversationKey: paper.id,
      libraryID: paper.libraryID,
      kind: "paper",
      runId,
      runtimeAuthority: "claude",
    });
    try {
      const read = await call(
        "paper_read",
        { mode: "overview", target: { itemId: paper.id } },
        scope.token,
      );
      const refs = (read.payload.documentEvidenceRefs || []) as Array<{
        evidenceRef: string;
        itemKey: string;
        capabilities: string[];
      }>;
      const body = refs.find(
        (ref) => ref.itemKey === paper.key && ref.capabilities.includes("body"),
      );
      assert.isOk(body, JSON.stringify(refs));
      assert.match(body!.evidenceRef, /^[0-9a-f]{12}:\d+$/, "a short ref");
      const submit = (evidenceRef: string, expectOk = true) =>
        call(
          "submit_document",
          {
            title: "Short ref finding",
            markdown: "# Finding\n\nThe method embeds data [[cite:C1]].",
            citations: [
              {
                citationId: "C1",
                sources: [
                  {
                    libraryID: paper.libraryID,
                    itemKey: paper.key,
                    evidenceRefs: [evidenceRef],
                  },
                ],
              },
            ],
            quotes: [],
            assets: [],
            groundingReviewed: "passed",
            groundingIssues: [],
          },
          scope.token,
          expectOk,
        );
      // A short ref no read of this conversation issued is refused.
      await submit("000000000000:1", false);
      const { payload } = await submit(body!.evidenceRef);
      const document = await loadPlanDocument(payload.result.documentId);
      assert.isOk(document, "the document is published");
      // The stored document names the full observation id.
      assert.match(
        JSON.stringify(document),
        new RegExp(`sha256:${body!.evidenceRef.split(":")[0]}[0-9a-f]{52}:`),
      );
    } finally {
      api.clearScopedMcpScope(scope.token);
    }
  });
});
