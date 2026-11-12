/**
 * Live replay of a reported quote false negative.
 *
 * Paper: Haimerl & Machens 2025, "Representational drift without synaptic
 * plasticity". A body paragraph of Section 2.3 ("Across days we find a
 * distribution of changes that is centered around zero ...") once received no
 * passage ID, so the model invented IDs (Q_20_dummy) or wrote bare blockquotes
 * that rendered as amber "not source" cards. This test asks two questions of
 * the same shape as the reported ones and asserts the invariants that the fix
 * restores.
 *
 * Run (the worktree has no .env; copy <main-checkout>/.env
 * into it first):
 *
 *   ZOTERO_PLUGIN_KILL_COMMAND='pkill -9 -f "scaffold/test/profile" || true' \
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/agent/quote-false-negative \
 *   LLM_FOR_ZOTERO_LIVE_PAPER_PDF=/abs/path/haimerl-machens-2025.pdf \
 *   LLM_FOR_ZOTERO_LIVE_PAPER_CACHE=/abs/path/mineru-cache-dir \
 *   LLM_FOR_ZOTERO_LIVE_REPORT_DIR=/abs/path/report-dir \
 *   LLM_FOR_ZOTERO_LIVE_MODELS=claude-opus-5-5 \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=/abs/path/to/prefs.js \
 *   node scripts/run-workflow-tests.mjs --agent-live
 *
 * Fixtures come from the environment, so the suite skips when they are absent:
 *   LLM_FOR_ZOTERO_LIVE_PAPER_PDF     PDF attached to the seeded paper
 *   LLM_FOR_ZOTERO_LIVE_PAPER_CACHE   directory with full.md + content_list.json
 *                                     (+ layout.json when present)
 *   LLM_FOR_ZOTERO_LIVE_REPORT_DIR    directory the JSON report is written into
 *   LLM_FOR_ZOTERO_LIVE_MODELS        comma separated, default claude-opus-5-5
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH  prefs.js holding the provider credentials
 *
 * The turns run through the agent API (as the other live agent tests do). The
 * final text and quote citations are then rendered with the panel's own
 * renderer (renderAssistantForPanel) and the resulting bubble DOM is inspected
 * (the "before gate" state).
 *
 * Then the background validation gate runs, the way the panel runs it after a
 * turn: prewarmQuoteSourcePageText, finalizeAssistantMessageQuoteCitations,
 * and waitForAssistantQuoteValidationForTests, all imported from src. The
 * workflow harness has no API for this, and a test bundle carries a private
 * copy of every src module (see test-workflows/hostSurfaceBootstrap.ts), so
 * this copy of the gate has its own caches and chat history. It reads PDF
 * pages through the shared Zotero.PDFWorker, and it writes its verdict to
 * message.quoteDisplayOverride. The test re-renders that override with
 * renderAssistantForPanel every 500 ms until the card statuses hold for three
 * polls (at most 90 s). Card status comes from the stored citation fields
 * (hasVerifiedQuoteLocation), so the plugin's own renderer shows the verdict.
 * The report lists per-turn counts before and after the gate.
 *
 * Paragraph-citation ([[cite:]]) passages sit in a lazy footer popover, so
 * they are judged from the stored citations with the renderer's own predicate
 * (hasVerifiedQuoteLocation), not from popover DOM.
 */
import { assert } from "chai";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "../liveAgentCredentials";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../../src/services/mineru/mineruCache";
import type { WorkflowTestApi } from "../../../src/modules/contextPanel/workflowTestTypes";
import "../../../test-workflows/hostSurfaceBootstrap";
import {
  finalizeAssistantMessageQuoteCitations,
  prewarmQuoteSourcePageText,
  waitForAssistantQuoteValidationForTests,
} from "../../../src/modules/contextPanel/quoteValidation/scheduling";
import { chatHistory } from "../../../src/modules/contextPanel/state";
import type { Message } from "../../../src/modules/contextPanel/types";
import { hasVerifiedQuoteLocation } from "../../../src/services/quotes/quoteCitations";
import { paragraphCitationIds } from "../../../src/services/quotes/paragraphCitations";
import type { QuoteCitation } from "../../../src/shared/types";

declare const Zotero: any;
declare const IOUtils: any;
declare const Services: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";

function environmentValue(key: string): string {
  try {
    return String(Services.env.get(key) || "").trim();
  } catch {
    return "";
  }
}

const PAPER_PDF_PATH = environmentValue("LLM_FOR_ZOTERO_LIVE_PAPER_PDF");
const PAPER_CACHE_DIR = environmentValue("LLM_FOR_ZOTERO_LIVE_PAPER_CACHE");
const REPORT_DIR = environmentValue("LLM_FOR_ZOTERO_LIVE_REPORT_DIR");
const PROFILE_PATH = environmentValue("LLM_FOR_ZOTERO_LIVE_PROFILE_PATH");
const MODELS = (
  environmentValue("LLM_FOR_ZOTERO_LIVE_MODELS") || "claude-opus-5-5"
)
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const PAPER_TITLE = "Representational drift without synaptic plasticity";
const PAPER_YEAR = "2025";
const PAPER_CREATORS = [
  { creatorType: "author", firstName: "Christian", lastName: "Haimerl" },
  { creatorType: "author", firstName: "Christian K.", lastName: "Machens" },
];

const TARGET_PHRASE =
  "Across days we find a distribution of changes that is centered around zero";

const TURN_1 =
  "This paper claims that a recurrent plus feedforward model of excitability changes keeps a decoder stable across days. Their decoder is trained on many days at once, and a decoder trained on one day loses accuracy on later days. How do the experimental data support the claim that drift lies in the null space of the readout? Please show where the paper makes this argument.";
const TURN_2 =
  "Can you elaborate on this part? Do the animal data support the claim that tuning drift stays bounded?";

const MIN_BLOCKQUOTE_CHARS = 24;
const GATE_MAX_WAIT_MS = 90_000;
const GATE_POLL_INTERVAL_MS = 500;
const GATE_STABLE_POLLS = 3;

type CardStatus = "verified" | "unresolved" | "not-source" | string;

type CardRecord = {
  id: string;
  status: CardStatus;
  /** Page of the verified location: pageHintLabel, else pageHintIndex + 1. */
  page: string;
  /** Page the card's citation label shows ("..., page N"), when it shows one. */
  labelPage: string;
  textHead: string;
  /** Text found in full.md (letters and digits only, case ignored). */
  inFullMd: boolean;
  /** Card sits in the paragraph-citation footer popover. */
  footer: boolean;
};

type FooterRecord = {
  id: string;
  status: "verified" | "unresolved" | "missing";
  page: string;
  textHead: string;
  chunkKind: string;
  inFullMd: boolean;
};

function normalizeSpace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Letters and digits only, lower case: tolerant of markdown and spacing. */
function looseKey(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function countStatuses(statuses: string[]): Record<string, number> {
  const counts: Record<string, number> = {
    verified: 0,
    unresolved: 0,
    "not-source": 0,
  };
  for (const status of statuses) counts[status] = (counts[status] || 0) + 1;
  return counts;
}

function pageOf(citation: QuoteCitation | undefined): string {
  if (!citation) return "";
  const label = String(citation.pageHintLabel || "").trim();
  if (label) return label;
  return typeof citation.pageHintIndex === "number" &&
    Number.isFinite(citation.pageHintIndex)
    ? String(citation.pageHintIndex + 1)
    : "";
}

function safeFileName(value: string): string {
  return String(value).replace(/[^a-z0-9._-]+/gi, "-");
}

/** Every string leaf of a provider request body, joined by newlines. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
}

/**
 * The label that precedes `phrase` in the paper context block: the nearest
 * "[passage Q_...]" or "[no passage ID]" before the phrase. Null when the
 * phrase is not in the text.
 */
function contextLabelFor(
  text: string,
  phrase: string,
): { label: string; kind: "passage-id" | "no-passage-id" } | null {
  const at = text.indexOf(phrase);
  if (at < 0) return null;
  const head = text.slice(0, at);
  const idMatches = [...head.matchAll(/\[passage (Q_[^\]\s]+)\]/g)];
  const lastId = idMatches[idMatches.length - 1];
  const lastNoId = head.lastIndexOf("[no passage ID]");
  const idAt = lastId?.index ?? -1;
  if (lastNoId > idAt)
    return { label: "[no passage ID]", kind: "no-passage-id" };
  if (lastId) return { label: `[passage ${lastId[1]}]`, kind: "passage-id" };
  return null;
}

function parseQuoteIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(/\[\[(?:cite|quote):([^\]]*)\]\]/g)) {
    for (const id of match[1].split(/[,\s]+/)) if (id) ids.push(id);
  }
  return ids;
}

describe("live: quote false negative replay (Haimerl & Machens 2025)", function () {
  this.timeout(900000);

  const createdItemIds: number[] = [];
  let parentId = 0;
  let attachmentId = 0;
  let paperRef: any;
  let fullMarkdownNormalized = "";
  let fullMarkdownLoose = "";

  async function writeJson(name: string, payload: unknown): Promise<void> {
    await Zotero.File.putContentsAsync(
      `${REPORT_DIR}/${name}`,
      JSON.stringify(payload, null, 2),
    );
  }

  before(async function () {
    if (!PAPER_PDF_PATH || !PAPER_CACHE_DIR || !REPORT_DIR) {
      this.skip();
      return;
    }
    await IOUtils.makeDirectory(REPORT_DIR, {
      createAncestors: true,
      ignoreExisting: true,
    });
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruEnabled`, false, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruGlobalAutoParse`, false, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruSyncEnabled`, false, true);

    const libraryID = Zotero.Libraries.userLibraryID;
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = libraryID;
    paper.setField("title", PAPER_TITLE);
    paper.setField("date", PAPER_YEAR);
    paper.setCreators(PAPER_CREATORS);
    parentId = Math.floor(Number(await paper.saveTx()));
    createdItemIds.push(parentId);

    const attachment = await Zotero.Attachments.importFromFile({
      file: PAPER_PDF_PATH,
      parentItemID: parentId,
      title: PAPER_PDF_PATH.split("/").pop() || "paper.pdf",
      contentType: "application/pdf",
    });
    attachmentId = Math.floor(Number(attachment.id));
    createdItemIds.push(attachmentId);

    const markdown = new TextDecoder("utf-8").decode(
      await IOUtils.read(`${PAPER_CACHE_DIR}/full.md`),
    );
    fullMarkdownNormalized = normalizeSpace(markdown);
    fullMarkdownLoose = looseKey(markdown);
    const files = [
      { relativePath: "full.md", data: new TextEncoder().encode(markdown) },
      {
        relativePath: "content_list.json",
        data: await IOUtils.read(`${PAPER_CACHE_DIR}/content_list.json`),
      },
    ];
    if (await IOUtils.exists(`${PAPER_CACHE_DIR}/layout.json`)) {
      files.push({
        relativePath: "layout.json",
        data: await IOUtils.read(`${PAPER_CACHE_DIR}/layout.json`),
      });
    }
    await writeMineruCacheFiles(attachmentId, markdown, files);
    try {
      await writeMineruSourceProvenanceForAttachment(attachment);
    } catch {
      // Provenance is optional for reads.
    }
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruEnabled`, true, true);

    paperRef = {
      libraryID,
      itemId: parentId,
      contextItemId: attachmentId,
      title: PAPER_TITLE,
      firstCreator: PAPER_CREATORS[0].lastName,
      year: PAPER_YEAR,
    };
  });

  after(async function () {
    for (const itemId of createdItemIds.reverse()) {
      try {
        const item = Zotero.Items.get(itemId);
        if (item) await item.eraseTx();
      } catch {
        // Best-effort cleanup must not hide the evaluation outcome.
      }
    }
  });

  for (const modelName of MODELS) {
    it(`keeps quotes grounded on ${modelName}`, async function () {
      let credentials: LiveAgentCredentials | null =
        await resolveLiveAgentCredentials({
          requestedModel: modelName,
          ...(PROFILE_PATH ? { profilePath: PROFILE_PATH } : {}),
        });
      if (!credentials) {
        // Fall back to whatever model the configured profile supports.
        credentials = await resolveLiveAgentCredentials({
          requestedModel: "",
          ...(PROFILE_PATH ? { profilePath: PROFILE_PATH } : {}),
        });
      }
      if (!credentials) {
        await writeJson(
          `quote-false-negative-${safeFileName(modelName)}.json`,
          {
            model: modelName,
            status: "no-credentials",
          },
        );
        this.skip();
        return;
      }

      const api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
      await api.reset();
      const panel = await api.renderPanelForItem(parentId);
      const mainDoc: Document = Zotero.getMainWindow().document;

      const conversationKey = Math.floor(Math.random() * 1_000_000) + 7_000_000;
      const reportName = `quote-false-negative-${safeFileName(credentials.model)}.json`;
      const report: Record<string, unknown> = {
        model: credentials.model,
        protocol: credentials.providerProtocol,
        conversationKey,
        targetPhrase: TARGET_PHRASE,
        turns: [] as unknown[],
      };
      const turnsReport = report.turns as any[];

      // Provider requests are searched for the paper context block.
      const requestTexts: string[] = [];
      const toolkit = Zotero.LLMForZotero.data.ztoolkit;
      const originalGetGlobal = toolkit.getGlobal;
      const nativeFetch = originalGetGlobal.call(toolkit, "fetch");
      let currentTurnRequests: string[] = requestTexts;
      toolkit.getGlobal = function (name: string) {
        if (name !== "fetch") return originalGetGlobal.call(toolkit, name);
        return async (url: string, init?: RequestInit) => {
          try {
            if (!/embed/i.test(String(url))) {
              const body = JSON.parse(String(init?.body || "{}"));
              if (body.messages || body.input || body.contents) {
                currentTurnRequests.push(stringLeaves(body).join("\n"));
              }
            }
          } catch {
            // Capture is evidence only; it must never break the request.
          }
          return nativeFetch(url, init);
        };
      };

      const mountedPanelId = panel.panelId;
      /** Quote cards of the newest bubble, with the stored citation of each. */
      const readCards = (
        bubble: HTMLElement | undefined,
        citations: QuoteCitation[] | undefined,
      ): CardRecord[] => {
        if (!bubble) return [];
        const byId = new Map(
          (citations || []).map((citation) => [citation.id, citation]),
        );
        return (
          Array.from(
            bubble.querySelectorAll(".llm-quote-card"),
          ) as HTMLElement[]
        ).map((card) => {
          const citationId = card.dataset.quoteCitationId || "";
          const citation = byId.get(citationId);
          const preview = normalizeSpace(
            card.querySelector(".llm-quote-card-preview")?.textContent ||
              card.querySelector(".llm-quote-card-body")?.textContent ||
              card.textContent ||
              "",
          );
          const text = normalizeSpace(
            citation?.displayQuoteText || citation?.quoteText || preview,
          );
          const labelPage =
            /\bpage\s+([^\s,)]+)/i.exec(
              card.querySelector(".llm-quote-card-citation")?.textContent || "",
            )?.[1] || "";
          return {
            id: citationId || card.dataset.quoteOccurrenceId || "",
            status: card.dataset.quoteStatus || "",
            page: pageOf(citation),
            labelPage,
            textHead: text.slice(0, 120),
            inFullMd:
              looseKey(text).length >= MIN_BLOCKQUOTE_CHARS &&
              fullMarkdownLoose.includes(looseKey(text)),
            footer: Boolean(card.closest(".llm-paper-source-passage")),
          };
        });
      };
      const lastBubbleOf = (): HTMLElement | undefined => {
        const nodes = mainDoc.querySelectorAll(
          `[data-workflow-panel-id="${mountedPanelId}"] .llm-message-content`,
        );
        return nodes[nodes.length - 1] as HTMLElement | undefined;
      };

      const failures: string[] = [];
      let verifiedAcrossTurns = 0;
      const history: Array<{ role: string; content: string }> = [];
      try {
        for (const [index, userText] of [TURN_1, TURN_2].entries()) {
          const turnRequests: string[] = [];
          currentTurnRequests = turnRequests;
          const events: any[] = [];
          const result = await Zotero.LLMForZotero.api.agent.runTurn(
            {
              conversationKey,
              mode: "agent",
              libraryID: Zotero.Libraries.userLibraryID,
              conversationKind: "paper",
              activeItemId: parentId,
              activePaperContext: paperRef,
              model: credentials.model,
              apiBase: credentials.apiBase,
              apiKey: credentials.apiKey,
              providerProtocol: credentials.providerProtocol,
              userText,
              ...(history.length ? { history: history.slice() } : {}),
            },
            (event: any) => {
              events.push(event);
              if (event?.type === "confirmation_required" && event.requestId) {
                void Zotero.LLMForZotero.api.agent.resolveConfirmation(
                  event.requestId,
                  true,
                );
              }
            },
          );
          const turnNumber = index + 1;
          assert.equal(
            result.kind,
            "completed",
            `turn ${turnNumber} must complete: ${JSON.stringify({ kind: result.kind, reason: result.reason })}`,
          );
          const text = String(result.text || "");
          const quoteCitations: any[] = result.quoteCitations || [];
          history.push(
            { role: "user", content: userText },
            { role: "assistant", content: text },
          );

          // Assertion 1: the target paragraph has a passage ID in the context.
          let contextLabel: ReturnType<typeof contextLabelFor> = null;
          for (const requestText of turnRequests) {
            const found = contextLabelFor(requestText, TARGET_PHRASE);
            if (found) {
              contextLabel = found;
              if (found.kind === "no-passage-id") break;
            }
          }
          const citationWithTarget = quoteCitations.find((citation) =>
            normalizeSpace(String(citation?.quoteText || "")).includes(
              TARGET_PHRASE,
            ),
          );

          // Assertion 2: every cite/quote ID resolves to a stored citation.
          const knownIds = new Set(quoteCitations.map((c: any) => c.id));
          const ids = parseQuoteIds(text);
          const idReport = ids.map((id) => ({
            id,
            resolved: knownIds.has(id),
          }));

          // Assertion 3: render with the panel's own renderer, inspect DOM.
          const rendered = await api.renderAssistantForPanel(panel.panelId, {
            text,
            quoteCitations,
          });
          const bubbles = mainDoc.querySelectorAll(
            `[data-workflow-panel-id="${panel.panelId}"] .llm-message-content`,
          );
          const bubble = bubbles[bubbles.length - 1] as HTMLElement | undefined;
          const quoteCards = bubble
            ? (Array.from(
                bubble.querySelectorAll(".llm-quote-card"),
              ) as HTMLElement[])
            : [];
          const cardReport = quoteCards.map((card) => ({
            status: card.dataset.quoteStatus || "",
            interactive: card.dataset.quoteInteractive || "",
            citationId: card.dataset.quoteCitationId || "",
            preview: normalizeSpace(
              card.querySelector(".llm-quote-card-preview")?.textContent ||
                card.textContent ||
                "",
            ).slice(0, 240),
          }));
          const plainBlockquotes = bubble
            ? (
                Array.from(
                  bubble.querySelectorAll("blockquote"),
                ) as HTMLElement[]
              )
                .filter((node) => !node.closest(".llm-quote-card"))
                .map((node) => {
                  const quoted = normalizeSpace(node.textContent || "");
                  return {
                    text: quoted.slice(0, 400),
                    chars: quoted.length,
                    verbatimInFullMd:
                      quoted.length >= MIN_BLOCKQUOTE_CHARS &&
                      fullMarkdownNormalized.includes(quoted),
                  };
                })
            : [];

          turnsReport.push({
            turn: turnNumber,
            userText,
            answer: text,
            toolCalls: events
              .filter((event) => event.type === "tool_call")
              .map((event) => event.name),
            quoteCitationIds: quoteCitations.map((c: any) => c.id),
            quoteCitationDetails: quoteCitations.map((c: any) => ({
              id: c.id,
              sourceMatchSource: c.sourceMatchSource,
              sourceChunkKind: c.sourceChunkKind,
              sourceSectionLabel: c.sourceSectionLabel,
              chars: String(c.quoteText || "").length,
              head: String(c.quoteText || "").slice(0, 120),
              tail: String(c.quoteText || "").slice(-80),
            })),
            citeAndQuoteIds: idReport,
            targetParagraphContextLabel: contextLabel?.label ?? null,
            targetParagraphInStoredCitations: Boolean(citationWithTarget),
            quoteCards: cardReport,
            plainBlockquotes,
            renderedBubbleFound: Boolean(bubble),
            renderedHasRawTokens:
              /\[\[(?:cite|quote):/.test(rendered.renderedText) ||
              /\[\[(?:cite|quote):/.test(bubble?.textContent || ""),
          });
          await writeJson(reportName, report);

          // The background gate: prewarm page text, finalize, wait, re-render.
          const turnEntry = turnsReport[turnsReport.length - 1];
          const pairedUser: Message = {
            role: "user",
            text: userText,
            timestamp: Date.now() - 1,
            paperContexts: [paperRef],
            fullTextPaperContexts: [paperRef],
            citationPaperContexts: [paperRef],
          };
          const gateMessage: Message = {
            role: "assistant",
            text,
            timestamp: Date.now(),
            quoteCitations: quoteCitations.map((citation) => ({ ...citation })),
          };
          chatHistory.set(conversationKey, [
            ...(chatHistory.get(conversationKey) || []),
            pairedUser,
            gateMessage,
          ]);
          const prewarmStartedAt = Date.now();
          const prewarm = await prewarmQuoteSourcePageText({
            conversationKey,
            paperContexts: [[paperRef]],
            contextItemIds: [attachmentId],
          });
          const prewarmMs = Date.now() - prewarmStartedAt;
          const gateStartedAt = Date.now();
          finalizeAssistantMessageQuoteCitations(gateMessage, {
            pairedUserMessage: pairedUser,
            conversationKey,
          });
          let gateSettled = false;
          void waitForAssistantQuoteValidationForTests(conversationKey).then(
            () => {
              gateSettled = true;
            },
            () => {
              gateSettled = true;
            },
          );
          let stablePolls = 0;
          let lastSignature = "";
          let polls = 0;
          let timedOut = false;
          let finalCards: CardRecord[] = [];
          let finalDisplay: { quoteCitations?: QuoteCitation[] } = {
            quoteCitations: gateMessage.quoteCitations,
          };
          let finalFooterIndicators = 0;
          let pollBubble: HTMLElement | undefined;
          for (;;) {
            // The override carries the gate's verdict; the stored text does not.
            const display = gateMessage.quoteDisplayOverride || {
              markdown: text,
              quoteCitations: gateMessage.quoteCitations,
            };
            pollBubble?.remove();
            await api.renderAssistantForPanel(mountedPanelId, {
              text: display.markdown,
              quoteCitations: display.quoteCitations,
            });
            pollBubble = lastBubbleOf();
            polls += 1;
            finalDisplay = display;
            finalCards = readCards(pollBubble, display.quoteCitations);
            finalFooterIndicators =
              pollBubble?.querySelectorAll(".llm-paper-source-indicator")
                .length || 0;
            const signature = JSON.stringify(
              finalCards.map((card) => [card.id, card.status, card.page]),
            );
            stablePolls = signature === lastSignature ? stablePolls + 1 : 1;
            lastSignature = signature;
            if (gateSettled && stablePolls >= GATE_STABLE_POLLS) break;
            if (Date.now() - gateStartedAt > GATE_MAX_WAIT_MS) {
              timedOut = true;
              break;
            }
            await Zotero.Promise.delay(GATE_POLL_INTERVAL_MS);
          }
          const timeToStableMs = Date.now() - gateStartedAt;

          const finalById = new Map(
            (finalDisplay.quoteCitations || []).map((citation) => [
              citation.id,
              citation,
            ]),
          );
          const footerRecords: FooterRecord[] = [
            ...paragraphCitationIds(text),
          ].map((id) => {
            const citation = finalById.get(id);
            const head = normalizeSpace(
              citation?.displayQuoteText || citation?.quoteText || "",
            );
            return {
              id,
              status: !citation
                ? "missing"
                : hasVerifiedQuoteLocation(citation)
                  ? "verified"
                  : "unresolved",
              page: pageOf(citation),
              textHead: head.slice(0, 120),
              chunkKind: citation?.sourceChunkKind || "",
              inFullMd:
                looseKey(head).length >= MIN_BLOCKQUOTE_CHARS &&
                fullMarkdownLoose.includes(looseKey(head)),
            };
          });
          const afterCounts = countStatuses(
            finalCards.map((card) => card.status),
          );
          const footerCounts = countStatuses(
            footerRecords.map((record) => record.status),
          );
          Object.assign(turnEntry, {
            gate: {
              prewarm: { ...prewarm, ms: prewarmMs },
              timeToStableMs,
              timedOut,
              gateSettled,
              polls,
              hasDisplayOverride: Boolean(gateMessage.quoteDisplayOverride),
              before: countStatuses(cardReport.map((card) => card.status)),
              after: afterCounts,
              cards: finalCards,
              footerIndicators: finalFooterIndicators,
              footerAfter: footerCounts,
              footer: footerRecords,
              unresolvedHeads: [
                ...finalCards
                  .filter((card) => card.status === "unresolved")
                  .map((card) => card.textHead),
                ...footerRecords
                  .filter((record) => record.status !== "verified")
                  .map((record) => record.textHead),
              ],
            },
          });
          await writeJson(reportName, report);

          if (timedOut)
            failures.push(
              `turn ${turnNumber}: quote gate did not settle within ${GATE_MAX_WAIT_MS} ms`,
            );
          for (const card of finalCards)
            if (card.status === "not-source")
              failures.push(
                `turn ${turnNumber}: after the gate, not-source card: ${card.textHead.slice(0, 80)}`,
              );
          const verbatimCards = finalCards.filter(
            (card) => card.inFullMd && !card.footer && card.id,
          );
          const verifiedWithPage = verbatimCards.filter(
            (card) =>
              card.status === "verified" &&
              Boolean(card.page || card.labelPage),
          );
          if (verbatimCards.length && !verifiedWithPage.length)
            failures.push(
              `turn ${turnNumber}: ${verbatimCards.length} card(s) quote full.md verbatim but none ended verified with a page`,
            );
          // Captions, tables and equations are laid out differently on the
          // PDF page than in the MinerU markdown; body prose must locate.
          for (const record of footerRecords)
            if (
              record.inFullMd &&
              record.status !== "verified" &&
              !/caption|table|equation|formula/i.test(record.chunkKind) &&
              // MinerU labels supplementary captions "body"; judge by text.
              !/^(?:Supplementary\s+)?(?:Figure|Fig\.|Table)\s*(?:[A-Z]\.?)?\d|^\||^\$\$/i.test(
                record.textHead,
              )
            )
              failures.push(
                `turn ${turnNumber}: body footer passage found in full.md ended ${record.status}: ${record.textHead.slice(0, 80)}`,
              );
          verifiedAcrossTurns +=
            finalCards.filter((card) => card.status === "verified").length +
            footerRecords.filter((record) => record.status === "verified")
              .length;

          // Collect failures so the report covers both turns before failing.
          if (contextLabel?.kind === "no-passage-id")
            failures.push(
              `turn ${turnNumber}: target paragraph is labeled [no passage ID] in the context block`,
            );
          for (const entry of idReport)
            if (!entry.resolved)
              failures.push(
                `turn ${turnNumber}: ID ${entry.id} is not in the stored quote citations`,
              );
          if (!bubble)
            failures.push(`turn ${turnNumber}: no rendered bubble found`);
          if (/\[\[(?:cite|quote):/.test(rendered.renderedText))
            failures.push(
              `turn ${turnNumber}: literal [[cite:/[[quote: remains in the rendered bubble`,
            );
          for (const card of cardReport)
            if (card.status === "not-source")
              failures.push(
                `turn ${turnNumber}: quote card with not-source status: ${card.preview.slice(0, 80)}`,
              );
          for (const block of plainBlockquotes)
            if (block.verbatimInFullMd)
              failures.push(
                `turn ${turnNumber}: verbatim source text rendered as a plain blockquote: ${block.text.slice(0, 80)}`,
              );
        }

        if (verifiedAcrossTurns === 0)
          failures.push("no card or footer passage ended verified in any turn");

        // Assertion 1 needs the paragraph in at least one provider request.
        const labelsSeen = turnsReport.map(
          (t) => t.targetParagraphContextLabel,
        );
        if (labelsSeen.every((label) => label === null))
          failures.push(
            "target paragraph never appeared in any provider request (partial context or text missing from full.md)",
          );
        else if (!labelsSeen.some((label) => /^\[passage Q_/.test(label || "")))
          failures.push(
            "no turn labeled the target paragraph with a passage ID",
          );
      } finally {
        toolkit.getGlobal = originalGetGlobal;
        report.failures = failures;
        await writeJson(reportName, report);
        await api.reset();
      }
      assert.deepEqual(failures, [], failures.join("\n"));
    });
  }
});
