/**
 * Search routing, live: where the agent looks when a request says "search",
 * "check" or "look up", against the evidence ladder
 *   rung 1  the turn's papers (supplied text, then paper_read)
 *   rung 2  the user's library (library_retrieve, library_search)
 *   rung 3  outside (literature_search for scholarly, web_search/web_read
 *           for the web)
 * and the paper selection card (literature_review) only for a request to
 * find or recommend papers.
 *
 * The defect this suite measures: in a paper chat with the full text
 * supplied, "can you search and help me to know whether ..." made the model
 * call literature_search and then show the import card, never answering
 * from the paper; the same question without "search" answered from the
 * paper with no tool call.
 *
 * Every case records, per rep: the ordered tool calls with their arguments,
 * each call's family (local, scholarly, web, card, other), the cards shown,
 * the model rounds, the wall time, and the answer's length and paper
 * citations. Hard checks are few and named per case (S1, S1-control, S1b,
 * S2, S8, S10: no card; S1 family: the answer cites the paper; S4: the card
 * still opens with five rows). Everything else is reported, not asserted.
 *
 * Nothing attached (S7, S8; user decisions 1b and 2a, 2026-10-20): the
 * library is searched first and its results are in before any outside call
 * ("local earlier": a local call in an earlier round than the first outside
 * call). With relevant library papers (S8) the answer comes from them with
 * an offer to search outside: no card (hard), and no outside call, library
 * papers named or cited, and an offer (reported; the last two are
 * approximate English heuristics, namesAnyTitle and offersOutsideSearch).
 * With nothing relevant (S7) a find request goes to scholarly search and the
 * card without asking.
 *
 * Baseline: on the unchanged code S1 is expected to fail its hard check.
 * With LLM_FOR_ZOTERO_ROUTING_BASELINE=1 every hard check is recorded as a
 * reported failure instead of failing the test, so the run completes and
 * produces data. The runner aborts on the first failing test, so a run
 * without the flag stops at the first case that fails a hard check.
 *
 * Every card is cancelled: nothing is imported into the test library.
 *
 * Run with:
 *   ZOTERO_PLUGIN_KILL_COMMAND="pkill -9 -f \"$PWD/.scaffold/test/profile\" || true" \
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/agent/search-routing \
 *   LLM_FOR_ZOTERO_LIVE_MODEL=<model, default deepseek-v4-flash> \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<dev profile prefs.js> \
 *   LLM_FOR_ZOTERO_ROUTING_REPORT_DIR=<dir> \
 *   [LLM_FOR_ZOTERO_ROUTING_VARIANT=baseline] \
 *   [LLM_FOR_ZOTERO_ROUTING_BASELINE=1] \
 *   [LLM_FOR_ZOTERO_ROUTING_REPS=1] \
 *   [LLM_FOR_ZOTERO_ROUTING_CASES=S1,S1-control] \
 *   node scripts/run-workflow-tests.mjs --agent-live
 *
 * LLM_FOR_ZOTERO_LOOP_REPORT_DIR is accepted when the routing one is unset.
 * The web cases (S3, S6) need a web access key. When the scaffold profile
 * has none, the suite copies webAccessProvider, tavilyApiKey and
 * anysearchApiKey from the live profile's prefs.js for the run and restores
 * them after; without a key there either, those cases are skipped and the
 * reason is printed. No key is ever written to a report or printed.
 *
 * Real-paper mode: LLM_FOR_ZOTERO_ROUTING_PAPERS_DIR=<dir with manifest.json>
 * seeds the active paper and the library from a local, never-committed set of
 * real papers (their PDFs and MinerU text) instead of the authored fictional
 * fixtures, and the case prompts become paper-specific (S1 family, S2, S3,
 * S6, S7, S8, S10 and the S5 pair) from the manifest's "facts". The manifest
 * lists papers with title, creators ({firstName, lastName}), year, doi,
 * itemKey, role (active | library), pdfPath and textPath (relative to the
 * dir). Without the variable the authored fixtures are used, unchanged.
 * LLM_FOR_ZOTERO_ROUTING_WEB_PROVIDER=tavily copies tavilyApiKey from the
 * live profile and selects Tavily; =anysearch selects the keyless provider;
 * unset keeps the behavior above.
 */
import { assert } from "chai";
import { papers as authoredPapers } from "../../../test/fixtures/qaEvaluation/corpus";
import { paragraphCitationIds } from "../../../src/services/quotes/paragraphCitations";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../../src/services/mineru/mineruCache";
import {
  getWebAccessProvider,
  isWebAccessConfigured,
} from "../../../src/webAccess/prefs";
import { allocateEphemeralPaperConversationKey } from "../../../src/shared/conversationKeySpace";
import type { WorkflowTestApi } from "../../../src/modules/contextPanel/workflowTestTypes";
import {
  liveModelName,
  resolveLiveAgentCredentials,
  stringPrefFromContents,
  type LiveAgentCredentials,
} from "../liveAgentCredentials";
import {
  classifyTool,
  formatSummaryTable,
  namesAnyTitle,
  observeToolResult,
  offersOutsideSearch,
  redactSecrets,
  statesAbsence,
  summarizeRoutingRep,
  type RoutingCall,
  type RoutingCard,
  type RoutingRepSummary,
  type SummaryRow,
} from "./searchRoutingMetrics";

declare const Zotero: any;
declare const IOUtils: any;
declare const Services: any;
declare const Ci: any;

const env = (key: string) => String(Services.env.get(key) || "").trim();
const reportDir =
  env("LLM_FOR_ZOTERO_ROUTING_REPORT_DIR") ||
  env("LLM_FOR_ZOTERO_LOOP_REPORT_DIR");
const variant = env("LLM_FOR_ZOTERO_ROUTING_VARIANT") || "unlabelled";
const baselineMode = env("LLM_FOR_ZOTERO_ROUTING_BASELINE") === "1";
const reps = Math.max(
  1,
  Math.floor(Number(env("LLM_FOR_ZOTERO_ROUTING_REPS") || 1)) || 1,
);
const selectedCases = new Set(
  env("LLM_FOR_ZOTERO_ROUTING_CASES")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
const papersDir = env("LLM_FOR_ZOTERO_ROUTING_PAPERS_DIR").replace(/\/+$/, "");
const webProviderChoice = env("LLM_FOR_ZOTERO_ROUTING_WEB_PROVIDER");
const PREF_PREFIX = "extensions.zotero.llmforzotero";
const MARK = `route${Date.now().toString(36)}`;
/** Web prefs the suite may copy from the live profile for one run. */
const WEB_PREF_KEYS = ["webAccessProvider", "tavilyApiKey", "anysearchApiKey"];

/**
 * The active paper: an authored, fictional fixture already in the repository
 * (test/fixtures/retrievalCorpus/bioSingleHash.md). Its Results report the
 * per-cell answer: place fields stay present, but lap-to-lap stability falls
 * after sleep restriction, most for low-rate cells, and recovers after one
 * recovery sleep. No third-party paper text.
 */
const ACTIVE_PAPER_FIXTURE = "test/fixtures/retrievalCorpus/bioSingleHash.md";
const ACTIVE_PAPER_TITLE =
  "Sleep pressure reshapes place field stability in the rodent hippocampus";

/** The in-paper result the S1 family asks about, in the user's phrasing. */
const S1_SUBJECT =
  "the place fields of the place cells (at each individual neuron) are stable after sleep restriction";
/**
 * The fixture names no software or dataset, so S3 and S6 name a widely used
 * spike sorter in the prompt and tie it to the paper's own spike-sorting
 * step ("automatic clustering"). See the report for the options.
 */
const TOOL_QUESTION =
  "This paper sorted its spikes with automatic clustering. Search online whether Kilosort, a widely used automatic spike-sorting package, is still maintained and when its latest release came out.";

/** The user's own wording of the original bug report (real-paper mode). */
const REAL_S1_SUBJECT =
  "the tuning of the head direction neurons (at each individual neuron) are stable";
const REAL_OTHER_STUDIES =
  "can you search whether other studies found the same stability of head-direction tuning across days?";

type ManifestPaper = {
  title: string;
  creators: Array<{ firstName?: string; lastName: string }>;
  year: string;
  doi?: string;
  itemKey?: string;
  role: "active" | "library";
  pdfPath?: string | null;
  textPath?: string | null;
};
type ManifestFacts = {
  /** The in-paper result the S1 family asks about (a short fact). */
  s1Result: string;
  /** A named tool, package or dataset the active paper used. */
  tool: string;
  /** A topic present in the library (S8). */
  presentTopic: string;
  /** A topic absent from the library (S7). */
  absentTopic: string;
  /** The claim the S5 pair searches a collection for. */
  collectionClaim: string;
};
type Manifest = { papers: ManifestPaper[]; facts: ManifestFacts };

type Scope = "paper" | "collection" | "global" | "side";

type RoutingCase = {
  id: string;
  title: string;
  scope: Scope;
  prompt: string;
  /** Needs a web access key (web_search/web_read must be offered). */
  needsWeb?: boolean;
  /** Hard checks, each a label and a test of one rep. */
  hard?: Array<{
    label: string;
    check: (rep: RepRecord) => boolean;
  }>;
  /** Reported expectations, never asserted. */
  soft?: Array<{ label: string; check: (rep: RepRecord) => boolean | null }>;
  /** Set when the case cannot run in this harness. */
  skipReason?: string;
};

type RepRecord = {
  rep: number;
  conversationKey: number;
  outcome: string;
  runStatus?: string;
  stopRule?: string;
  error?: string;
  wallMs: number;
  /** Agent model requests (requests that carried tool definitions). */
  modelRounds: number;
  /** The highest round a usage event named, a second count of rounds. */
  usageRounds: number;
  utilityRequests: number;
  calls: RoutingCall[];
  cards: RoutingCard[];
  summary: RoutingRepSummary;
  answerChars: number;
  answerExcerpt: string;
  /** Paragraph ([[cite:]]) and quote ([[quote:]]) IDs the answer uses. */
  citationIdsUsed: string[];
  /** Used IDs that point to the active paper's passages. */
  paperCitationIdsUsed: string[];
  citesPaper: boolean;
  /** Approximate: the answer says a search found no study (statesAbsence). */
  absenceAnswer: boolean;
  /**
   * Approximate: the answer cites a passage (every citable passage in this
   * suite is a library paper's) or names a seeded paper's title.
   */
  namesLibraryPaper: boolean;
  /** Approximate: the answer offers to search outside (offersOutsideSearch). */
  offersOutside: boolean;
  hardFailures: string[];
  softResults: Record<string, boolean | null>;
};

/**
 * Cases whose prompt asks no find or recommend request: a workflow:'review'
 * search there is a card leak (reported, never asserted).
 */
const NON_FIND_CASES = new Set([
  "S1",
  "S1-control",
  "S1b-check",
  "S1b-lookup",
  "S2",
  "S3",
  "S5",
  "S6",
  "S10",
]);

const NO_CARD = [
  {
    label: "no literature_review call",
    check: (rep: RepRecord) => rep.summary.literatureReviewCalls === 0,
  },
  {
    label: "no confirmation_required card",
    check: (rep: RepRecord) => rep.cards.length === 0,
  },
];
const CITES_PAPER = {
  label: "answer cites the paper",
  check: (rep: RepRecord) => rep.citesPaper,
};
const LOCAL_FIRST = {
  label: "local or library call before (or with) the first outside call",
  check: (rep: RepRecord) => rep.summary.localBeforeOutside,
};
/** Nothing attached: the library's results were in before going outside. */
const LIBRARY_RESULT_FIRST = {
  label: "library result before the first outside call (an earlier round)",
  check: (rep: RepRecord) => rep.summary.localResultBeforeOutside,
};

const CASES: RoutingCase[] = [
  {
    id: "S1",
    title: "paper chat: 'can you search and help me to know whether ...'",
    scope: "paper",
    prompt: `can you search and help me to know whether ${S1_SUBJECT}?`,
    hard: [...NO_CARD, CITES_PAPER],
    soft: [
      {
        label: "no outside call",
        check: (rep) => rep.summary.outsideCalls === 0,
      },
    ],
  },
  {
    id: "S1-control",
    title: "paper chat: the S1 question without 'search' (speed reference)",
    scope: "paper",
    prompt: `can you help me to know whether ${S1_SUBJECT}?`,
    hard: [...NO_CARD, CITES_PAPER],
    soft: [
      {
        label: "no outside call",
        check: (rep) => rep.summary.outsideCalls === 0,
      },
    ],
  },
  {
    id: "S1b-check",
    title: "paper chat: the S1 question with 'check'",
    scope: "paper",
    prompt: `can you check and help me to know whether ${S1_SUBJECT}?`,
    hard: [...NO_CARD, CITES_PAPER],
    soft: [
      {
        label: "no outside call",
        check: (rep) => rep.summary.outsideCalls === 0,
      },
    ],
  },
  {
    id: "S1b-lookup",
    title: "paper chat: the S1 question with 'look up'",
    scope: "paper",
    prompt: `can you look up and help me to know whether ${S1_SUBJECT}?`,
    hard: [...NO_CARD, CITES_PAPER],
    soft: [
      {
        label: "no outside call",
        check: (rep) => rep.summary.outsideCalls === 0,
      },
    ],
  },
  {
    id: "S2",
    title: "paper chat: did other studies find the same result",
    scope: "paper",
    prompt:
      "can you search whether other studies found the same loss of place field stability after sleep restriction?",
    hard: [...NO_CARD],
    soft: [
      LOCAL_FIRST,
      {
        label: "scholarly search used",
        check: (rep) => rep.summary.familyCounts.scholarly > 0,
      },
    ],
  },
  {
    id: "S3",
    title: "paper chat: is a tool still maintained (web)",
    scope: "paper",
    needsWeb: true,
    prompt: TOOL_QUESTION,
    soft: [
      {
        label: "web used",
        check: (rep) => rep.summary.familyCounts.web > 0,
      },
      {
        label: "no card",
        check: (rep) => rep.cards.length === 0,
      },
    ],
  },
  {
    id: "S4",
    title: "paper chat: find five relevant papers (card control)",
    scope: "paper",
    prompt: "Find five papers relevant to the current paper.",
    hard: [
      {
        label: "literature_review called",
        check: (rep) => rep.summary.literatureReviewCalls > 0,
      },
      {
        label: "a literature_review card with 5 rows",
        check: (rep) =>
          rep.cards.some(
            (card) => card.toolName === "literature_review" && card.rows === 5,
          ),
      },
    ],
  },
  {
    id: "S5",
    title: "collection chat: search this collection for evidence",
    scope: "collection",
    prompt:
      "search this collection for evidence that neural representations change across days while behavior stays stable",
    soft: [
      {
        label: "library_retrieve used",
        check: (rep) =>
          rep.calls.some((call) => call.name === "library_retrieve"),
      },
      {
        label: "no outside call",
        check: (rep) => rep.summary.outsideCalls === 0,
      },
    ],
  },
  {
    id: "S5b",
    title: "collection chat: the S5 request plus recent literature",
    scope: "collection",
    prompt:
      "search this collection for evidence that neural representations change across days while behavior stays stable, and compare with recent literature",
    soft: [
      {
        label: "library_retrieve used",
        check: (rep) =>
          rep.calls.some((call) => call.name === "library_retrieve"),
      },
      {
        label: "scholarly search used",
        check: (rep) => rep.summary.familyCounts.scholarly > 0,
      },
      LOCAL_FIRST,
    ],
  },
  {
    id: "S6",
    title: "paper chat: in-paper result + other studies + web facts",
    scope: "paper",
    needsWeb: true,
    prompt:
      "For this paper, tell me whether the place fields of individual place cells stayed stable after sleep restriction, search whether other studies found the same, and search online whether Kilosort, a widely used automatic spike-sorting package, is still maintained.",
    soft: [
      LOCAL_FIRST,
      {
        label: "scholarly search used",
        check: (rep) => rep.summary.familyCounts.scholarly > 0,
      },
      {
        label: "web used",
        check: (rep) => rep.summary.familyCounts.web > 0,
      },
      {
        label: "answer cites the paper",
        check: (rep) => rep.citesPaper,
      },
    ],
  },
  {
    id: "S7",
    title: "nothing attached: papers on a topic absent from the library",
    scope: "global",
    prompt: "search for papers on coral bleaching during marine heatwaves",
    soft: [
      LOCAL_FIRST,
      LIBRARY_RESULT_FIRST,
      {
        label: "scholarly search used",
        check: (rep) => rep.summary.familyCounts.scholarly > 0,
      },
      {
        label: "card shown (a find request)",
        check: (rep) => rep.cards.length > 0,
      },
    ],
  },
  {
    id: "S8",
    title: "nothing attached: papers on a topic present in the library",
    scope: "global",
    prompt: "search for papers on representational drift",
    // The library holds relevant papers: answer from them, offer to search
    // outside, no card (user decision 2a, 2026-10-20).
    hard: [...NO_CARD],
    soft: [
      LOCAL_FIRST,
      LIBRARY_RESULT_FIRST,
      {
        label: "library call made",
        check: (rep) => rep.summary.localCalls > 0,
      },
      {
        label: "no outside call",
        check: (rep) => rep.summary.outsideCalls === 0,
      },
      {
        label: "answer cites or names library papers (approximate)",
        check: (rep) => rep.namesLibraryPaper,
      },
      {
        label: "answer offers to search outside (approximate)",
        check: (rep) => rep.offersOutside,
      },
    ],
  },
  {
    id: "S9",
    title: "paper chat with only partial text supplied",
    scope: "paper",
    prompt: `can you search and help me to know whether ${S1_SUBJECT}?`,
    // TODO(search-routing): force partial text. The only lever found is
    // request.advanced.inputTokenCap, which shrinks the paper budget
    // (0.55 x the input budget) but also the agent's whole prompt, so a cap
    // small enough to cut this 8 KB fixture risks prompt_budget_exceeded
    // or compaction and would not isolate the routing behavior. A long
    // authored fixture, or a test-only paper budget override, would.
    skipReason:
      "the harness cannot force partial or abstract-only paper text cheaply (see the TODO in the case)",
  },
  {
    id: "S10",
    title: "side chat (ephemeral key): the S2 request",
    scope: "side",
    prompt:
      "can you search whether other studies found the same loss of place field stability after sleep restriction?",
    hard: [...NO_CARD],
    soft: [
      LOCAL_FIRST,
      {
        label: "scholarly search used",
        check: (rep) => rep.summary.familyCounts.scholarly > 0,
      },
    ],
  },
];

/** Replaces the authored prompts with the real-paper ones (manifest facts). */
function applyRealPrompts(facts: ManifestFacts): void {
  const set = (id: string, prompt: string) => {
    const entry = CASES.find((candidate) => candidate.id === id);
    if (entry) entry.prompt = prompt;
  };
  set("S1", `can you search and help me to know whether ${REAL_S1_SUBJECT}?`);
  set("S1-control", `can you help me to know whether ${REAL_S1_SUBJECT}?`);
  set(
    "S1b-check",
    `can you check and help me to know whether ${REAL_S1_SUBJECT}?`,
  );
  set(
    "S1b-lookup",
    `can you look up and help me to know whether ${REAL_S1_SUBJECT}?`,
  );
  set("S9", `can you search and help me to know whether ${REAL_S1_SUBJECT}?`);
  set("S2", REAL_OTHER_STUDIES);
  set("S10", REAL_OTHER_STUDIES);
  const toolQuestion = `This paper used ${facts.tool}. Search online whether ${facts.tool} is still maintained and when its latest release came out.`;
  set("S3", toolQuestion);
  set(
    "S6",
    `For this paper, tell me whether the tuning of individual head-direction neurons stayed stable across days, search whether other studies found the same, and search online whether ${facts.tool} is still maintained.`,
  );
  set(
    "S5",
    `search this collection for evidence that ${facts.collectionClaim}`,
  );
  set(
    "S5b",
    `search this collection for evidence that ${facts.collectionClaim}, and compare with recent literature`,
  );
  set("S7", `search for papers on ${facts.absentTopic}`);
  set("S8", `search for papers on ${facts.presentTopic}`);
}

type SeededPaper = {
  itemId: number;
  attachmentId: number;
  title: string;
  /** Empty for a real PDF imported from the papers dir (nothing to remove). */
  tempPdfPath: string;
  ref: Record<string, unknown>;
};

function print(text: string): void {
  // The scaffold's test window forwards debug() to the terminal.
  const debug = (globalThis as { debug?: (data: unknown) => void }).debug;
  if (typeof debug === "function") debug(text);
  Zotero.debug(`[search-routing] ${text}`);
}

/** Paragraphs grouped into PDF pages that the harness's writer can hold. */
function pdfPages(markdown: string): string[] {
  const pages: string[] = [];
  let current = "";
  for (const paragraph of markdown.split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length > 3200) {
      pages.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) pages.push(current);
  return pages;
}

function quoteIds(text: string): string[] {
  return [...text.matchAll(/\[\[quote:([^\]\s]+)\]\]/g)].map(
    (match) => match[1],
  );
}

describe("live: search routing and the evidence ladder", function () {
  this.timeout(3_600_000);

  let creds: LiveAgentCredentials | null = null;
  let api: WorkflowTestApi;
  let active: SeededPaper | null = null;
  let collection: any = null;
  const seeded: SeededPaper[] = [];
  const summaryRows: SummaryRow[] = [];
  /** Original values of the web prefs the suite copied, by key. */
  const restoredWebPrefs = new Map<string, string>();
  let webAvailable = false;
  let webSource = "none";
  let manifest: Manifest | null = null;

  function wanted(id: string): boolean {
    return !selectedCases.size || selectedCases.has(id);
  }

  async function write(name: string, data: unknown): Promise<void> {
    if (!reportDir) return;
    await IOUtils.makeDirectory(reportDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.writeUTF8(
      `${reportDir}/${name}`,
      typeof data === "string" ? data : JSON.stringify(data, null, 2),
    );
  }

  function credentialFields() {
    return {
      model: creds?.model,
      apiBase: creds?.apiBase,
      apiKey: creds?.apiKey,
      providerProtocol: creds?.providerProtocol,
      ...(creds?.reasoningLevel
        ? { reasoning: { provider: "deepseek", level: creds.reasoningLevel } }
        : {}),
    };
  }

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  /** The plugin's own rule (isWebAccessToolAvailable), DeepSeek included. */
  function hasWebAccess(): boolean {
    return isWebAccessConfigured();
  }

  /**
   * Makes web access available for the run: the scaffold profile's own key
   * if it has one, otherwise the live profile's web prefs, copied into
   * Zotero.Prefs and restored in after(). Returns where access came from.
   */
  async function ensureWebAccess(): Promise<string> {
    if (webProviderChoice === "tavily" || webProviderChoice === "anysearch")
      return forceWebProvider(webProviderChoice);
    if (hasWebAccess()) return "scaffold profile";
    const profilePath = env("LLM_FOR_ZOTERO_LIVE_PROFILE_PATH");
    if (!profilePath) return "none";
    let contents = "";
    try {
      contents = String(await Zotero.File.getContentsAsync(profilePath));
    } catch {
      return "none";
    }
    for (const key of WEB_PREF_KEYS) {
      const value = stringPrefFromContents(contents, `${PREF_PREFIX}.${key}`);
      if (!value) continue;
      rememberWebPref(key);
      Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
    }
    return hasWebAccess() ? "live profile prefs.js" : "none";
  }

  function rememberWebPref(key: string): void {
    if (restoredWebPrefs.has(key)) return;
    restoredWebPrefs.set(
      key,
      String(Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true) || ""),
    );
  }

  /**
   * LLM_FOR_ZOTERO_ROUTING_WEB_PROVIDER: pins the provider for the run.
   * Tavily copies its key from the live profile (never printed or reported).
   */
  async function forceWebProvider(
    provider: "tavily" | "anysearch",
  ): Promise<string> {
    if (provider === "tavily") {
      const profilePath = env("LLM_FOR_ZOTERO_LIVE_PROFILE_PATH");
      let key = "";
      try {
        if (profilePath)
          key = stringPrefFromContents(
            String(await Zotero.File.getContentsAsync(profilePath)),
            `${PREF_PREFIX}.tavilyApiKey`,
          );
      } catch {
        key = "";
      }
      if (!key) return "none";
      rememberWebPref("tavilyApiKey");
      Zotero.Prefs.set(`${PREF_PREFIX}.tavilyApiKey`, key, true);
    }
    rememberWebPref("webAccessProvider");
    Zotero.Prefs.set(`${PREF_PREFIX}.webAccessProvider`, provider, true);
    if (provider === "tavily")
      return hasWebAccess() && getWebAccessProvider() === "tavily"
        ? "tavily (key from live profile prefs.js)"
        : "none";
    return "anysearch (forced)";
  }

  function restoreWebPrefs(): void {
    for (const [key, value] of restoredWebPrefs) {
      if (value) Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
      else Zotero.Prefs.clear(`${PREF_PREFIX}.${key}`, true);
    }
    restoredWebPrefs.clear();
  }

  /** One authored paper: a generated PDF plus its MinerU text. */
  async function seedPaper(input: {
    title: string;
    author: string;
    year: string;
    markdown: string;
    /** Absolute path of a real PDF to import instead of a generated one. */
    realPdfPath?: string;
    creators?: Array<{ firstName?: string; lastName: string }>;
    doi?: string;
  }): Promise<SeededPaper> {
    let fixture: {
      parentItemId: number;
      pdfAttachmentId: number;
      tempPdfPath: string;
    };
    if (input.realPdfPath) {
      const parent = new Zotero.Item("journalArticle");
      parent.libraryID = libraryID();
      parent.setField("title", input.title);
      const parentItemId = Math.floor(Number(await parent.saveTx()));
      const imported = await Zotero.Attachments.importFromFile({
        file: input.realPdfPath,
        parentItemID: parentItemId,
        contentType: "application/pdf",
      });
      fixture = {
        parentItemId,
        pdfAttachmentId: Math.floor(Number(imported.id)),
        tempPdfPath: "",
      };
    } else {
      fixture = await api.createPaperWithPdfFixture({
        title: input.title,
        pages: pdfPages(input.markdown),
      });
    }
    const item = Zotero.Items.get(fixture.parentItemId);
    item.setField("date", input.year);
    if (input.doi) item.setField("DOI", input.doi);
    item.setCreators(
      input.creators?.length
        ? input.creators.map((creator) => ({
            creatorType: "author",
            firstName: creator.firstName || "",
            lastName: creator.lastName,
          }))
        : [
            {
              creatorType: "author",
              firstName: "Evaluation",
              lastName: input.author,
            },
          ],
    );
    await item.saveTx();
    const attachment = Zotero.Items.get(fixture.pdfAttachmentId);
    await writeMineruCacheFiles(attachment.id, input.markdown, [
      {
        relativePath: "full.md",
        data: new TextEncoder().encode(input.markdown),
      },
    ]);
    await writeMineruSourceProvenanceForAttachment(attachment);
    const paper: SeededPaper = {
      itemId: fixture.parentItemId,
      attachmentId: fixture.pdfAttachmentId,
      title: input.title,
      tempPdfPath: fixture.tempPdfPath,
      ref: {
        libraryID: libraryID(),
        itemId: fixture.parentItemId,
        contextItemId: fixture.pdfAttachmentId,
        title: input.title,
        firstCreator: input.author,
        year: input.year,
      },
    };
    seeded.push(paper);
    return paper;
  }

  /**
   * The authored place-field fixture, read from the source checkout: the
   * test bundle has no text loader for .md files. Zotero inherits the
   * runner's environment and working directory, so the checkout root is
   * PWD, INIT_CWD (npm) or the process's working directory.
   */
  async function readActivePaper(): Promise<string> {
    const roots = [env("PWD"), env("INIT_CWD")];
    try {
      roots.push(String(Services.dirsvc.get("CurWorkD", Ci.nsIFile).path));
    } catch {
      /* No working directory service: the env roots remain. */
    }
    for (const root of roots.filter(Boolean)) {
      const path = `${root}/${ACTIVE_PAPER_FIXTURE}`;
      try {
        if (await IOUtils.exists(path))
          return String(await IOUtils.readUTF8(path));
      } catch {
        /* Try the next root. */
      }
    }
    throw new Error(
      `cannot find ${ACTIVE_PAPER_FIXTURE} under ${roots.filter(Boolean).join(", ") || "any root"}; run the suite from the repository root`,
    );
  }

  function scopeFor(
    scope: Scope,
    conversationKey: number,
  ): Record<string, unknown> {
    if (scope === "paper" || scope === "side")
      return {
        conversationKey,
        conversationKind: "paper",
        libraryID: libraryID(),
        activeItemId: active!.itemId,
        activePaperContext: active!.ref,
        selectedPaperContexts: [],
      };
    if (scope === "collection")
      return {
        conversationKey,
        conversationKind: "global",
        libraryID: libraryID(),
        selectedPaperContexts: [],
        selectedCollectionContexts: [
          {
            collectionId: collection.id,
            name: collection.name,
            libraryID: collection.libraryID,
          },
        ],
      };
    return {
      conversationKey,
      conversationKind: "global",
      libraryID: libraryID(),
      selectedPaperContexts: [],
    };
  }

  function newConversationKey(scope: Scope): number {
    if (scope === "side") return allocateEphemeralPaperConversationKey();
    const base = scope === "paper" ? 3_100_000 : 3_300_000;
    return base + Math.floor(Math.random() * 100_000);
  }

  /** One measured turn. Provider traffic is observed at the plugin's fetch. */
  async function runRep(
    routingCase: RoutingCase,
    rep: number,
  ): Promise<RepRecord> {
    const agent = Zotero.LLMForZotero.api.agent;
    const toolkit = Zotero.LLMForZotero.data.ztoolkit;
    const original = toolkit.getGlobal;
    const fetch = original.call(toolkit, "fetch");
    const conversationKey = newConversationKey(routingCase.scope);
    const start = Date.now();
    let modelRounds = 0;
    let utilityRequests = 0;
    let usageRounds = 0;
    const calls = new Map<string, RoutingCall>();
    const order: string[] = [];
    const cards: RoutingCard[] = [];
    let runStatus: string | undefined;
    let stopRule: string | undefined;
    toolkit.getGlobal = function (name: string) {
      if (name !== "fetch") return original.call(toolkit, name);
      return async (url: string, init?: RequestInit) => {
        try {
          const body = JSON.parse(String(init?.body || "{}"));
          if (Array.isArray(body.tools) && body.tools.length) modelRounds += 1;
          else if (
            !/embed/i.test(url) &&
            (body.model || body.messages || body.input || body.contents)
          )
            utilityRequests += 1;
        } catch {
          /* A body that is not JSON is not a model request. */
        }
        return fetch(url, init);
      };
    };
    let result: any;
    let error: string | undefined;
    try {
      result = await agent.runTurn(
        {
          mode: "agent",
          userText: routingCase.prompt,
          ...scopeFor(routingCase.scope, conversationKey),
          ...credentialFields(),
        },
        (event: any) => {
          if (event?.type === "usage" && Number(event.round) > usageRounds)
            usageRounds = Number(event.round);
          if (event?.type === "tool_call") {
            const key = String(event.callId || order.length);
            order.push(key);
            const name = String(event.name);
            calls.set(key, {
              name,
              family: classifyTool(name),
              // Agent requests seen at fetch; a transport that bypasses the
              // plugin's fetch falls back to the usage events' rounds.
              round: Math.max(1, modelRounds || usageRounds),
              args: redactSecrets(event.arguments ?? event.args ?? {}),
              startedMs: Date.now() - start,
            });
          }
          if (event?.type === "tool_result") {
            const call = calls.get(String(event.callId || ""));
            if (call) {
              call.ok = Boolean(event.ok);
              // Result count, provider message and warnings, and whether
              // the result carried the finish-now note.
              Object.assign(
                call,
                redactSecrets(observeToolResult(event.content)),
              );
            }
          }
          if (event?.type === "tool_error") {
            const call = calls.get(String(event.callId || ""));
            if (call) {
              call.ok = false;
              call.error = redactSecrets(String(event.error || "")).slice(
                0,
                300,
              );
            }
          }
          if (
            event?.type === "provider_event" &&
            event.providerType === "agent_run_stop"
          ) {
            const payload = (event.payload || {}) as Record<string, unknown>;
            runStatus = String(payload.status || "");
            stopRule = String(payload.rule || "");
          }
          if (event?.type === "confirmation_required" && event.requestId) {
            const action = event.action || {};
            const list = (action.fields || []).find(
              (field: any) => field?.id === "selectedPaperIds",
            );
            const cancelId = String(action.cancelActionId || "cancel");
            cards.push({
              toolName: String(action.toolName || ""),
              title: String(action.title || ""),
              rows: Array.isArray(list?.rows) ? list.rows.length : 0,
              resolvedAs: cancelId,
            });
            // Never import into the test library: every card is cancelled.
            void agent.resolveConfirmation(event.requestId, {
              approved: false,
              actionId: cancelId,
            });
          }
        },
      );
    } catch (caught) {
      error = redactSecrets(String((caught as Error)?.message || caught));
    } finally {
      toolkit.getGlobal = original;
    }
    const answer = String(result?.text || "");
    const used = [...paragraphCitationIds(answer), ...quoteIds(answer)];
    const paperIds = new Set(
      ((result?.quoteCitations || []) as any[])
        .filter(
          (citation) =>
            active && Number(citation?.contextItemId) === active.attachmentId,
        )
        .map((citation) => String(citation.id)),
    );
    const paperUsed = used.filter((id) => paperIds.has(id));
    const orderedCalls = order.map((key) => calls.get(key)!).filter(Boolean);
    const record: RepRecord = {
      rep,
      conversationKey,
      outcome: error ? "error" : String(result?.kind || "unknown"),
      runStatus,
      stopRule,
      error,
      wallMs: Date.now() - start,
      modelRounds,
      usageRounds,
      utilityRequests,
      calls: orderedCalls,
      cards,
      summary: summarizeRoutingRep(orderedCalls, cards),
      answerChars: answer.length,
      answerExcerpt: answer.slice(0, 4000),
      citationIdsUsed: used,
      paperCitationIdsUsed: paperUsed,
      citesPaper: paperUsed.length > 0,
      absenceAnswer: statesAbsence(answer),
      namesLibraryPaper:
        used.length > 0 ||
        namesAnyTitle(
          answer,
          seeded.map((paper) => paper.title),
        ),
      offersOutside: offersOutsideSearch(answer),
      hardFailures: [],
      softResults: {},
    };
    for (const check of routingCase.hard || [])
      if (!check.check(record)) record.hardFailures.push(check.label);
    for (const check of routingCase.soft || [])
      record.softResults[check.label] = check.check(record);
    if (NON_FIND_CASES.has(routingCase.id))
      record.softResults["no workflow:'review' search"] =
        record.summary.reviewWorkflowCalls === 0;
    return record;
  }

  before(async function () {
    creds = await resolveLiveAgentCredentials({
      requestedModel: liveModelName("deepseek-v4-flash"),
    });
    if (!creds) {
      print(
        "skipped: no credentials for the requested model (set LLM_FOR_ZOTERO_LIVE_MODEL and LLM_FOR_ZOTERO_LIVE_PROFILE_PATH)",
      );
      this.skip();
    }
    api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
    // No MinerU parse runs during the suite: the fixtures carry their text.
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruGlobalAutoParse`, false, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruSyncEnabled`, false, true);
    webSource = await ensureWebAccess();
    webAvailable = webSource !== "none";
    const others: SeededPaper[] = [];
    if (papersDir) {
      manifest = JSON.parse(
        String(await IOUtils.readUTF8(`${papersDir}/manifest.json`)),
      ) as Manifest;
      applyRealPrompts(manifest.facts);
      for (const entry of manifest.papers) {
        if (!entry.pdfPath || !entry.textPath)
          throw new Error(`manifest paper lacks a PDF or text: ${entry.title}`);
        const paper = await seedPaper({
          title: entry.title,
          author: entry.creators[0]?.lastName || "Unknown",
          year: entry.year,
          markdown: String(
            await IOUtils.readUTF8(`${papersDir}/${entry.textPath}`),
          ),
          realPdfPath: `${papersDir}/${entry.pdfPath}`,
          creators: entry.creators,
          doi: entry.doi,
        });
        if (entry.role === "active") active = paper;
        else others.push(paper);
      }
      if (!active) throw new Error("manifest has no active paper");
    } else {
      active = await seedPaper({
        title: ACTIVE_PAPER_TITLE,
        author: "Fixture",
        year: "2024",
        markdown: await readActivePaper(),
      });
      // Two more authored fixtures make the library topic for S8
      // (representational drift) and the S5 collection.
      for (const paper of authoredPapers)
        others.push(
          await seedPaper({
            title: paper.title,
            author: paper.author,
            year: paper.year,
            markdown: paper.text,
          }),
        );
    }
    collection = new Zotero.Collection();
    collection.libraryID = libraryID();
    collection.name = `Search routing ${MARK}`;
    await collection.saveTx();
    await Zotero.DB.executeTransaction(async () => {
      await collection.addItems([
        active!.itemId,
        ...others.map((p) => p.itemId),
      ]);
    });
    let indexCoverage: unknown = "unavailable";
    try {
      const idle = await api.waitForLibraryTextIndexIdle?.(120_000);
      const coverage = await api.libraryTextIndexCoverage(
        seeded.map((paper) => paper.attachmentId),
      );
      indexCoverage = {
        idle,
        indexed: coverage.indexed.length,
        missing: coverage.missing.length,
        failed: coverage.failed.length,
      };
    } catch (caught) {
      indexCoverage = `error: ${String(caught)}`;
    }
    const skippedForWeb = CASES.filter(
      (entry) => entry.needsWeb && wanted(entry.id),
    ).map((entry) => entry.id);
    if (!webAvailable && skippedForWeb.length)
      print(
        `web access unavailable (no web key in the scaffold or the live profile): skipping ${skippedForWeb.join(", ")}`,
      );
    await write(`${variant}-setup.json`, {
      variant,
      mark: MARK,
      model: creds?.model,
      reasoning: creds?.reasoningLevel || null,
      baselineMode,
      reps,
      // Where web access came from, never the key itself.
      webAvailable,
      webSource,
      webProvider: getWebAccessProvider(),
      paperSource: manifest
        ? {
            kind: "real papers (local manifest)",
            active: manifest.papers
              .filter((entry) => entry.role === "active")
              .map((entry) => entry.title),
            library: manifest.papers
              .filter((entry) => entry.role === "library")
              .map((entry) => entry.title),
          }
        : { kind: "authored fixtures" },
      webProviderChoice: webProviderChoice || "unset",
      papers: seeded.map(({ tempPdfPath: _path, ...paper }) => paper),
      collection: { id: collection.id, name: collection.name },
      indexCoverage,
      startedAt: new Date().toISOString(),
    });
  });

  after(async function () {
    restoreWebPrefs();
    const table = formatSummaryTable(summaryRows);
    if (summaryRows.length) {
      await write(
        `${variant}-summary.md`,
        [
          `# Search routing live run: ${variant}`,
          "",
          `Model ${creds?.model} · reasoning ${creds?.reasoningLevel || "default"} · reps ${reps} · baseline mode ${baselineMode ? "on" : "off"} · web ${webAvailable ? webSource : "unavailable"} · finished ${new Date().toISOString()}`,
          "",
          table,
          "",
        ].join("\n"),
      );
      await write(`${variant}-summary.json`, summaryRows);
      print(`search routing summary (${variant})\n${table}`);
    }
    if (collection) {
      try {
        await collection.eraseTx();
      } catch {
        /* Cleanup must not hide a test result. */
      }
    }
    for (const paper of [...seeded].reverse()) {
      try {
        await Zotero.Items.get(paper.attachmentId)?.eraseTx();
        await Zotero.Items.get(paper.itemId)?.eraseTx();
        if (paper.tempPdfPath)
          await IOUtils.remove(paper.tempPdfPath, { ignoreAbsent: true });
      } catch {
        /* Cleanup must not hide a test result. */
      }
    }
  });

  for (const routingCase of CASES) {
    it(`${routingCase.id} ${routingCase.title}`, async function () {
      if (!wanted(routingCase.id)) this.skip();
      const skip = routingCase.skipReason
        ? routingCase.skipReason
        : routingCase.needsWeb && !webAvailable
          ? "web access unavailable: no web key in the scaffold or the live profile"
          : "";
      if (skip) {
        print(`${routingCase.id} skipped: ${skip}`);
        summaryRows.push({
          caseId: routingCase.id,
          rep: "-",
          status: `skipped: ${skip}`,
        });
        await write(`${variant}-${routingCase.id}.json`, {
          variant,
          case: routingCase.id,
          title: routingCase.title,
          prompt: routingCase.prompt,
          skipped: skip,
        });
        this.skip();
      }
      this.timeout(reps * 900_000);
      const records: RepRecord[] = [];
      for (let rep = 1; rep <= reps; rep += 1) {
        const record = await runRep(routingCase, rep);
        records.push(record);
        summaryRows.push({
          caseId: routingCase.id,
          rep,
          status: record.error
            ? `error: ${record.error.slice(0, 80)}`
            : record.hardFailures.length
              ? baselineMode
                ? "hard fail (reported)"
                : "hard fail"
              : record.outcome,
          wallSeconds: Math.round(record.wallMs / 100) / 10,
          rounds: record.modelRounds,
          local: record.summary.familyCounts.local,
          scholarly: record.summary.familyCounts.scholarly,
          web: record.summary.familyCounts.web,
          shell: record.summary.shellCalls,
          card: record.summary.familyCounts.card,
          confirmations: record.cards.length,
          localBeforeOutside: record.summary.localBeforeOutside,
          localResultBeforeOutside: record.summary.localResultBeforeOutside,
          searchesScholarly: record.summary.outsideSearchesScholarly,
          searchesWeb: record.summary.outsideSearchesWeb,
          nudgeFired: record.summary.nudgeFired,
          callsAfterNudge: record.summary.callsAfterNudge,
          latchFired: record.summary.latchFired,
          callsAfterLatch: record.summary.callsAfterLatch,
          latchRejections: record.summary.latchRejections,
          absenceAnswer: record.absenceAnswer,
          namesLibraryPaper: record.namesLibraryPaper,
          offersOutside: record.offersOutside,
          reviewWorkflowCalls: record.summary.reviewWorkflowCalls,
          citesPaper: record.citesPaper,
          answerChars: record.answerChars,
          hardFailures: record.hardFailures,
          toolSequence: record.summary.toolSequence,
        });
      }
      const hardFailures = records.flatMap((record) =>
        record.hardFailures.map((label) => `rep ${record.rep}: ${label}`),
      );
      await write(`${variant}-${routingCase.id}.json`, {
        variant,
        case: routingCase.id,
        title: routingCase.title,
        scope: routingCase.scope,
        prompt: routingCase.prompt,
        model: creds?.model,
        reasoning: creds?.reasoningLevel || null,
        baselineMode,
        webAvailable,
        hardChecks: (routingCase.hard || []).map((check) => check.label),
        softChecks: (routingCase.soft || []).map((check) => check.label),
        hardFailures,
        reps: records,
      });
      if (hardFailures.length && !baselineMode)
        assert.fail(
          `${routingCase.id} hard checks failed: ${hardFailures.join("; ")}`,
        );
    });
  }
});
