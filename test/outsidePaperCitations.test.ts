/**
 * A document may cite an outside paper: one literature_search or
 * literature_read returned in this run, by its paperId. The host records the
 * run's outside papers itself; the model only names one. These tests hold the
 * record's rules, the source form submit_document accepts, the grounding an
 * outside abstract or text gives, and the stored form of an outside source.
 */
import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  citableOutsidePapers,
  findOutsidePaperRecord,
  mergeOutsidePaperRecords,
  outsidePaperCitationRefusal,
  outsidePaperRecordsFromToolResult,
  rememberOutsidePapers,
  setOutsidePaperSelection,
  type OutsidePaperHolder,
  type OutsidePaperRecord,
} from "../src/agent/context/outsidePaperRecords";
import type { TrustedReadObservation } from "../src/agent/context/readObservationTypes";
import { formatDocumentCitations } from "../src/agent/documents/citationService";
import { decodePlanDocument } from "../src/agent/documents/decoders";
import { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import { documentCitedItems } from "../src/agent/documents/actions";
import {
  initPlanDocumentStore,
  loadPlanDocument,
  PLAN_DOCUMENT_COVERAGE_TABLE,
  savePlanDocumentInTransaction,
} from "../src/agent/documents/store";
import type {
  DocumentArtifactV2,
  PlanCitationCluster,
  PlanDocument,
} from "../src/agent/documents/types";
import { copyMcpCallEvidenceToRequest } from "../src/agent/externalBackendBridge";
import type { ZoteroMcpToolActivityEvent } from "../src/agent/mcp/activityTypes";
import type { LiteratureReadRecord } from "../src/agent/services/literatureReadService";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  createSubmitDocumentTool,
  documentCitedSources,
} from "../src/agent/tools/control/submitDocument";
import { ToolInputRejection } from "../src/agent/tools/execution/failure";
import { buildLiteratureReadResult } from "../src/agent/tools/read/literatureRead";
import type { AgentRuntimeRequest, AgentToolContext } from "../src/agent/types";
import { EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import {
  describePaperSource,
  paperSourceId,
} from "../src/webAccess/paperSources";

const DOI = "10.1000/drift";
const PAPER_ID = paperSourceId(`doi:${DOI}`);
const OTHER_DOI = "10.1000/stable";
const OTHER_ID = paperSourceId(`doi:${OTHER_DOI}`);

const searchRow = {
  title: "Representational drift",
  authors: ["Ada Lovelace", "Alan Turing"],
  year: 2021,
  abstract: "Neurons change their tuning ov...",
  doi: DOI,
  sourceUrl: "https://openalex.org/W1",
};

function readRecord(
  overrides: Partial<LiteratureReadRecord> = {},
): LiteratureReadRecord {
  return {
    identifier: { kind: "doi", value: DOI },
    source: "europepmc",
    paper: {
      title: "Representational drift",
      authors: ["Ada Lovelace"],
      doi: DOI,
      url: "https://europepmc.org/article/MED/1",
    },
    firstCreator: "Lovelace",
    abstract: "Neurons change their tuning over days.",
    fullText: { status: "open_access" },
    sections: [
      {
        number: "1",
        title: "Results",
        level: 1,
        paragraphs: ["Tuning drifts while the readout stays stable."],
      },
    ] as LiteratureReadRecord["sections"],
    ...overrides,
  };
}

function recorded(depth: OutsidePaperRecord["depth"], paperId = PAPER_ID) {
  return {
    paperId,
    title: "Representational drift",
    authors: ["Ada Lovelace"],
    depth,
  } satisfies OutsidePaperRecord;
}

describe("the run's record of outside papers", function () {
  it("records every literature_search row at metadata depth, by the paper's source id", function () {
    const records = outsidePaperRecordsFromToolResult("literature_search", {
      mode: "search",
      results: [searchRow, { title: "No identity at all", authors: [] }],
    });
    assert.lengthOf(records, 1, "a row without an identity is not citable");
    assert.equal(records[0].paperId, PAPER_ID);
    assert.equal(
      records[0].paperId,
      describePaperSource(searchRow)?.sourceId,
      "one paper has one id: the one its chat chip carries",
    );
    assert.deepInclude(records[0], {
      doi: DOI,
      title: "Representational drift",
      year: 2021,
      abstract: "Neurons change their tuning ov...",
      depth: "metadata",
      url: "https://openalex.org/W1",
    });
    assert.deepEqual(records[0].authors, ["Ada Lovelace", "Alan Turing"]);
  });

  it("records nothing for a metadata lookup, a web page or a failed shape", function () {
    assert.isEmpty(
      outsidePaperRecordsFromToolResult("literature_search", {
        mode: "metadata",
        results: [searchRow],
      }),
    );
    assert.isEmpty(
      outsidePaperRecordsFromToolResult("web_search", {
        results: [{ ...searchRow, url: "https://example.com" }],
      }),
    );
    assert.isEmpty(outsidePaperRecordsFromToolResult("literature_read", null));
  });

  it("records literature_read's paper at body depth only when text came back", function () {
    const depthOf = (content: Record<string, unknown>) =>
      outsidePaperRecordsFromToolResult("literature_read", content)[0]?.depth;
    const outline = buildLiteratureReadResult(readRecord(), { textOffset: 0 });
    assert.equal(
      depthOf(outline),
      "abstract",
      "an abstract and an outline are not the paper's text",
    );
    assert.equal(
      depthOf(
        buildLiteratureReadResult(readRecord(), {
          query: "readout",
          textOffset: 0,
        }),
      ),
      "body",
    );
    assert.equal(
      depthOf(
        buildLiteratureReadResult(readRecord(), {
          section: "1",
          textOffset: 0,
        }),
      ),
      "body",
    );
    assert.equal(
      depthOf(
        buildLiteratureReadResult(readRecord({ abstract: "" }), {
          query: "nothing matches this",
          textOffset: 0,
        }),
      ),
      "metadata",
    );
    const abstractOnly = buildLiteratureReadResult(
      readRecord({ fullText: { status: "abstract_only" }, sections: [] }),
      { textOffset: 0 },
    );
    assert.equal(depthOf(abstractOnly), "abstract");
    assert.equal(
      outsidePaperRecordsFromToolResult("literature_read", outline)[0].abstract,
      "Neurons change their tuning over days.",
    );
  });

  it("does not record a paper literature_read could not find", function () {
    const missing = buildLiteratureReadResult(
      readRecord({
        paper: { authors: [], doi: DOI },
        abstract: "",
        fullText: { status: "unavailable", reason: "not_found" },
        sections: [],
      }),
      { textOffset: 0 },
    );
    assert.isEmpty(
      outsidePaperRecordsFromToolResult("literature_read", missing),
    );
    assert.notProperty(
      missing.paper as Record<string, unknown>,
      "paperId",
      "a paper nobody found has no id to cite",
    );
  });

  it("gives literature_read's paper the paperId the record keys it by", function () {
    const result = buildLiteratureReadResult(readRecord(), { textOffset: 0 });
    const paper = result.paper as Record<string, unknown>;
    assert.equal(paper.paperId, PAPER_ID);
    assert.equal(
      outsidePaperRecordsFromToolResult("literature_read", result)[0].paperId,
      PAPER_ID,
    );
  });

  it("keeps one record per paper with its deepest read and every known field", function () {
    const [fromSearch] = outsidePaperRecordsFromToolResult(
      "literature_search",
      { mode: "search", results: [searchRow] },
    );
    const [fromRead] = outsidePaperRecordsFromToolResult(
      "literature_read",
      buildLiteratureReadResult(readRecord(), {
        query: "readout",
        textOffset: 0,
      }),
    );
    assert.notProperty(
      fromRead,
      "abstract",
      "a query read shows passages only",
    );
    const merged = mergeOutsidePaperRecords([fromSearch], [fromRead]);
    assert.lengthOf(merged, 1);
    assert.equal(merged[0].depth, "body");
    assert.equal(merged[0].year, 2021, "the search row fills the read's gap");
    assert.equal(
      merged[0].abstract,
      "Neurons change their tuning ov...",
      "the search abstract fills a read that showed none",
    );
    assert.deepEqual(merged[0].authors, ["Ada Lovelace"]);
    const [fullAbstract] = outsidePaperRecordsFromToolResult(
      "literature_read",
      buildLiteratureReadResult(readRecord(), { textOffset: 0 }),
    );
    const again = mergeOutsidePaperRecords(merged, [fullAbstract, fromSearch]);
    assert.lengthOf(again, 1);
    assert.equal(
      again[0].depth,
      "body",
      "a later shallower read never lowers it",
    );
    assert.equal(again[0].year, 2021);

    const holder: OutsidePaperHolder = {};
    rememberOutsidePapers(holder, [fromSearch]);
    rememberOutsidePapers(holder, [fullAbstract]);
    assert.equal(holder.outsidePaperRecords?.[0].depth, "abstract");
    assert.equal(
      holder.outsidePaperRecords?.[0].abstract,
      "Neurons change their tuning over days.",
      "the deeper read's full abstract replaces the cut search one",
    );
  });

  it("gives a paper one id for the run when its search row and its read name it by different identifiers", function () {
    // OpenAlex names an arXiv paper by its arXiv DOI; the read of the same
    // paper by arXiv id carries no DOI.
    const arxivId = "2301.01234";
    const arxivDoi = `10.48550/arxiv.${arxivId}`;
    const row = {
      title: "Neural drift in the wild",
      authors: ["Ada Lovelace"],
      year: 2023,
      abstract: "Neurons change their tuning ov...",
      doi: arxivDoi,
      sourceUrl: "https://openalex.org/W9",
    };
    const rowId = paperSourceId(`doi:${arxivDoi}`);
    const read = readRecord({
      identifier: { kind: "arxivId", value: arxivId },
      source: "arxiv",
      paper: {
        title: "Neural drift in the wild",
        authors: ["Ada Lovelace"],
        arxivId,
        url: `https://arxiv.org/abs/${arxivId}`,
      },
    });
    const readId = paperSourceId(`arxiv:${arxivId}`);
    assert.notEqual(readId, rowId, "the two identifier sets key differently");

    const holder: OutsidePaperHolder = {};
    rememberOutsidePapers(
      holder,
      outsidePaperRecordsFromToolResult("literature_search", {
        mode: "search",
        results: [row],
      }),
    );
    setOutsidePaperSelection(holder, [rowId]);
    // The read shows the id the run already gave the paper.
    const result = buildLiteratureReadResult(
      read,
      { textOffset: 0 },
      undefined,
      holder,
    );
    assert.equal((result.paper as Record<string, unknown>).paperId, rowId);
    rememberOutsidePapers(
      holder,
      outsidePaperRecordsFromToolResult("literature_read", result),
    );
    assert.lengthOf(holder.outsidePaperRecords || [], 1);
    assert.deepInclude(holder.outsidePaperRecords?.[0], {
      paperId: rowId,
      depth: "abstract",
      doi: arxivDoi,
      arxivId,
    });
    // Both ids are citable and name the one record, whichever the model has.
    assert.isUndefined(outsidePaperCitationRefusal(holder, rowId));
    assert.isUndefined(outsidePaperCitationRefusal(holder, readId));
    assert.equal(findOutsidePaperRecord(holder, readId)?.paperId, rowId);
    assert.lengthOf(
      citableOutsidePapers(holder).filter(
        (paper) => paper.depth !== "metadata",
      ),
      1,
      "the card's choice reaches the deeper read",
    );
  });

  it("keeps a paper's landing page ahead of its open copy, which may be the PDF", function () {
    const [fromRow] = outsidePaperRecordsFromToolResult("literature_search", {
      mode: "search",
      results: [
        {
          title: "A lab report",
          authors: [],
          openAccessUrl: "https://lab.example/report.pdf",
          sourceUrl: "https://lab.example/report",
        },
      ],
    });
    assert.equal(fromRow.url, "https://lab.example/report");
    const [fromRead] = outsidePaperRecordsFromToolResult("literature_read", {
      paper: {
        title: "A lab report",
        authors: [],
        openAccessUrl: "https://lab.example/report.pdf",
      },
      fullText: {
        status: "open_access",
        landingUrl: "https://lab.example/report",
        pdfUrl: "https://lab.example/report.pdf",
      },
    });
    assert.equal(fromRead.url, "https://lab.example/report");
    const [pdfOnly] = outsidePaperRecordsFromToolResult("literature_search", {
      mode: "search",
      results: [
        {
          title: "A lab report",
          authors: [],
          openAccessUrl: "https://lab.example/report.pdf",
        },
      ],
    });
    assert.equal(pdfOnly.url, "https://lab.example/report.pdf");
  });

  it("merges records that share an identifier, whichever order they arrive in", function () {
    const withIds = (
      paperId: string,
      fields: Partial<OutsidePaperRecord>,
    ): OutsidePaperRecord => ({
      paperId,
      authors: [],
      depth: "metadata",
      ...fields,
    });
    const byDoi = withIds("paper_a", { doi: "10.1000/x" });
    const byPmid = withIds("paper_b", { pmid: "42" });
    const bridge = withIds("paper_c", { doi: "10.1000/X", pmid: "42" });
    const merged = mergeOutsidePaperRecords([byDoi, byPmid], [bridge]);
    assert.lengthOf(merged, 1, "a record naming both joins both");
    assert.equal(merged[0].paperId, "paper_a", "the first seen keeps its id");
    assert.sameMembers([...(merged[0].aliasIds || [])], ["paper_b", "paper_c"]);
    const other = withIds("paper_d", { doi: "10.1000/y" });
    assert.lengthOf(mergeOutsidePaperRecords([byDoi], [other]), 2);
    assert.lengthOf(
      mergeOutsidePaperRecords(
        [withIds("paper_e", { arxivId: "arXiv:2301.01234v2" })],
        [withIds("paper_f", { doi: "10.48550/arXiv.2301.01234" })],
      ),
      1,
      "an arXiv DOI and its arXiv id are one identifier",
    );
  });

  it("never joins two papers that hold different DOIs or PMIDs, however the identifiers chain", function () {
    const withIds = (
      paperId: string,
      fields: Partial<OutsidePaperRecord>,
    ): OutsidePaperRecord => ({
      paperId,
      authors: [],
      depth: "metadata",
      ...fields,
    });
    const a = withIds("paper_a", { doi: "10.1/a", title: "Paper A" });
    const b = withIds("paper_b", { doi: "10.1/b", title: "Paper B" });
    const holder: OutsidePaperHolder = {};
    rememberOutsidePapers(holder, [a, b]);
    setOutsidePaperSelection(holder, ["paper_a"]);
    assert.isUndefined(outsidePaperCitationRefusal(holder, "paper_a"));
    assert.match(
      outsidePaperCitationRefusal(holder, "paper_b") || "",
      /not one of the papers the user chose/,
    );
    // A read of B learns B's arXiv id; a later row names A's DOI with it.
    rememberOutsidePapers(holder, [
      withIds("paper_b_read", {
        doi: "10.1/b",
        arxivId: "2301.00001",
        title: "Paper B",
        depth: "body",
      }),
    ]);
    rememberOutsidePapers(holder, [
      withIds("paper_a", {
        doi: "10.1/a",
        arxivId: "2301.00001",
        title: "Paper A",
      }),
    ]);
    const papers = holder.outsidePaperRecords || [];
    assert.lengthOf(papers, 2, "A and B stay two papers");
    const heldA = findOutsidePaperRecord(holder, "paper_a");
    const heldB = findOutsidePaperRecord(holder, "paper_b");
    assert.notEqual(heldA, heldB);
    assert.equal(heldA?.doi, "10.1/a");
    assert.equal(heldA?.title, "Paper A");
    assert.equal(heldB?.doi, "10.1/b");
    assert.equal(heldB?.depth, "body");
    assert.match(
      outsidePaperCitationRefusal(holder, "paper_b") || "",
      /not one of the papers the user chose/,
      "the paper the user did not choose stays refused",
    );
    assert.match(
      outsidePaperCitationRefusal(holder, "paper_b_read") || "",
      /not one of the papers the user chose/,
    );
    assert.isUndefined(outsidePaperCitationRefusal(holder, "paper_a"));

    // Without a selection, the chained row still joins only A.
    const unchosen = mergeOutsidePaperRecords(
      [a, withIds("paper_b", { doi: "10.1/b", arxivId: "2301.00001" })],
      [withIds("paper_a_row", { doi: "10.1/a", arxivId: "2301.00001" })],
    );
    assert.lengthOf(unchosen, 2);
    assert.deepEqual(unchosen[0].aliasIds, ["paper_a_row"]);
    assert.equal(unchosen[1].doi, "10.1/b");

    // Two PMIDs are two papers, even when a DOI-less row shares a PMCID.
    const pmidOne = withIds("paper_p1", { pmid: "1", pmcid: "PMC9" });
    const pmidTwo = withIds("paper_p2", { pmid: "2", pmcid: "PMC9" });
    const split = mergeOutsidePaperRecords([pmidOne], [pmidTwo]);
    assert.deepEqual(
      split.map((paper) => paper.paperId),
      ["paper_p1", "paper_p2"],
    );
    assert.isUndefined(split[0].aliasIds);
    // A row that names only the shared PMCID is ambiguous: it joins neither.
    const ambiguous = mergeOutsidePaperRecords(split, [
      withIds("paper_p3", { pmcid: "PMC9" }),
    ]);
    assert.lengthOf(ambiguous, 3);
    // A conflict with one held record leaves the other as the only target.
    const onlyTarget = mergeOutsidePaperRecords(split, [
      withIds("paper_p4", { pmid: "2", pmcid: "PMC9" }),
    ]);
    assert.lengthOf(onlyTarget, 2);
    assert.sameMembers([...(onlyTarget[1].aliasIds || [])], ["paper_p4"]);
    // After a selection, a row that reaches a chosen and an unchosen paper
    // joins the chosen one only.
    const guarded = mergeOutsidePaperRecords(
      [
        withIds("paper_u", { arxivId: "2301.00003" }),
        withIds("paper_g", { doi: "10.1/g", arxivId: "2301.00003" }),
      ],
      [withIds("paper_g_row", { arxivId: "2301.00003" })],
      ["paper_g"],
    );
    assert.lengthOf(guarded, 2, "the unchosen paper is not pulled in");
    assert.equal(guarded[0].paperId, "paper_u");
    assert.isUndefined(guarded[0].aliasIds);
    assert.deepEqual(guarded[1].aliasIds, ["paper_g_row"]);
  });

  it("keeps a read that carries an unchosen paper's own id on that paper, whatever the record order", function () {
    const withIds = (
      paperId: string,
      fields: Partial<OutsidePaperRecord>,
    ): OutsidePaperRecord => ({
      paperId,
      authors: [],
      depth: "metadata",
      ...fields,
    });
    const chosen = withIds("paper_c", {
      arxivId: "2301.00001",
      title: "Paper C",
    });
    const unchosen = withIds("paper_h", { doi: "10.1/h", title: "Paper H" });
    const read = withIds("paper_h", {
      doi: "10.1/h",
      arxivId: "2301.00001",
      title: "Paper H",
      depth: "body",
    });
    for (const order of [
      [chosen, unchosen],
      [unchosen, chosen],
    ]) {
      const holder: OutsidePaperHolder = {};
      rememberOutsidePapers(holder, order);
      setOutsidePaperSelection(holder, ["paper_c"]);
      assert.match(
        outsidePaperCitationRefusal(holder, "paper_h") || "",
        /not one of the papers the user chose/,
      );
      rememberOutsidePapers(holder, [read]);
      assert.match(
        outsidePaperCitationRefusal(holder, "paper_h") || "",
        /not one of the papers the user chose/,
        "the read does not make the unchosen paper citable",
      );
      assert.isUndefined(outsidePaperCitationRefusal(holder, "paper_c"));
      const heldC = findOutsidePaperRecord(holder, "paper_c");
      const heldH = findOutsidePaperRecord(holder, "paper_h");
      assert.lengthOf(holder.outsidePaperRecords || [], 2);
      assert.isUndefined(heldC?.doi, "C keeps its own identifiers");
      assert.equal(heldC?.arxivId, "2301.00001");
      assert.equal(heldC?.title, "Paper C");
      assert.isUndefined(heldC?.aliasIds);
      assert.equal(heldH?.doi, "10.1/h");
      assert.equal(heldH?.depth, "body");
    }
  });

  it("never holds one paperId or alias in two records", function () {
    const withIds = (
      paperId: string,
      fields: Partial<OutsidePaperRecord>,
    ): OutsidePaperRecord => ({
      paperId,
      authors: [],
      depth: "metadata",
      ...fields,
    });
    const rows = [
      withIds("p1", { doi: "10.1/1", arxivId: "2301.00001" }),
      withIds("p2", { doi: "10.1/2", arxivId: "2301.00001" }),
      withIds("p3", { pmid: "3", pmcid: "PMC1" }),
      withIds("p4", { pmid: "4", pmcid: "PMC1" }),
      withIds("p2", { arxivId: "2301.00001", pmcid: "PMC1" }),
      withIds("p5", { arxivId: "2301.00001" }),
      withIds("p3", { doi: "10.1/1" }),
      withIds("p6", { pmcid: "PMC1" }),
      withIds("p4", { doi: "10.1/2", pmcid: "PMC1" }),
    ];
    for (const selection of [undefined, ["p1"], ["p2", "p3"]]) {
      let records: OutsidePaperRecord[] = [];
      for (const row of rows) {
        records = mergeOutsidePaperRecords(records, [row], selection);
        const ids = records.flatMap((record) => [
          record.paperId,
          ...(record.aliasIds || []),
        ]);
        assert.sameMembers(
          ids,
          [...new Set(ids)],
          `no id is held twice (selection ${JSON.stringify(selection)})`,
        );
        assert.isTrue(
          records.some(
            (record) =>
              record.paperId === row.paperId ||
              record.aliasIds?.includes(row.paperId),
          ),
          "the row's own id is always held",
        );
      }
    }
  });

  it("refuses an unrecorded paper, and a recorded one the user did not choose", function () {
    const holder: OutsidePaperHolder = {
      outsidePaperRecords: [
        recorded("abstract"),
        recorded("metadata", OTHER_ID),
      ],
    };
    assert.isUndefined(outsidePaperCitationRefusal(holder, PAPER_ID));
    assert.match(
      outsidePaperCitationRefusal(holder, "paper_unknown") || "",
      /only papers those tools returned in this run/,
    );
    setOutsidePaperSelection(holder, [OTHER_ID]);
    assert.match(
      outsidePaperCitationRefusal(holder, PAPER_ID) || "",
      /not one of the papers the user chose/,
    );
    assert.isUndefined(outsidePaperCitationRefusal(holder, OTHER_ID));
    setOutsidePaperSelection(holder, undefined);
    assert.isUndefined(outsidePaperCitationRefusal(holder, PAPER_ID));
  });

  it("copies a Claude Code MCP call's outside papers back into the run's request", function () {
    const request = {} as AgentRuntimeRequest;
    const event = (fields: Partial<ZoteroMcpToolActivityEvent>) =>
      ({
        requestId: "1",
        phase: "completed",
        toolName: "literature_search",
        serverName: "zotero",
        ok: true,
        timestamp: 1,
        ...fields,
      }) as ZoteroMcpToolActivityEvent;
    copyMcpCallEvidenceToRequest(
      request,
      event({ outsidePapers: [recorded("metadata")] }),
    );
    copyMcpCallEvidenceToRequest(
      request,
      event({ toolName: "literature_read", outsidePapers: [recorded("body")] }),
    );
    copyMcpCallEvidenceToRequest(
      request,
      event({ ok: false, outsidePapers: [recorded("metadata", OTHER_ID)] }),
    );
    assert.deepEqual(
      request.outsidePaperRecords?.map((paper) => [paper.paperId, paper.depth]),
      [[PAPER_ID, "body"]],
      "a failed call records nothing",
    );
  });
});

describe("submit_document's outside source", function () {
  const tool = createSubmitDocumentTool({} as ZoteroGateway);
  const validate = (source: Record<string, unknown>) =>
    tool.validate({
      title: "Review",
      markdown: "# Review\n\nClaim [[cite:C1]].",
      citations: [{ citationId: "C1", sources: [source] }],
      quotes: [],
      assets: [],
      groundingReviewed: "passed",
      groundingIssues: [],
    });

  it("accepts a Zotero item or an outside paper, in flat optional properties", function () {
    const items = (tool.spec.inputSchema as any).properties.citations.items
      .properties.sources.items;
    assert.notProperty(items, "required");
    assert.notProperty(items, "oneOf");
    assert.notProperty(items, "anyOf");
    assert.equal(
      items.properties.paperId.description,
      "An outside paper's paperId from literature_search or literature_read in this run",
    );
    const zotero = validate({ libraryID: 1, itemKey: "AAAA1111" });
    assert.isTrue(zotero.ok);
    if (zotero.ok)
      assert.deepEqual(zotero.value.citations[0].sources[0], {
        libraryID: 1,
        itemKey: "AAAA1111",
        evidenceRefs: [],
      });
    const outside = validate({ paperId: PAPER_ID });
    assert.isTrue(outside.ok);
    if (outside.ok)
      assert.deepEqual(outside.value.citations[0].sources[0], {
        kind: "outside",
        paperId: PAPER_ID,
        evidenceRefs: [],
      });
  });

  it("refuses a source that names both forms, neither, or an outside locator", function () {
    const mixed = validate({
      libraryID: 1,
      itemKey: "AAAA1111",
      paperId: PAPER_ID,
    });
    assert.isFalse(mixed.ok);
    if (!mixed.ok)
      assert.match(mixed.error, /either a Zotero item .* not both/);
    const empty = validate({});
    assert.isFalse(empty.ok);
    if (!empty.ok)
      assert.match(empty.error, /needs libraryID and itemKey .* or paperId/);
    const blank = validate({ paperId: " " });
    assert.isFalse(blank.ok);
    const located = validate({
      paperId: PAPER_ID,
      evidenceRefs: ["obs-1"],
    });
    assert.isFalse(located.ok);
    if (!located.ok) assert.match(located.error, /no evidenceRefs or locator/);
  });

  it("leaves outside papers out of the Task progress cited-paper list", function () {
    const clusters: PlanCitationCluster[] = [
      {
        citationId: "C1",
        sources: [
          { libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] },
          { kind: "outside", paperId: PAPER_ID, evidenceRefs: [] },
        ],
      },
      {
        citationId: "C2",
        sources: [{ kind: "outside", paperId: OTHER_ID, evidenceRefs: [] }],
      },
    ];
    const cited = documentCitedSources({
      markdown: "# Review\n\n## Results\n\nA [[cite:C1]] and B [[cite:C2]].",
      title: "Review",
      clusters,
    });
    assert.deepEqual(
      cited.map((entry) => [entry.citationId, entry.libraryID, entry.itemKey]),
      [["C1", 1, "AAAA1111"]],
    );
  });
});

const zoteroObservation = (
  capabilities: TrustedReadObservation["capabilities"],
): TrustedReadObservation => ({
  version: 1,
  observationId: "observation-1",
  issuer: "zotero_host",
  toolName: "paper_read",
  callDigest: "sha256:call",
  inputDigest: "sha256:input",
  resultDigest: "sha256:result",
  libraryID: 1,
  itemKey: "AAAA1111",
  capabilities,
  certificateDigest: "sha256:certificate",
});

describe("finalizing a document that cites an outside paper", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let finalizer: DirectDocumentFinalizer;
  let lookedUp: string[];

  before(function () {
    originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
  });

  beforeEach(function () {
    lookedUp = [];
    (globalThis as any).ztoolkit = { log: () => undefined };
    (globalThis as { Zotero?: unknown }).Zotero = {
      DB: {
        queryAsync: async () => [],
        executeTransaction: async (callback: () => Promise<unknown>) =>
          callback(),
      },
      Items: {
        getByLibraryAndKey: (libraryID: number, itemKey: string) =>
          libraryID === 1 && itemKey === "AAAA1111"
            ? {
                id: 101,
                isNote: () => false,
                getField: (field: string) =>
                  field === "title" ? "Verified paper" : "",
              }
            : false,
      },
      Libraries: { userLibraryID: 1, get: () => undefined },
    };
    finalizer = new DirectDocumentFinalizer(
      {
        formatStructuredCitations: (params: {
          clusters: Array<{
            citationId: string;
            items: Array<{ itemId?: number; outsideId?: string }>;
          }>;
        }) => ({
          styleId: "apa",
          styleTitle: "APA",
          locale: "en-US",
          clusters: params.clusters.map((cluster) => ({
            citationId: cluster.citationId,
            text: "(Author, 2024)",
            html: "(Author, 2024)",
          })),
          bibliographyEntries: [
            ...new Set(
              params.clusters.flatMap((cluster) =>
                cluster.items.map((item) => item.outsideId ?? item.itemId),
              ),
            ),
          ].map((id) =>
            typeof id === "string"
              ? { outsideId: id, text: "Outside. (2021).", html: "Outside." }
              : { itemId: 101, text: "Author. (2024).", html: "Author." },
          ),
        }),
      } as unknown as ZoteroGateway,
      {
        lookupOutsidePaperMetadata: async (doi) => {
          lookedUp.push(doi);
          return { "container-title": "Journal of Drift" };
        },
      },
    );
  });

  after(function () {
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
  });

  function request(
    fields: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 42,
      mode: "agent",
      userText: "Review the literature",
      turnPaperScope: {} as AgentRuntimeRequest["turnPaperScope"],
      zoteroMetadataContext: {} as AgentRuntimeRequest["zoteroMetadataContext"],
      metadata: { sourceMessageTimestamp: 100 },
      ...fields,
    } as AgentRuntimeRequest;
  }

  const input = (
    citations: PlanCitationCluster[],
    integrityPolicy: "authored" | "research_grounded" = "authored",
  ) => ({
    title: "Review",
    integrityPolicy,
    documentKind: "literature_review" as const,
    markdown: "# Review\n\nTuning drifts [[cite:C1]].",
    citations,
    quotes: [],
    assets: [],
    groundingReviewed: "passed" as const,
    groundingIssues: [],
  });
  const outsideCitation: PlanCitationCluster = {
    citationId: "C1",
    sources: [{ kind: "outside", paperId: PAPER_ID, evidenceRefs: [] }],
  };
  const zoteroCitation: PlanCitationCluster = {
    citationId: "C1",
    sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
  };

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    assert.fail("expected the finalizer to refuse");
  }

  it("refuses a paperId this run's literature tools did not return", async function () {
    const error = await rejection(
      finalizer.finalize({
        request: request({ outsidePaperRecords: [recorded("body", OTHER_ID)] }),
        runId: "run-outside-1",
        input: input([outsideCitation]),
      }),
    );
    assert.instanceOf(error, ToolInputRejection);
    assert.match(
      String(error),
      /Citation C1: Outside paper paper_\w+ was not returned by literature_search or literature_read in this run/,
    );
  });

  it("refuses a recorded paper outside the user's choice", async function () {
    const run = request({ outsidePaperRecords: [recorded("body")] });
    setOutsidePaperSelection(run, [OTHER_ID]);
    const error = await rejection(
      finalizer.finalize({
        request: run,
        runId: "run-outside-2",
        input: input([outsideCitation]),
      }),
    );
    assert.instanceOf(error, ToolInputRejection);
    assert.match(String(error), /not one of the papers the user chose to cite/);
  });

  // A cited outside paper links to its page; no DOI, so no lookup runs.
  const linked = {
    ...recorded("body"),
    url: "https://europepmc.org/article/MED/1",
  };

  it("asks for the choice first where the card can be shown and none was made", async function () {
    const refusal = await rejection(
      finalizer.finalize({
        request: request({ outsidePaperRecords: [linked] }),
        runId: "run-outside-unchosen",
        input: input([outsideCitation]),
        outsidePaperChoiceAvailable: true,
      }),
    );
    assert.instanceOf(refusal, ToolInputRejection);
    assert.include(
      String(refusal),
      "This document cites outside papers the user has not chosen to cite. Offer the user the choice first with a literature_search review search; cite only the papers they choose to cite.",
    );
    // Once the user chose on the card, the chosen paper is cited.
    const chosen = request({ outsidePaperRecords: [linked] });
    setOutsidePaperSelection(chosen, [PAPER_ID]);
    const { document } = await finalizer.finalize({
      request: chosen,
      runId: "run-outside-chosen",
      input: input([outsideCitation]),
      outsidePaperChoiceAvailable: true,
    });
    assert.deepEqual(document.citationBundle.bibliographyEntries, [
      { paperId: PAPER_ID, text: "Outside. (2021).", html: "Outside." },
    ]);
    // A document citing only Zotero items needs no choice.
    await finalizer.finalize({
      request: request({ outsidePaperRecords: [linked] }),
      runId: "run-outside-zotero-only",
      input: input([zoteroCitation]),
      outsidePaperChoiceAvailable: true,
    });
  });

  it("knows from the caller whether the card can be shown: natively yes, over MCP and in a side chat no", async function () {
    const tool = createSubmitDocumentTool(
      (finalizer as unknown as { gateway: ZoteroGateway }).gateway,
    );
    const submit = (
      runId: string,
      fields: Partial<AgentRuntimeRequest>,
      extra: Partial<AgentToolContext> = {},
    ) =>
      tool.execute(
        { ...input([outsideCitation]) } as never,
        {
          request: request({
            outsidePaperRecords: [linked],
            ...fields,
          }),
          runId,
          item: null,
          currentAnswerText: "",
          modelName: "test",
          ...extra,
        } as AgentToolContext,
      );
    const native = await rejection(submit("run-outside-native", {}));
    assert.instanceOf(native, ToolInputRejection);
    assert.include(String(native), "Offer the user the choice first");
    // No card over MCP or in a temporary side chat: cite without importing.
    for (const [runId, fields, extra] of [
      [
        "run-outside-mcp",
        {},
        { isToolVisible: (spec) => spec.name !== "literature_review" },
      ],
      [
        "run-outside-side-chat",
        { conversationKey: EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE + 7 },
        {},
      ],
    ] as const satisfies ReadonlyArray<
      readonly [string, Partial<AgentRuntimeRequest>, Partial<AgentToolContext>]
    >) {
      const result = (await submit(runId, fields, extra)) as {
        content: { documentId?: string };
      };
      assert.isString(result.content.documentId, runId);
    }
  });

  it("counts an outside abstract or text as research evidence, as a Zotero abstract or body read", async function () {
    const metadataOnly = [zoteroObservation(["metadata"])];
    const ungrounded = await rejection(
      finalizer.finalize({
        request: request({
          documentReadObservations: metadataOnly,
          outsidePaperRecords: [recorded("metadata")],
        }),
        runId: "run-outside-3",
        input: input([zoteroCitation], "research_grounded"),
      }),
    );
    assert.match(
      String(ungrounded),
      /requires host-verified abstract or body evidence/,
      "a metadata-only outside paper grounds nothing",
    );
    for (const depth of ["abstract", "body"] as const) {
      const { document } = await finalizer.finalize({
        request: request({
          documentReadObservations: metadataOnly,
          outsidePaperRecords: [recorded(depth)],
        }),
        runId: `run-outside-${depth}`,
        input: input([zoteroCitation], "research_grounded"),
      });
      assert.equal(document.integrityPolicy, "research_grounded");
      assert.deepEqual(
        document.coverageItems.map((item) => item.itemKey),
        ["AAAA1111"],
        "coverage lists Zotero items only",
      );
    }
  });

  it("formats a recorded outside source into the document, linked at doi.org", async function () {
    for (const integrityPolicy of ["authored", "research_grounded"] as const) {
      const { document } = await finalizer.finalize({
        request: request({
          outsidePaperRecords: [{ ...recorded("abstract"), doi: DOI }],
        }),
        runId: `run-outside-format-${integrityPolicy}`,
        input: input([outsideCitation], integrityPolicy),
      });
      assert.include(
        document.visibleMarkdown,
        `[(Author, 2024)](https://doi.org/10.1000/drift)`,
      );
      assert.deepEqual(document.citationBundle.bibliographyEntries, [
        { paperId: PAPER_ID, text: "Outside. (2021).", html: "Outside." },
      ]);
      assert.deepEqual(lookedUp, [DOI], "the cited paper's DOI is looked up");
      assert.equal(
        document.citationBundle.outsidePapers?.[0].csl["container-title"],
        "Journal of Drift",
        "the lookup's venue is kept in the document's snapshot",
      );
      lookedUp = [];
    }
  });

  it("formats a retried submission identically when its first DOI lookup timed out", async function () {
    let calls = 0;
    const slow = new DirectDocumentFinalizer(
      (finalizer as unknown as { gateway: ZoteroGateway }).gateway,
      {
        lookupOutsidePaperMetadata: (doi) => {
          calls += 1;
          // The first lookup never answers; a second would.
          return calls === 1
            ? new Promise(() => undefined)
            : Promise.resolve({ "container-title": `Late ${doi}` });
        },
        outsidePaperLookupTimeoutMs: 20,
      },
    );
    const run = request({
      outsidePaperRecords: [{ ...recorded("abstract"), doi: DOI }],
    });
    const submit = () =>
      slow.finalize({
        request: run,
        runId: "run-outside-retry",
        input: input([outsideCitation]),
        now: 500,
      });
    const first = await submit();
    const second = await submit();
    assert.equal(calls, 1, "the run looks the DOI up once");
    assert.deepEqual(
      second.document.citationBundle.outsidePapers,
      first.document.citationBundle.outsidePapers,
    );
    assert.notProperty(
      first.document.citationBundle.outsidePapers![0].csl,
      "container-title",
      "a timed-out lookup adds nothing, then or later",
    );
    assert.equal(second.document.contentHash, first.document.contentHash);
    assert.deepEqual(run.outsidePaperLookupCache, { [DOI]: null });
  });

  it("keys outside sources by paperId, so two in one cluster are not duplicates", async function () {
    const format = (cluster: PlanCitationCluster) =>
      formatDocumentCitations({
        gateway: {} as ZoteroGateway,
        draftMarkdown: "# Review\n\nTwo papers [[cite:C1]].",
        clusters: [cluster],
        corpus: [
          { kind: "outside", paperId: PAPER_ID },
          { kind: "outside", paperId: OTHER_ID },
        ],
        evidence: [],
        spec: {
          kind: "literature_review",
          title: "Review",
          requiredSections: [],
          requiresReferences: true,
          requiresCoverageSection: false,
          allowFigures: true,
          citationStyle: { styleId: "apa", styleTitle: "APA", locale: "en-US" },
        },
        requireEvidence: true,
      }).then(
        () => "formatted",
        (error) => String(error),
      );
    const two = await format({
      citationId: "C1",
      sources: [
        { kind: "outside", paperId: PAPER_ID, evidenceRefs: [] },
        { kind: "outside", paperId: OTHER_ID, evidenceRefs: [] },
      ],
    });
    assert.notMatch(two, /duplicate sources/);
    assert.match(two, /which has no record to format it from/);
    const same = await format({
      citationId: "C1",
      sources: [
        { kind: "outside", paperId: PAPER_ID, evidenceRefs: [] },
        { kind: "outside", paperId: PAPER_ID, evidenceRefs: [] },
      ],
    });
    assert.match(same, /contains duplicate sources/);
    const unrecorded = await format({
      citationId: "C1",
      sources: [
        { kind: "outside", paperId: "paper_unknown", evidenceRefs: [] },
      ],
    });
    assert.match(unrecorded, /outside the approved corpus/);
  });
});

function storedDocument(
  sources: DocumentArtifactV2["citationBundle"]["clusters"][number]["sources"],
): Record<string, unknown> {
  return {
    version: 2,
    documentId: "run-1:document:1",
    documentVersion: 1,
    documentKind: "literature_review",
    integrityPolicy: "research_grounded",
    origin: { kind: "direct", runId: "run-1", sourceMessageTimestamp: 10 },
    conversationKey: 7,
    title: "Review",
    visibleMarkdown: "# Review\n\nClaim (Author, 2024).",
    visibleHtml: "<h1>Review</h1><p>Claim (Author, 2024).</p>",
    citationBundle: {
      clusters: [
        {
          citationId: "C1",
          text: "(Author, 2024)",
          html: "(Author, 2024)",
          sources,
        },
      ],
      bibliographyEntries: [],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
    },
    verifiedQuotes: [],
    assets: [],
    coverageItems: [
      {
        libraryID: 1,
        itemKey: "AAAA1111",
        status: "included",
        evidenceDepth: "body",
      },
    ],
    validation: {
      integrityValidated: true,
      groundingReviewed: "passed",
      quoteVerified: "not_applicable",
      issues: [],
    },
    contentHash: "sha256:document",
    createdAt: 10,
  };
}

describe("a stored outside citation source", function () {
  it("decodes an outside source and a stored source without a kind as a Zotero item", function () {
    const decoded = decodePlanDocument(
      storedDocument([
        { libraryID: 1, itemKey: "AAAA1111", evidenceRefs: ["observation-1"] },
        { kind: "outside", paperId: PAPER_ID, evidenceRefs: [] },
      ]),
    );
    assert.deepEqual(decoded.citationBundle.clusters[0].sources, [
      {
        libraryID: 1,
        itemKey: "AAAA1111",
        evidenceRefs: ["observation-1"],
        locator: undefined,
      },
      { kind: "outside", paperId: PAPER_ID, evidenceRefs: [] },
    ]);
    const roundTrip = decodePlanDocument(JSON.parse(JSON.stringify(decoded)));
    assert.deepEqual(
      roundTrip.citationBundle.clusters[0].sources[1],
      decoded.citationBundle.clusters[0].sources[1],
    );
  });

  it("still decodes a document stored before outside sources, unchanged", function () {
    const old = storedDocument([
      {
        libraryID: 1,
        itemKey: "AAAA1111",
        evidenceRefs: ["observation-1"],
        locator: {
          kind: "pdf_page",
          attachmentItemKey: "PDF00001",
          pageIndex: 2,
          sourceFingerprint: "pdfjs:fingerprint",
        },
      },
    ]);
    const decoded = decodePlanDocument(JSON.parse(JSON.stringify(old)));
    assert.deepEqual(
      decoded.citationBundle.clusters[0].sources,
      (old.citationBundle as DocumentArtifactV2["citationBundle"]).clusters[0]
        .sources,
    );
    assert.equal(decoded.version, 2);
  });

  it("refuses an outside source without a paperId and an unknown source kind", function () {
    assert.throws(
      () =>
        decodePlanDocument(
          storedDocument([{ kind: "outside", evidenceRefs: [] } as never]),
        ),
      /paperId is required/,
    );
    assert.throws(
      () =>
        decodePlanDocument(
          storedDocument([{ kind: "web", paperId: PAPER_ID } as never]),
        ),
      /kind is invalid/,
    );
  });

  it("leaves an outside source out of the saved note's parent candidates", function () {
    const document = decodePlanDocument(
      storedDocument([
        { kind: "outside", paperId: PAPER_ID, evidenceRefs: [] },
      ]),
    ) as PlanDocument;
    assert.deepEqual(
      documentCitedItems(document),
      [],
      "a document citing one outside paper has no Zotero parent to pick",
    );
    const mixed = decodePlanDocument(
      storedDocument([
        { kind: "outside", paperId: PAPER_ID, evidenceRefs: [] },
        { libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] },
      ]),
    ) as PlanDocument;
    assert.deepEqual(documentCitedItems(mixed), [
      { libraryID: 1, itemKey: "AAAA1111" },
    ]);
  });

  describe("in the document store", function () {
    let originalZotero: unknown;
    let db: DatabaseSync;

    beforeEach(function () {
      originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
      db = new DatabaseSync(":memory:");
      const bindable = (params: unknown[] | undefined) =>
        (params || []).map((value) => (value === undefined ? null : value));
      (globalThis as { Zotero?: unknown }).Zotero = {
        DB: {
          queryAsync: async (sql: string, params?: unknown[]) => {
            const statement = db.prepare(sql);
            const head = sql.trimStart().toUpperCase();
            if (head.startsWith("SELECT") || head.startsWith("PRAGMA"))
              return statement.all(...(bindable(params) as never[]));
            statement.run(...(bindable(params) as never[]));
            return [];
          },
          executeTransaction: async (task: () => Promise<unknown>) => task(),
        },
      };
    });

    afterEach(function () {
      db.close();
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    });

    it("saves and loads an outside source, with coverage rows for Zotero items only", async function () {
      await initPlanDocumentStore();
      const document = decodePlanDocument(
        storedDocument([
          { libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] },
          { kind: "outside", paperId: PAPER_ID, evidenceRefs: [] },
        ]),
      );
      await savePlanDocumentInTransaction({
        document,
        outbox: {
          version: 1,
          outboxId: `${document.documentId}:message`,
          documentId: document.documentId,
          conversationKey: document.conversationKey,
          messageTimestamp: 10,
          visibleMarkdown: document.visibleMarkdown,
          status: "pending",
          attemptCount: 0,
          createdAt: 10,
          updatedAt: 10,
        },
      });
      const loaded = await loadPlanDocument(document.documentId);
      assert.deepEqual(loaded?.citationBundle.clusters[0].sources[1], {
        kind: "outside",
        paperId: PAPER_ID,
        evidenceRefs: [],
      });
      const rows = db
        .prepare(
          `SELECT library_id, item_key FROM ${PLAN_DOCUMENT_COVERAGE_TABLE}`,
        )
        .all();
      assert.deepEqual(
        rows.map((row) => [row.library_id, row.item_key]),
        [[1, "AAAA1111"]],
      );
    });
  });
});
