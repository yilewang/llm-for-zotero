import "./hostSurfaceBootstrap";
import { assert } from "chai";
import {
  getOrCreateZoteroMcpBearerToken,
  MCP_MODEL_VIEW_NOTICE,
  ZOTERO_MCP_ENDPOINT_PATH,
} from "../src/agent/mcp/server";
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
 * An MCP client's model reads the same sized view of a library_retrieve
 * result as the plugin Agent's model, not the whole stored result, and a
 * targeted paper_read shows its passages once. The views keep the citation
 * ids and evidence refs of every row they show. Real items with multi-page
 * PDFs, called through the installed plugin's MCP endpoint.
 */
describe("workflow: MCP tool result size", function () {
  this.timeout(600000);
  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ payload: McpPayload; bytes: number }> {
    const EndpointClass = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
    const [status, , body] = await new EndpointClass().init({
      method: "POST",
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
    assert.equal(status, 200);
    const text = JSON.parse(body).result.content[0].text as string;
    const payload = JSON.parse(text) as McpPayload;
    assert.isTrue(payload.ok, text.slice(0, 500));
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

  it("sends library_retrieve's sized view with the refs and quotes of the rows it shows", async function () {
    const ours = new Set(
      fixtures.map((fixture) => String(fixture.parentItemId)),
    );
    for (const intent of ["enumerate", "summarize"]) {
      const { payload, bytes } = await call("library_retrieve", {
        query: "manifold learning dimensionality reduction",
        queryVariants: ["manifold learning", "dimensionality reduction"],
        intent,
      });
      const result = payload.result;
      // The view's fields, not the stored result's.
      for (const field of [
        "candidates",
        "synthesisDigest",
        "evidenceLedgerText",
        "queryPlan",
        "coverageReceipt",
      ])
        assert.notProperty(result, field, `${intent}: ${field}`);
      for (const snippet of result.snippets as Array<Record<string, unknown>>) {
        assert.notProperty(snippet, "surroundingText", intent);
        assert.notProperty(snippet, "score", intent);
        assert.isString(snippet.snippet, intent);
      }
      assert.isAbove(result.omitted?.snippets || 0, 0, `${intent}: omitted`);
      assert.equal(result.modelViewNotice, MCP_MODEL_VIEW_NOTICE, intent);
      assertShownRowsCitable(payload);
      assert.isAtMost(bytes, 100_000, `${intent}: ${bytes} characters`);
      if (intent === "enumerate") {
        // Every matching paper of the folder, each with its best passage.
        const matched = (
          result.paperMatches as Array<{ itemId: string; matchStatus: string }>
        ).filter(
          (row) =>
            ours.has(row.itemId) && row.matchStatus !== "not_enough_evidence",
        );
        assert.isAtLeast(matched.length, 8, "the manifold-learning papers");
        const withPassage = new Set(
          (result.snippets as Array<{ itemId: string }>).map(
            (snippet) => snippet.itemId,
          ),
        );
        for (const row of matched)
          assert.isTrue(
            withPassage.has(row.itemId),
            `a passage for ${row.itemId}`,
          );
      }
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
});
