/** Opt-in native evaluation: authored fixtures, or explicitly approved local paper. */
import { assert } from "chai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  papers,
  cases,
  realPaperCases,
  libraryCases,
  type QaCase,
} from "../../test/fixtures/qaEvaluation/corpus";
import { usageFromResponse } from "../../test/helpers/qaUsage";
import {
  citationsFromEvents,
  measureGrounding,
  measureSupport,
} from "../../test/helpers/qaSupportMetrics";
import {
  acquisitionPapers,
  acquisitionCases,
  type AcquisitionCase,
} from "../../test/fixtures/qaEvaluation/acquisition";
import { measureAcquisition } from "../../test/helpers/qaAcquisitionMetrics";
import { acquisitionRealCases } from "../../test/fixtures/qaEvaluation/acquisitionReal";
import {
  realCases,
  type RealCase,
} from "../../test/fixtures/qaEvaluation/realLibrary";
import {
  getMineruItemDir,
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../src/services/mineru/mineruCache";
import { joinLocalPath } from "../../src/utils/localPath";
import {
  checkEmbeddingAvailability,
  getEmbeddingUnavailableReason,
} from "../../src/utils/llmClient";
import {
  resolveLiveAgentCredentials,
  stringPrefFromContents,
} from "./liveAgentCredentials";
declare const Zotero: any;
declare const IOUtils: any;
declare const Services: any;
const env = (key: string) => String(Services.env.get(key) || "");
const prefix = "extensions.zotero.llmforzotero";
const directory = env("LLM_FOR_ZOTERO_QA_REPORT_DIR");
const suite = env("LLM_FOR_ZOTERO_QA_SUITE");
const acquisitionOnly = suite === "acquisition";
// The real-library suite answers from a snapshot of the user's own data
// directory: it creates no fixture item, writes no PDF and no MinerU cache,
// and erases nothing when it finishes.
const realLibrary = suite === "real";
const realPaper = env("LLM_FOR_ZOTERO_QA_REAL_PAPER") === "1" && !realLibrary;
const semanticSearch = env("LLM_FOR_ZOTERO_QA_SEMANTIC") === "1";
type EvaluationCase = QaCase | AcquisitionCase | RealCase;
const evaluationCases: EvaluationCase[] = realLibrary
  ? realCases
  : realPaper
    ? acquisitionOnly
      ? acquisitionRealCases
      : realPaperCases
    : acquisitionOnly
      ? acquisitionCases
      : [...cases, ...libraryCases];
const variant = env("LLM_FOR_ZOTERO_QA_VARIANT") || "unspecified";
const repeat = Number(env("LLM_FOR_ZOTERO_QA_REPEAT") || 1);
const selected = new Set(
  env("LLM_FOR_ZOTERO_QA_CASES").split(",").filter(Boolean),
);
// npm run test:agent:live aborts the suite on the first failure, which throws
// away the rest of a long flight. In soft mode a case records what went wrong
// in its own report and passes, so one unreachable target cannot end the run.
const soft = env("LLM_FOR_ZOTERO_QA_SOFT") === "1";
type CaseFailure = { stage: "scope" | "turn" | "assert"; message: string };
const failureMessage = (error: unknown) =>
  String((error as { message?: string } | undefined)?.message || error);
/** The boundary every turn carries. A real-library case asks about the user's
 * own library, where "selected evaluation papers" would name a corpus this
 * suite never creates. */
const turnSuffix = realLibrary
  ? "Use my Zotero library and the supplied context only. Do not use external sources or modify the library. Keep the answer concise."
  : "Use the supplied context and selected evaluation papers only. Do not use external sources or modify the library. Keep the answer concise.";
const clean = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
/** Sections a read actually delivered: flat results, or the per-paper groups. */
const deliveredSectionsOf = (content: any): string[] => {
  const rows: any[] = Array.isArray(content?.results)
    ? content.results
    : [content?.papers, content?.groups]
        .filter(Array.isArray)
        .flatMap((groups: any[]) =>
          groups.flatMap((group: any) =>
            Array.isArray(group?.passages) ? group.passages : [],
          ),
        );
  return [
    ...new Set(
      rows
        .map((row) => row?.sectionPath || row?.sectionLabel)
        .filter(
          (section): section is string =>
            typeof section === "string" && section.length > 0,
        ),
    ),
  ];
};

const SEMANTIC_PREF_KEYS = [
  "embeddingApiBase",
  "embeddingModel",
  "embeddingApiKey",
  "embeddingProvider",
  // The dev profile leaves embeddingApiKey empty: the plugin resolves the key
  // from a provider group that serves embeddings, so the groups must travel
  // with the embedding settings or the scaffold has no key to embed with.
  "modelProviderGroups",
];
/** Fixes the retrieval setting for the run.
 *
 * Semantic retrieval is opt-in because it needs the user's own embedding
 * account, which the scaffold profile does not carry. The values are copied
 * from the live profile's prefs.js straight into Zotero.Prefs; none of them is
 * returned, reported or logged. Returns the names that were copied. */
async function applyRetrievalPrefs(): Promise<string[]> {
  Zotero.Prefs.set(`${prefix}.enableSemanticSearch`, semanticSearch, true);
  if (!semanticSearch) return [];
  const profilePath = env("LLM_FOR_ZOTERO_LIVE_PROFILE_PATH");
  assert.isNotEmpty(
    profilePath,
    "LLM_FOR_ZOTERO_QA_SEMANTIC=1 needs LLM_FOR_ZOTERO_LIVE_PROFILE_PATH: the embedding settings are read from that profile",
  );
  const contents = String(await Zotero.File.getContentsAsync(profilePath));
  const copied: string[] = [];
  for (const key of SEMANTIC_PREF_KEYS) {
    const value = stringPrefFromContents(contents, `${prefix}.${key}`);
    if (!value) continue;
    Zotero.Prefs.set(`${prefix}.${key}`, value, true);
    copied.push(key);
  }
  // Without a base and a model the run would fall back to lexical retrieval
  // while reporting itself as a semantic run.
  for (const required of ["embeddingApiBase", "embeddingModel"])
    assert.include(
      copied,
      required,
      `a semantic run needs ${required} in the live profile prefs.js`,
    );
  // The prefs can all be present and still resolve no usable endpoint, so the
  // plugin's own availability check has the last word. The reason it returns
  // names a provider and a setting, never a credential.
  assert.isTrue(
    checkEmbeddingAvailability(),
    `the copied settings cannot embed: ${
      getEmbeddingUnavailableReason() || "no reason reported"
    }`,
  );
  return copied;
}

/** True when this attachment already has a parsed MinerU document on disk. */
async function hasMineruCache(attachment: any): Promise<boolean> {
  if (!attachment) return false;
  return Boolean(
    await IOUtils.exists(
      joinLocalPath(getMineruItemDir(Number(attachment.id)), "full.md"),
    ),
  );
}

/** The one item a paper case is about.
 *
 * A real library repeats titles, so a case can name its item outright with
 * paperItemId. Without it the title decides, and when several items share the
 * title the parsed copy wins: a duplicate with no MinerU document is not the
 * one the case was written against. */
async function resolvePaperItem(
  scope: { paperTitle: string; paperItemId?: number },
  libraryID: number,
): Promise<any> {
  if (scope.paperItemId !== undefined) {
    const named = Zotero.Items.get(scope.paperItemId);
    assert.isOk(named, `item ${scope.paperItemId} is not in this library`);
    assert.isTrue(
      Boolean(named.isRegularItem?.()) && !named.deleted,
      `item ${scope.paperItemId} must be a regular item that is not in the trash`,
    );
    assert.equal(
      String(named.getField("title") || ""),
      scope.paperTitle,
      `item ${scope.paperItemId} does not carry the title the case names`,
    );
    return named;
  }
  // Same construction the plugin's own item search uses: an unscoped
  // Zotero.Search would reach into other libraries.
  const search = new Zotero.Search({ libraryID });
  search.addCondition("title", "is", scope.paperTitle);
  const ids: number[] = await search.search();
  // A title search also returns attachments and notes, and a trashed item must
  // not answer: only a live regular item can be the active paper.
  const items = ids
    .map((id) => Zotero.Items.get(id))
    .filter((item: any) => item && item.isRegularItem?.() && !item.deleted);
  assert.isNotEmpty(
    items,
    `the library holds no item titled "${scope.paperTitle}"`,
  );
  if (items.length === 1) return items[0];
  const parsed: any[] = [];
  for (const candidate of items)
    if (await hasMineruCache(await candidate.getBestAttachment()))
      parsed.push(candidate);
  assert.equal(
    parsed.length,
    1,
    `"${scope.paperTitle}" matches ${items.length} items, ${parsed.length} of them with a parsed MinerU document; name the one you mean with paperItemId`,
  );
  return parsed[0];
}

type RealScope = {
  kind: "library" | "paper";
  libraryID: number;
  /** The scope fields of the turn request, as the panel would send them. */
  request: Record<string, unknown>;
  resolved: Record<string, number>;
};
/** Resolves a real-library case against the snapshot library, by collection
 * name or by paper title. A missing or ambiguous target fails the case: it must
 * never answer quietly under some other scope. */
async function resolveRealScope(entry: RealCase): Promise<RealScope> {
  const libraryID = Number(Zotero.Libraries.userLibraryID);
  const scope = entry.scope;
  if ("collectionName" in scope) {
    const matches = Zotero.Collections.getByLibrary(libraryID, true).filter(
      (collection: any) => collection.name === scope.collectionName,
    );
    assert.equal(
      matches.length,
      1,
      `the library must hold exactly one collection named "${scope.collectionName}" (found ${matches.length})`,
    );
    const collectionId = Number(matches[0].id);
    return {
      kind: "library",
      libraryID,
      request: {
        conversationKind: "global",
        selectedCollectionContexts: [
          { collectionId, name: scope.collectionName, libraryID },
        ],
        selectedPaperContexts: [],
      },
      resolved: { libraryID, collectionId },
    };
  }
  if ("library" in scope)
    return {
      kind: "library",
      libraryID,
      request: {
        conversationKind: "global",
        selectedCollectionContexts: [],
        selectedPaperContexts: [],
      },
      resolved: { libraryID },
    };
  const item = await resolvePaperItem(scope, libraryID);
  const attachment = await item.getBestAttachment();
  assert.isOk(
    attachment,
    `"${scope.paperTitle}" must have an attachment to read`,
  );
  const itemId = Number(item.id);
  const attachmentId = Number(attachment.id);
  // Zotero stores a free-form date string; a paper context carries the year.
  const year = (String(item.getField("date") || "").match(/\d{4}/) || [""])[0];
  return {
    kind: "paper",
    libraryID,
    request: {
      conversationKind: "paper",
      activeItemId: itemId,
      activePaperContext: {
        libraryID,
        itemId,
        contextItemId: attachmentId,
        title: String(item.getField("title") || scope.paperTitle),
        firstCreator: String(item.firstCreator || ""),
        year,
      },
      selectedPaperContexts: [],
    },
    resolved: { libraryID, itemId, attachmentId },
  };
}

describe("adaptive QA framework native evaluation", function () {
  this.timeout(360000);
  const refs: any[] = [];
  const created: number[] = [];
  // Collection ids are a separate sequence from item ids, so they are tracked
  // apart: looking one up with Zotero.Items.get could hit an unrelated item.
  const createdCollections: number[] = [];
  let libraryScope: {
    collectionId: number;
    name: string;
    libraryID: number;
  } | null = null;
  let credentials: Awaited<ReturnType<typeof resolveLiveAgentCredentials>>;
  const write = (name: string, data: unknown) =>
    Zotero.File.putContentsAsync(
      `${directory}/${name}`,
      JSON.stringify(data, null, 2),
    );
  before(async function () {
    if (!directory) {
      this.skip();
      return;
    }
    credentials = await resolveLiveAgentCredentials({
      requestedModel: env("LLM_FOR_ZOTERO_LIVE_MODEL") || "deepseek-flash",
    });
    assert.isOk(
      credentials,
      "Configured live credentials must be available; requested evaluation cannot silently skip",
    );
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    Zotero.Prefs.set(`${prefix}.mineruGlobalAutoParse`, false, true);
    Zotero.Prefs.set(`${prefix}.mineruSyncEnabled`, false, true);
    Zotero.Prefs.set(`${prefix}.mineruEnabled`, true, true);
    const embeddingPrefs = await applyRetrievalPrefs();
    const sources = realLibrary
      ? // The snapshot library supplies the papers; nothing is created here.
        []
      : realPaper
        ? [
            {
              id: "peschka",
              title:
                "Numerics of thin-film free boundary problems for partial wetting",
              author: "Peschka",
              year: "2014",
              text: String(
                await Zotero.File.getContentsAsync(
                  `${env("LLM_FOR_ZOTERO_LIVE_PAPER_CACHE")}/full.md`,
                ),
              ),
            },
          ]
        : acquisitionOnly
          ? acquisitionPapers
          : papers;
    for (const source of sources) {
      const item = new Zotero.Item("journalArticle");
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.setField("title", source.title);
      item.setField("date", source.year);
      item.setCreators([
        {
          creatorType: "author",
          firstName: "Evaluation",
          lastName: source.author,
        },
      ]);
      const itemId = Number(await item.saveTx());
      created.push(itemId);
      let path = env("LLM_FOR_ZOTERO_LIVE_PAPER_PDF");
      if (!realPaper) {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        for (const section of source.text.split(/\n\n(?=## )/)) {
          const page = doc.addPage([612, 792]);
          let y = 745;
          for (const paragraph of section.split("\n")) {
            const words = paragraph.split(/\s+/);
            let line = "";
            for (const word of words) {
              if ((line + word).length > 85) {
                page.drawText(line, { x: 35, y, size: 10, font });
                y -= 15;
                line = "";
              }
              line += word + " ";
            }
            if (line) {
              page.drawText(line, { x: 35, y, size: 10, font });
              y -= 20;
            }
          }
        }
        path = `${directory}/${source.id}.pdf`;
        await IOUtils.write(path, await doc.save());
      }
      const attachment = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID: itemId,
        contentType: "application/pdf",
      });
      created.push(attachment.id);
      await writeMineruCacheFiles(attachment.id, source.text, [
        {
          relativePath: "full.md",
          data: new TextEncoder().encode(source.text),
        },
      ]);
      await writeMineruSourceProvenanceForAttachment(attachment);
      refs.push({
        libraryID: item.libraryID,
        itemId,
        contextItemId: attachment.id,
        title: source.title,
        firstCreator: source.author,
        year: source.year,
      });
    }
    if (!realLibrary && !realPaper && !acquisitionOnly) {
      // Library-chat cases need a collection scope rather than an active paper.
      const collection = new Zotero.Collection();
      collection.libraryID = Zotero.Libraries.userLibraryID;
      collection.name = `QA evaluation collection ${variant}-${repeat}`;
      const collectionId = Number(await collection.saveTx());
      createdCollections.push(collectionId);
      const regularItemIds = created.filter((id) =>
        Zotero.Items.get(id)?.isRegularItem(),
      );
      // addItems does not open its own transaction: it requires one.
      await Zotero.DB.executeTransaction(async () => {
        await collection.addItems(regularItemIds);
      });
      libraryScope = {
        collectionId,
        name: collection.name,
        libraryID: collection.libraryID,
      };
    }
    await write(
      `setup-${variant}-${repeat}${realPaper ? "-real" : realLibrary ? "-real-library" : ""}.json`,
      {
        variant,
        repeat,
        build: env("LLM_FOR_ZOTERO_QA_BUILD"),
        profile: Services.dirsvc.get("ProfD", Components.interfaces.nsIFile)
          .path,
        dataDirectory: Zotero.DataDirectory.dir,
        model: credentials!.model,
        sourceType: realLibrary
          ? "user library snapshot addressed by collection name or paper title"
          : realPaper
            ? "real paper with existing extraction"
            : "authored fictional fixtures",
        semanticSearch,
        // Names only: an embedding credential is never written to a report.
        embeddingPrefs,
        suite: realLibrary
          ? "real"
          : acquisitionOnly
            ? "acquisition"
            : "framework",
        refs,
      },
    );
  });
  after(async function () {
    // The real-library suite answers from the user's own library: it creates
    // nothing there, so it must delete nothing either.
    if (realLibrary) return;
    for (const id of [...created].reverse()) {
      const item = Zotero.Items.get(id);
      if (item) await item.eraseTx();
    }
    for (const id of [...createdCollections].reverse()) {
      const collection = Zotero.Collections.get(id);
      if (collection) await collection.eraseTx();
    }
  });
  for (const entry of evaluationCases.filter(
    (c) => !selected.size || selected.has(c.id),
  )) {
    it(`${entry.id} ${entry.category}: ${entry.question}`, async function () {
      let failure: CaseFailure | undefined;
      // Resolved before the clock starts, so a missing collection or paper
      // reads as a lookup failure rather than a slow turn.
      let realScope: RealScope | null = null;
      if (realLibrary)
        try {
          realScope = await resolveRealScope(entry as RealCase);
        } catch (e) {
          if (!soft) throw e;
          failure = { stage: "scope", message: failureMessage(e) };
        }
      const libraryCase = realScope
        ? realScope.kind === "library"
        : realLibrary
          ? // The case still reports the scope it asked for, resolved or not.
            !("paperTitle" in (entry as RealCase).scope)
          : "library" in entry && Boolean(entry.library);
      const toolkit = Zotero.LLMForZotero.data.ztoolkit;
      const original = toolkit.getGlobal;
      const fetch = original.call(toolkit, "fetch");
      const requests: any[] = [];
      const pending: Promise<void>[] = [];
      const events: any[] = [];
      const start = Date.now();
      toolkit.getGlobal = function (name: string) {
        if (name !== "fetch") return original.call(toolkit, name);
        return async (url: string, init?: RequestInit) => {
          let body: any;
          try {
            body = JSON.parse(String(init?.body || "{}"));
          } catch {
            body = {};
          }
          const measured = Boolean(
            body.model || body.messages || body.input || body.contents,
          );
          const record: any = {
            index: requests.length,
            kind: /embed/i.test(url)
              ? "embedding"
              : body.tools?.length
                ? "agent"
                : "utility",
            model: body.model || null,
            startedMs: Date.now() - start,
          };
          if (measured) requests.push(record);
          try {
            const response = await fetch(url, init);
            if (measured) {
              record.status = response.status;
              pending.push(
                response
                  .clone()
                  .text()
                  .then((text: string) => {
                    record.elapsedMs = Date.now() - start - record.startedMs;
                    record.usage = usageFromResponse(text);
                  })
                  .catch(() => {
                    record.usage = null;
                    record.captureError = true;
                  }),
              );
            }
            return response;
          } catch (error) {
            record.failed = true;
            record.elapsedMs = Date.now() - start - record.startedMs;
            throw error;
          }
        };
      };
      let result: any;
      let error: string | undefined;
      try {
        // A case whose scope never resolved has nothing to ask.
        if (!failure)
          result = await Zotero.LLMForZotero.api.agent.runTurn(
            {
              conversationKey:
                Math.floor(Date.now() / 10) + evaluationCases.indexOf(entry),
              mode: "agent",
              libraryID: realScope ? realScope.libraryID : refs[0].libraryID,
              // A library case has no active paper: the collection is the scope.
              ...(realScope
                ? realScope.request
                : libraryCase
                  ? {
                      conversationKind: "global",
                      selectedCollectionContexts: libraryScope
                        ? [libraryScope]
                        : [],
                      selectedPaperContexts: [],
                    }
                  : {
                      conversationKind: "paper",
                      activeItemId: refs[0].itemId,
                      activePaperContext: refs[0],
                      selectedPaperContexts:
                        "multi" in entry && entry.multi ? refs : [],
                    }),
              ...credentials,
              ...("history" in entry ? { history: entry.history } : {}),
              ...(entry.id === "p4"
                ? {
                    history: [
                      {
                        role: "user",
                        content:
                          "Does a finite contact angle explain the pressure-gradient singularity?",
                      },
                      {
                        role: "assistant",
                        content:
                          "Yes. A finite nonzero contact angle necessarily forces the third derivative of the height profile, and therefore the pressure gradient, to diverge.",
                      },
                    ],
                  }
                : {}),
              userText: `${entry.question}\n\n${turnSuffix}${entry.provided ? `\n\n[Provided context]\n${entry.provided}` : ""}`,
            },
            (event: any) => {
              if (
                [
                  "tool_call",
                  "tool_result",
                  "message_rollback",
                  "usage",
                  "final",
                  "done",
                  "error",
                ].includes(event.type)
              )
                events.push({ ...event, atMs: Date.now() - start });
              if (event.type === "confirmation_required")
                void Zotero.LLMForZotero.api.agent.resolveConfirmation(
                  event.requestId,
                  false,
                );
            },
          );
      } catch (e) {
        error = String(e);
        if (soft) failure ??= { stage: "turn", message: failureMessage(e) };
      } finally {
        toolkit.getGlobal = original;
        await Promise.all(pending);
      }
      const delivered = events
        .filter((e) => e.type === "tool_result")
        .map((e) => JSON.stringify(e.content || {}))
        .join("\n");
      const calls = events.filter((e) => e.type === "tool_call");
      const usage = requests.map((r) => r.usage).filter(Boolean);
      const answer = String(result?.text || "");
      // Same selection the recompute script applies to a stored report: the
      // answer's own citations when the turn carries them, otherwise the ones
      // the tools delivered, so a baseline run is still scored.
      const { citations, finalCount } = citationsFromEvents(events);
      const report = {
        variant,
        repeat,
        id: entry.id,
        category: entry.category,
        question: entry.question,
        rubric: entry.rubric,
        provided: entry.provided,
        ...("history" in entry ? { history: entry.history } : {}),
        sourceEvidence: entry.evidence,
        scope: libraryCase ? "library" : "paper",
        ...(realScope ? { scopeResolved: realScope.resolved } : {}),
        outcome: result?.kind,
        error,
        answer,
        elapsedMs: Date.now() - start,
        support: measureSupport(answer, citations),
        grounding: measureGrounding(
          answer,
          new Set(citations.map((c) => c.id)),
        ),
        finalQuoteCitations: finalCount,
        deliveredSections: events
          .filter((e) => e.type === "tool_result" && e.name === "paper_read")
          .map((e) => ({
            callId: e.callId,
            sections: deliveredSectionsOf(e.content),
          })),
        acquisition: acquisitionOnly
          ? measureAcquisition(
              entry as AcquisitionCase,
              events,
              refs,
              realPaper ? [{ id: "peschka" }] : acquisitionPapers,
            )
          : {
              required: entry.evidence.length,
              found: entry.evidence.filter((s) =>
                clean(delivered).includes(clean(s)),
              ).length,
              reads: calls.filter((e) => e.name === "paper_read").length,
            },
        synthesis: {
          assessment: "source-based review required",
          candidate: answer,
        },
        verification: {
          assessment:
            entry.category === "verification"
              ? "seeded error or correct-control review required"
              : "final support review required",
          rollbacks: events.filter((e) => e.type === "message_rollback").length,
        },
        provider: {
          requests: requests.length,
          unknownUsage: requests.filter(
            (r) => !r.usage || r.usage.totalTokens === null,
          ).length,
          totalTokens: usage.reduce((s, u) => s + (u.totalTokens || 0), 0),
        },
        requests,
        events,
      };
      const verify = () => {
        assert.equal(
          result?.kind,
          "completed",
          error || result?.reason || "must complete",
        );
        assert.isNotEmpty(answer, "must retain a final answer");
        assert.isAbove(
          requests.length,
          0,
          "provider capture must observe requests",
        );
      };
      if (soft && !failure)
        try {
          verify();
        } catch (e) {
          failure = { stage: "assert", message: failureMessage(e) };
        }
      // Every case writes a report, including one that never got a scope, so
      // the summary shows the gap instead of losing the turn.
      await write(`${variant}-${repeat}-${entry.id}.json`, {
        ...report,
        ...(failure ? { failure } : {}),
      });
      if (!soft) verify();
    });
  }
});
