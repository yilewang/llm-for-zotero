/**
 * Adaptive-loop scenarios, live: paper chat and library chat, actions, QA and
 * mixtures of both, run through the real Original Agent against a real model.
 *
 * Each scenario records, per turn, every provider request (agent, utility,
 * embedding) with its token usage, the wall time, the tool calls and their
 * failures, and an outcome check against Zotero's own state. Results are
 * written as JSON plus a summary table, so two builds can be compared.
 *
 * Opt-in and soft: nothing runs unless LLM_FOR_ZOTERO_LOOP_REPORT_DIR is set,
 * and a scenario that fails records its failure and lets the next one run.
 * A scenario that writes across the whole 250-paper fixture runs only with
 * LLM_FOR_ZOTERO_LIVE_HEAVY=1, so the routine run stays short.
 *
 * Run with:
 *   LLM_FOR_ZOTERO_LIVE_MODEL=<model> \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<dev profile prefs.js> \
 *   LLM_FOR_ZOTERO_LOOP_REPORT_DIR=<dir> \
 *   LLM_FOR_ZOTERO_LOOP_PAPERS_DIR=<dir with name.pdf, name.md, name.json> \
 *   LLM_FOR_ZOTERO_LOOP_VARIANT=<label> [LLM_FOR_ZOTERO_LOOP_CASES=a,b] \
 *   [LLM_FOR_ZOTERO_LIVE_HEAVY=1] \
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/loop \
 *   npm run test:agent:live
 */
import { assert } from "chai";
import { usageFromResponse } from "../../test/helpers/qaUsage";
import {
  generateSyntheticCorpus,
  type SyntheticPaper,
} from "../../test/helpers/syntheticLibraryCorpus";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../src/services/mineru/mineruCache";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";
import {
  callEmbeddings,
  getResolvedEmbeddingConfig,
} from "../../src/utils/llmClient";
import { cosineSimilarity } from "../../src/services/paperContent/pdfContext";
import {
  SECTION_INTENT_EXAMPLES,
  SECTION_INTENT_MARGIN,
} from "../../src/services/retrieval/sectionIntent";
import {
  isInSectionKinds,
  sectionLabelParts,
  type EvidenceSectionKind,
} from "../../src/shared/libraryChatEvidencePolicy";
import { loadPlanDocument } from "../../src/agent/documents/store";
import { ExecutionCheckpointFold } from "../../src/agent/execution/checkpointEvents";
import { getConversationKeyLedgerEntry } from "../../src/shared/conversationKeyLedger";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "../agent/liveAgentCredentials";

declare const Zotero: any;
declare const IOUtils: any;
declare const Services: any;

const env = (key: string) => String(Services.env.get(key) || "").trim();
const reportDir = env("LLM_FOR_ZOTERO_LOOP_REPORT_DIR");
const papersDir = env("LLM_FOR_ZOTERO_LOOP_PAPERS_DIR");
const variant = env("LLM_FOR_ZOTERO_LOOP_VARIANT") || "unlabelled";
const selectedCases = new Set(
  env("LLM_FOR_ZOTERO_LOOP_CASES").split(",").filter(Boolean),
);
const corpusSize = Number(env("LLM_FOR_ZOTERO_LOOP_CORPUS") || 250);
// "off" disables the library text index for an A/B run of the same build.
const indexSetting = env("LLM_FOR_ZOTERO_LOOP_INDEX");
// Scenarios that write across the whole large fixture are opt-in.
const heavy = env("LLM_FOR_ZOTERO_LIVE_HEAVY") === "1";
const MARK = `loop${Date.now().toString(36)}`;
const PREF_PREFIX = "extensions.zotero.llmforzotero";
/** The per-paper note job: its papers, and the notes after which Stop. */
const NOTE_JOB_PAPERS = 50;
const NOTE_JOB_STOP_AT = 20;
/**
 * The unfiled reorganization asks for "my unfiled papers": past this many
 * unfiled papers outside the fixture (a run on a copy of a real library),
 * it would sort mostly papers it cannot check, so it is skipped.
 */
const OTHER_UNFILED_LIMIT = 50;

/**
 * The live profile's embedding configuration. Only the calibration case
 * copies it, and it restores the prefs after: semantic search would change
 * every other scenario. A provider reused from the model providers needs
 * modelProviderGroups too.
 */
const EMBEDDING_PREF_KEYS = [
  "enableSemanticSearch",
  "embeddingProvider",
  "embeddingApiBase",
  "embeddingApiKey",
  "embeddingModel",
  "modelProviderGroups",
];

/**
 * Labelled questions for calibrating plain chat's section intent: methods,
 * results, limitations and general, in English (without a cue word),
 * Chinese, Japanese, German and Spanish, plus two unrelated requests and
 * two that ask for two sections.
 */
const SECTION_CALIBRATION_QUESTIONS: Array<{
  label: string;
  language: string;
  text: string;
}> = [
  {
    label: "methods",
    language: "en",
    text: "What procedures and techniques did the authors use in these studies?",
  },
  { label: "methods", language: "zh", text: "这些论文用了什么研究方法？" },
  {
    label: "methods",
    language: "ja",
    text: "これらの論文ではどのような研究手法が使われましたか？",
  },
  {
    label: "methods",
    language: "de",
    text: "Welche Methoden haben diese Studien verwendet?",
  },
  {
    label: "methods",
    language: "es",
    text: "¿Qué métodos utilizaron estos estudios?",
  },
  {
    label: "results",
    language: "en",
    text: "What did these studies discover?",
  },
  { label: "results", language: "zh", text: "这些研究的主要发现是什么？" },
  {
    label: "results",
    language: "ja",
    text: "これらの研究の主な結果は何ですか？",
  },
  {
    label: "results",
    language: "de",
    text: "Was sind die wichtigsten Ergebnisse dieser Studien?",
  },
  {
    label: "results",
    language: "es",
    text: "¿Cuáles son los principales resultados de estos estudios?",
  },
  {
    label: "limitations",
    language: "en",
    text: "What weaknesses or shortcomings do these studies have?",
  },
  { label: "limitations", language: "zh", text: "这些研究有哪些局限性？" },
  {
    label: "limitations",
    language: "ja",
    text: "これらの研究の限界は何ですか？",
  },
  {
    label: "limitations",
    language: "de",
    text: "Welche Einschränkungen haben diese Studien?",
  },
  {
    label: "limitations",
    language: "es",
    text: "¿Qué limitaciones tienen estos estudios?",
  },
  {
    label: "general",
    language: "en",
    text: "Give me an overview of these papers.",
  },
  { label: "general", language: "zh", text: "请概括一下这些论文。" },
  {
    label: "general",
    language: "ja",
    text: "これらの論文の概要を教えてください。",
  },
  {
    label: "general",
    language: "de",
    text: "Worum geht es in diesen Artikeln?",
  },
  { label: "general", language: "es", text: "¿De qué tratan estos artículos?" },
  {
    label: "unrelated",
    language: "en",
    text: "Translate this paragraph into French.",
  },
  { label: "unrelated", language: "zh", text: "把这段话翻译成英文。" },
  {
    label: "methods+results",
    language: "en",
    text: "How did the authors run their studies, and what did they discover?",
  },
  {
    label: "methods+results",
    language: "zh",
    text: "这些论文的方法和结果分别是什么？",
  },
];

/** One string or boolean pref read out of a profile prefs.js. */
function prefFromContents(
  contents: string,
  key: string,
): string | boolean | undefined {
  const escaped = `${PREF_PREFIX}.${key}`.replace(/\./g, "\\.");
  const match = contents.match(
    new RegExp(
      `user_pref\\("${escaped}",\\s*("(?:\\\\.|[^"\\\\])*"|true|false)\\);`,
    ),
  );
  if (!match) return undefined;
  if (match[1] === "true") return true;
  if (match[1] === "false") return false;
  try {
    return String(JSON.parse(match[1]));
  } catch {
    return undefined;
  }
}

/**
 * A provider error with the configured keys and common key shapes removed,
 * since some providers quote the key they rejected.
 */
function redactKeys(message: string): string {
  const keys = [
    String(Zotero.Prefs.get(`${PREF_PREFIX}.embeddingApiKey`, true) || ""),
  ];
  try {
    const groups = JSON.parse(
      String(
        Zotero.Prefs.get(`${PREF_PREFIX}.modelProviderGroups`, true) || "[]",
      ),
    );
    for (const group of Array.isArray(groups) ? groups : [])
      keys.push(String(group?.apiKey || ""));
  } catch {
    // No groups to redact.
  }
  let redacted = message;
  for (const key of keys.filter((entry) => entry.length >= 8))
    redacted = redacted.split(key).join("[key]");
  return redacted
    .replace(/\bsk-[\w*-]{6,}/g, "[key]")
    .replace(/\bAIza[\w-]{10,}/g, "[key]");
}

/** A library_retrieve call of one turn: what the model asked for, and the
 * sections its snippets came from. */
type RetrieveCall = {
  callId: string;
  args: {
    query?: unknown;
    queryVariants?: unknown;
    sections?: unknown;
    intent?: unknown;
    depth?: unknown;
  };
  ok?: boolean;
  snippets?: Array<{
    itemId?: string;
    title?: string;
    sectionLabel?: string;
    chunkKind?: string;
    matchMethod?: string;
  }>;
};

/** Records one turn's library_retrieve calls from its events. */
function collectRetrieveCalls(calls: RetrieveCall[]) {
  return (event: any) => {
    if (event?.type === "tool_call" && event.name === "library_retrieve") {
      const args = event.arguments ?? event.args ?? {};
      calls.push({
        callId: String(event.callId || event.id || calls.length),
        args: {
          query: args.query,
          queryVariants: args.queryVariants,
          sections: args.sections,
          intent: args.intent,
          depth: args.depth,
        },
      });
    }
    if (event?.type === "tool_result" && event.name === "library_retrieve") {
      const call =
        calls.find((entry) => entry.callId === String(event.callId || "")) ||
        [...calls].reverse().find((entry) => entry.ok == null);
      if (!call) return;
      call.ok = Boolean(event.ok);
      let content = event.content;
      if (typeof content === "string") {
        try {
          content = JSON.parse(content);
        } catch {
          content = {};
        }
      }
      call.snippets = (
        Array.isArray(content?.snippets) ? content.snippets : []
      ).map((snippet: any) => ({
        itemId: snippet?.itemId,
        title: snippet?.title,
        sectionLabel: snippet?.sectionLabel,
        chunkKind: snippet?.chunkKind,
        matchMethod: snippet?.matchMethod,
      }));
    }
  };
}

/** Whether the model named sections, and where the evidence came from. */
function retrieveSummary(asked: EvidenceSectionKind, calls: RetrieveCall[]) {
  const snippets = calls.flatMap((call) => call.snippets || []);
  const sectionLabels: Record<string, number> = {};
  for (const snippet of snippets) {
    const label = snippet.sectionLabel || "(none)";
    sectionLabels[label] = (sectionLabels[label] || 0) + 1;
  }
  return {
    retrieveCalls: calls.length,
    passedSections: calls.some(
      (call) => Array.isArray(call.args.sections) && call.args.sections.length,
    ),
    calls: calls.map((call) => ({
      ...call.args,
      ok: call.ok,
      snippets: call.snippets?.length ?? 0,
    })),
    snippets: snippets.length,
    // A snippet's label reads "Enclosing section › Own heading" when a
    // standard section encloses it; the enclosing section decides.
    snippetsInAskedSection: snippets.filter((snippet) => {
      const parts = sectionLabelParts(snippet.sectionLabel);
      return isInSectionKinds(
        [asked],
        parts.sectionLabel,
        snippet.chunkKind,
        parts.enclosingSection,
        snippet.title,
      );
    }).length,
    sectionLabels,
  };
}

type RequestRecord = {
  kind: "agent" | "utility" | "embedding";
  startedMs: number;
  elapsedMs?: number;
  status?: number;
  failed?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
};

type ToolRecord = {
  name: string;
  mode?: string;
  ok?: boolean;
  error?: string;
  inputRejected?: boolean;
  /** Argument keys and short scalar values, kept to explain a failure. */
  argsPreview?: string;
  /** Size of the result the model receives, as JSON characters. */
  resultChars?: number;
  /** paper_read: the mode it ran, the tool's default when none is named. */
  readMode?: string;
  /** paper_read: the papers it named, and those the paper ledger says it read. */
  paperIds?: number[];
  /** library_search: whether it asked for abstracts. */
  includesAbstract?: boolean;
  startedMs: number;
  endedMs?: number;
};

/** A part the model declared over papers, as Task progress counts it. */
type PartRecord = {
  description: string;
  effect: string;
  capability?: string;
  status: string;
  scope: boolean;
  targets: number;
  done: number;
  excepted: number;
  /** The papers the host excepted, with the reason it recorded. */
  exceptions: Array<{ reason: string; itemIds: number[] }>;
};

/** A run the harness stopped. */
type StopRecord = {
  /** When the harness pressed Stop, from the turn's start. */
  requestedAtMs?: number;
  /** Model requests refused after it, as a stopped run's are. */
  refusedRequests: number;
};

type TurnRecord = {
  scenario: string;
  label: string;
  userText: string;
  /** The run's end state from its last settled checkpoint (Stage 4). */
  endState?: string;
  /** Each outcome as origin:effect:status. */
  steps?: string[];
  /** The model's parts that name papers, from the last proven ledger. */
  parts: PartRecord[];
  outcome?: string;
  /**
   * The run's status and stop rule, as the runtime announced its ending.
   * `outcome` reads the stored run, which a conversation key without a key
   * ledger entry never gets; this does not depend on it.
   */
  runStatus?: string;
  stopRule?: string;
  error?: string;
  answer: string;
  documentId?: string;
  wallMs: number;
  requests: RequestRecord[];
  tools: ToolRecord[];
  confirmations: number;
  ledgerDeltas: number;
  ledgerPapers: number;
  /** Papers per strongest Task progress state this turn reached. */
  ledgerStates: Record<string, number>;
  /** The strongest Task progress state per paper, by item id. */
  paperStates: Record<string, string>;
  checkpoints: number;
  /** Checkpoint deltas the fold refused because they did not fit. */
  foldRefusals: number;
  /**
   * agent_long_job_page events: those naming a page, whether one reported
   * the job complete, and every payload.
   */
  longJobPages: number;
  longJobComplete: boolean;
  longJobEvents: Array<Record<string, unknown>>;
  /** Set when the turn ran with a stop condition. */
  stop?: StopRecord;
  statuses: string[];
};

/** paper_read's modes; the tool reads any other value as "overview". */
const PAPER_READ_MODES = new Set([
  "overview",
  "outline",
  "targeted",
  "full",
  "figures",
  "visual",
  "capture",
]);

function paperReadMode(value: unknown): string {
  return typeof value === "string" && PAPER_READ_MODES.has(value)
    ? value
    : "overview";
}

/** The papers a paper_read call names; an attachment stands for its paper. */
function paperIdsOfArgs(args: any): number[] {
  const selectors = [
    args?.target,
    ...(Array.isArray(args?.targets) ? args.targets : []),
  ].filter((entry) => entry && typeof entry === "object");
  const ids = selectors
    .map((selector: any) => {
      const id = Number(selector.itemId || selector.contextItemId || 0);
      if (!id) return 0;
      return Number(Zotero.Items.get(id)?.parentID) || id;
    })
    .filter((id: number) => id > 0);
  return [...new Set(ids)];
}

/** A ledger target's item id: `item:12` or, on folder parts, a bare `12`. */
function targetItemId(target: unknown): number {
  return Number(String(target || "").replace(/^item:/, "")) || 0;
}

function partRecord(task: any): PartRecord {
  const exceptions: any[] = task.exceptions || [];
  return {
    description: String(task.description || ""),
    effect: String(task.effect || ""),
    capability: task.capability ? String(task.capability) : undefined,
    status: String(task.status || ""),
    scope: Boolean(task.scope),
    targets: task.targets?.length || 0,
    done: task.doneTargets?.length || 0,
    excepted: exceptions.reduce(
      (total, entry) => total + (entry.targets?.length || 0),
      0,
    ),
    exceptions: exceptions.map((entry) => ({
      reason: String(entry.reason || ""),
      itemIds: (entry.targets || []).map(targetItemId).filter(Boolean),
    })),
  };
}

/**
 * How deep a turn read: paper_read calls by mode, and library_search calls
 * that asked for abstracts, each with the characters they returned.
 */
function readDepth(tools: ToolRecord[]) {
  const paperRead: Record<string, { calls: number; chars: number }> = {
    full: { calls: 0, chars: 0 },
    overview: { calls: 0, chars: 0 },
    targeted: { calls: 0, chars: 0 },
  };
  const librarySearchWithAbstract = { calls: 0, chars: 0 };
  for (const tool of tools) {
    if (tool.name === "paper_read") {
      const entry = (paperRead[tool.readMode || "overview"] ||= {
        calls: 0,
        chars: 0,
      });
      entry.calls += 1;
      entry.chars += tool.resultChars || 0;
    }
    if (tool.name === "library_search" && tool.includesAbstract) {
      librarySearchWithAbstract.calls += 1;
      librarySearchWithAbstract.chars += tool.resultChars || 0;
    }
  }
  return { paperRead, librarySearchWithAbstract };
}

/** A share rounded to two places, or null without a denominator. */
function ratio(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 100) / 100 : null;
}

/** A tag table row's tags as the panel submits them: a list. */
function tagList(value: unknown): string[] {
  return (Array.isArray(value) ? value : String(value || "").split(","))
    .map((tag) => String(tag).trim())
    .filter(Boolean);
}

/** The count a report states on the first line naming a folder, if any. */
function reportedCountIn(report: string, name: string): number | null {
  const key = name.toLowerCase();
  for (const line of report.split("\n")) {
    const at = line.toLowerCase().indexOf(key);
    if (at < 0) continue;
    const found =
      line.slice(at + key.length).match(/\b(\d{1,3})\b/) ||
      line.match(/\b(\d{1,3})\b/);
    if (found) return Number(found[1]);
  }
  return null;
}

/** A synthetic paper's abstract: its first page is its Abstract section. */
function abstractOf(paper: SyntheticPaper): string {
  return paper.pages[0].split("\n").slice(1).join(" ").trim();
}

/** A synthetic paper's topic: the title's words before "under". */
function primaryTopic(paper: SyntheticPaper): string {
  return paper.title.split(" under ")[0].toLowerCase();
}

/** The large fixture as the scenarios that share it see it. */
type LargeCorpus = {
  corpus: { seed: number; papers: SyntheticPaper[] };
  collection: any;
  /** The Zotero item of each corpus paper, by corpus paper id. */
  itemIds: Map<number, number>;
  /** The corpus paper of each Zotero item. */
  paperOf: Map<number, SyntheticPaper>;
  attachmentIds: number[];
  seedSeconds: number;
  indexCoverage: unknown;
  /** The scenario that seeded it; the others reuse it. */
  seededFor: string;
};

type PaperFixture = {
  name: string;
  itemId: number;
  attachmentId: number;
  title: string;
  firstCreator: string;
  year: string;
  markdown: string;
  ref: Record<string, unknown>;
};

function summarizeTurn(turn: TurnRecord) {
  const sum = (key: keyof RequestRecord) =>
    turn.requests.reduce(
      (total, request) => total + (Number(request[key]) || 0),
      0,
    );
  const failedTools = turn.tools.filter(
    (tool) => tool.ok === false && !tool.inputRejected,
  );
  // Input the provider did not serve from its cache, request by request
  // (usageFromResponse counts cached input inside inputTokens).
  const uncachedInputTokens = turn.requests.reduce(
    (total, request) =>
      typeof request.inputTokens === "number"
        ? total +
          Math.max(
            0,
            request.inputTokens - (Number(request.cachedInputTokens) || 0),
          )
        : total,
    0,
  );
  return {
    scenario: turn.scenario,
    label: turn.label,
    outcome: turn.outcome || (turn.error ? "error" : "unknown"),
    runStatus: turn.runStatus || "",
    stopRule: turn.stopRule || "",
    endState: turn.endState || "",
    steps: turn.steps || [],
    wallSeconds: Math.round(turn.wallMs / 100) / 10,
    agentRequests: turn.requests.filter((r) => r.kind === "agent").length,
    utilityRequests: turn.requests.filter((r) => r.kind === "utility").length,
    embeddingRequests: turn.requests.filter((r) => r.kind === "embedding")
      .length,
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    uncachedInputTokens,
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("reasoningTokens"),
    longJobPages: turn.longJobPages,
    longJobComplete: turn.longJobComplete,
    foldRefusals: turn.foldRefusals,
    readDepth: readDepth(turn.tools),
    toolCalls: turn.tools.length,
    // A1: outcomes the model declared; A4: documents it finalized.
    declaredTasks: turn.tools.filter((tool) => tool.name === "task_update")
      .length,
    documents: turn.tools.filter((tool) => tool.name === "submit_document")
      .length,
    toolSequence: turn.tools
      .map((tool) => `${tool.name}${tool.mode ? `:${tool.mode}` : ""}`)
      .join(" → "),
    largestResultChars: Math.max(
      0,
      ...turn.tools.map((tool) => tool.resultChars || 0),
    ),
    toolErrors: failedTools.map(
      (tool) => `${tool.name}: ${(tool.error || "").slice(0, 160)}`,
    ),
    inputRejections: turn.tools.filter((tool) => tool.inputRejected).length,
    confirmations: turn.confirmations,
    ledgerPapers: turn.ledgerPapers,
    ledgerStates: turn.ledgerStates,
    answerChars: turn.answer.length,
  };
}

/**
 * The reorganization fixture: four well-separated topics, six invented papers
 * each, every title and abstract naming its topic. `folder` recognises a
 * folder named for the topic.
 */
const REORGANIZE_TOPICS: Array<{
  topic: string;
  folder: RegExp;
  papers: Array<{ title: string; abstract: string }>;
}> = [
  {
    topic: "hippocampal place cells",
    folder: /place|hippocamp|spatial|navigat/i,
    papers: [
      {
        title: "Place field stability in CA1 across weeks of navigation",
        abstract:
          "We imaged CA1 place cells over six weeks and measured how stable their place fields stayed during repeated navigation.",
      },
      {
        title: "Remapping of hippocampal place cells in novel arenas",
        abstract:
          "Hippocampal place cells remapped when mice entered novel arenas, and the new spatial maps settled within two sessions.",
      },
      {
        title: "Theta phase precession in place cell sequences",
        abstract:
          "Place cells fired at progressively earlier theta phases as rats crossed their place fields, ordering spatial sequences.",
      },
      {
        title: "Place cell replay during rest after maze learning",
        abstract:
          "After maze learning, hippocampal place cell sequences replayed during rest, predicting later navigation accuracy.",
      },
      {
        title: "Representational drift of spatial maps in mouse hippocampus",
        abstract:
          "Spatial maps in mouse hippocampus drifted across days while the population still encoded the animal's position.",
      },
      {
        title: "Goal-directed reorganization of place fields",
        abstract:
          "Place fields in CA1 shifted toward rewarded goal locations as animals learned a spatial navigation task.",
      },
    ],
  },
  {
    topic: "thin films and wetting",
    folder: /film|fluid|wett?ing|droplet|interfac|capillar|surface|flow/i,
    papers: [
      {
        title: "Rupture of thin liquid films on heated substrates",
        abstract:
          "Thin liquid films on heated substrates ruptured through thermocapillary instabilities that we measured interferometrically.",
      },
      {
        title: "Contact line pinning on chemically patterned surfaces",
        abstract:
          "Chemical patterning pinned the contact line of spreading liquid films and set the hysteresis of the wetting angle.",
      },
      {
        title: "Marangoni flows driven by surface tension gradients",
        abstract:
          "Surface tension gradients drove Marangoni flows that thinned liquid films and controlled their drainage.",
      },
      {
        title: "Dewetting dynamics of polymer films",
        abstract:
          "Thin polymer films dewetted from silicon by hole nucleation, and the rim velocity followed a viscous scaling law.",
      },
      {
        title: "Viscous fingering of a liquid film in a Hele-Shaw cell",
        abstract:
          "A less viscous liquid displacing a film in a Hele-Shaw cell formed fingers whose width we predict from capillary number.",
      },
      {
        title: "Spreading of droplets on soft solids",
        abstract:
          "Droplets spreading on soft solids deformed the substrate at the contact line, slowing wetting by viscoelastic braking.",
      },
    ],
  },
  {
    topic: "transformer language models",
    folder:
      /transformer|language|nlp|llm|attention|machine learning|deep learning/i,
    papers: [
      {
        title: "Scaling laws for transformer language models",
        abstract:
          "Transformer language model loss fell as a power law in parameters, data and compute across seven orders of magnitude.",
      },
      {
        title: "Sparse attention for long-context transformers",
        abstract:
          "A sparse attention pattern let transformer language models process long contexts at linear cost with little accuracy loss.",
      },
      {
        title: "Instruction tuning improves zero-shot generalization",
        abstract:
          "Fine-tuning a pretrained language model on instructions improved its zero-shot performance on unseen language tasks.",
      },
      {
        title:
          "Retrieval-augmented generation for open-domain question answering",
        abstract:
          "A transformer language model that retrieved passages before generating answers outperformed larger closed-book models.",
      },
      {
        title: "Mixture-of-experts layers for efficient language models",
        abstract:
          "Routing tokens to sparse expert layers increased language model capacity without increasing computation per token.",
      },
      {
        title: "Probing syntax in pretrained transformer representations",
        abstract:
          "Linear probes recovered syntactic trees from the hidden states of pretrained transformer language models.",
      },
    ],
  },
  {
    topic: "coral reef ecology",
    folder: /coral|reef|marine|ocean/i,
    papers: [
      {
        title: "Coral bleaching under marine heatwaves",
        abstract:
          "Marine heatwaves caused mass coral bleaching across the reef, with mortality rising with accumulated heat stress.",
      },
      {
        title: "Herbivorous fish control algal cover on coral reefs",
        abstract:
          "Excluding herbivorous fish let algae overgrow coral reef plots, showing grazing keeps reefs coral-dominated.",
      },
      {
        title: "Larval recruitment on degraded coral reefs",
        abstract:
          "Coral larvae settled less often on degraded reefs, limiting recovery of coral cover after disturbance.",
      },
      {
        title: "Ocean acidification slows coral calcification",
        abstract:
          "Lower seawater pH from ocean acidification slowed coral calcification rates in reef mesocosm experiments.",
      },
      {
        title: "Symbiont shuffling in thermally stressed corals",
        abstract:
          "Corals under thermal stress shifted toward heat-tolerant algal symbionts, improving survival on warming reefs.",
      },
      {
        title: "Reef recovery after cyclone damage",
        abstract:
          "Coral reefs damaged by cyclones recovered their coral cover within a decade where water quality was high.",
      },
    ],
  },
];

describe("adaptive loop scenarios, live", function () {
  this.timeout(3_600_000);

  let creds: LiveAgentCredentials | null = null;
  let api: WorkflowTestApi;
  const created = { items: [] as number[], collections: [] as number[] };
  const summaries: Array<Record<string, unknown>> = [];
  const papers: PaperFixture[] = [];

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  function wanted(id: string): boolean {
    return !selectedCases.size || selectedCases.has(id);
  }

  async function write(name: string, data: unknown): Promise<void> {
    await IOUtils.makeDirectory(reportDir, { ignoreExisting: true });
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

  function paperChat(fixture: PaperFixture, extra: PaperFixture[] = []) {
    return {
      conversationKind: "paper",
      libraryID: libraryID(),
      activeItemId: fixture.itemId,
      activePaperContext: fixture.ref,
      selectedPaperContexts: extra.map((paper) => paper.ref),
    };
  }

  function libraryChat(collections: any[] = []) {
    return {
      conversationKind: "global",
      libraryID: libraryID(),
      selectedPaperContexts: [],
      selectedCollectionContexts: collections.map((collection) => ({
        collectionId: collection.id,
        name: collection.name,
        libraryID: collection.libraryID,
      })),
    };
  }

  /**
   * One measured agent turn. Provider traffic is observed at the plugin's own
   * fetch, so utility and embedding requests are counted with the agent's.
   */
  async function runTurn(params: {
    scenario: string;
    label: string;
    conversationKey: number;
    userText: string;
    scope: Record<string, unknown>;
    approve?: boolean;
    onEvent?: (event: any) => void;
    /**
     * Stops the run once `when` is true, as the panel's Stop does. It is
     * checked every half second, at every event and before every request.
     */
    stop?: { when: () => boolean };
  }): Promise<TurnRecord & { result: any }> {
    const agent = Zotero.LLMForZotero.api.agent;
    const toolkit = Zotero.LLMForZotero.data.ztoolkit;
    const original = toolkit.getGlobal;
    const fetch = original.call(toolkit, "fetch");
    const start = Date.now();
    const requests: RequestRecord[] = [];
    const pending: Promise<void>[] = [];
    const tools = new Map<string, ToolRecord>();
    const order: string[] = [];
    const statuses: string[] = [];
    const ledgerPapers = new Map<string, string>();
    const paperStates = new Map<number, string>();
    const STATE_RANK = ["listed", "matched", "skimmed", "read", "cited"];
    let confirmations = 0;
    let ledgerDeltas = 0;
    // Ledger publications: the run's first ledger whole, each later change a
    // delta (6.1b). Folded in order they give the ledger as it stands.
    let checkpoints = 0;
    let foldRefusals = 0;
    const ledger = new ExecutionCheckpointFold();
    let runStatus: string | undefined;
    let stopRule: string | undefined;
    let longJobPages = 0;
    let longJobComplete = false;
    const longJobEvents: Array<Record<string, unknown>> = [];
    // The panel's Stop aborts the signal its turn runs with: the runtime ends
    // the run as cancelled, and the abort cancels the request in flight. The
    // public agent API takes no signal (runTurn(request, onEvent)), so the
    // harness aborts at the plugin's fetch instead: the request in flight and
    // every later one fail as aborted, as on Stop, and the runtime ends the
    // run as interrupted by that error. The same signal goes to runTurn as a
    // third argument, ignored until the API accepts one; the run's status
    // (runStatus) tells the two endings apart.
    const AbortControllerCtor = params.stop
      ? (original.call(toolkit, "AbortController") as
          | (new () => AbortController)
          | undefined)
      : undefined;
    const stopController = AbortControllerCtor
      ? new AbortControllerCtor()
      : null;
    const stop: StopRecord | undefined = params.stop
      ? { refusedRequests: 0 }
      : undefined;
    const stopped = () => stop?.requestedAtMs !== undefined;
    const pressStop = () => {
      if (!stop || stopped()) return;
      let due = false;
      try {
        due = Boolean(params.stop?.when());
      } catch {
        due = false;
      }
      if (!due) return;
      stop.requestedAtMs = Date.now() - start;
      stopController?.abort();
    };
    const abortError = (): Error => {
      const DOMExceptionCtor = original.call(toolkit, "DOMException") as
        | (new (message: string, name: string) => Error)
        | undefined;
      return DOMExceptionCtor
        ? new DOMExceptionCtor("The operation was aborted.", "AbortError")
        : Object.assign(new Error("The operation was aborted."), {
            name: "AbortError",
          });
    };
    toolkit.getGlobal = function (name: string) {
      if (name !== "fetch") return original.call(toolkit, name);
      return async (url: string, init?: RequestInit) => {
        pressStop();
        if (stop && stopped()) {
          stop.refusedRequests += 1;
          throw abortError();
        }
        let body: any = {};
        try {
          body = JSON.parse(String(init?.body || "{}"));
        } catch {
          body = {};
        }
        const measured = Boolean(
          body.model || body.messages || body.input || body.contents,
        );
        const record: RequestRecord = {
          kind: /embed/i.test(url)
            ? "embedding"
            : body.tools?.length
              ? "agent"
              : "utility",
          startedMs: Date.now() - start,
        };
        if (measured) requests.push(record);
        try {
          const response = await fetch(
            url,
            stopController && !init?.signal
              ? { ...init, signal: stopController.signal }
              : init,
          );
          if (measured) {
            record.status = response.status;
            pending.push(
              response
                .clone()
                .text()
                .then((text: string) => {
                  record.elapsedMs = Date.now() - start - record.startedMs;
                  const usage = usageFromResponse(text);
                  if (usage) Object.assign(record, usage);
                })
                .catch(() => undefined),
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
    let settled = false;
    const polling = params.stop
      ? (async () => {
          while (!settled && !stopped()) {
            pressStop();
            await Zotero.Promise.delay(500);
          }
        })()
      : Promise.resolve();
    try {
      result = await agent.runTurn(
        {
          conversationKey: params.conversationKey,
          mode: "agent",
          userText: params.userText,
          ...params.scope,
          ...credentialFields(),
        },
        (event: any) => {
          pressStop();
          params.onEvent?.(event);
          if (event?.type === "tool_call") {
            const args = event.arguments ?? event.args ?? {};
            const key = String(event.callId || event.id || order.length);
            order.push(key);
            const record: ToolRecord = {
              name: String(event.name),
              mode:
                typeof args.mode === "string"
                  ? args.mode
                  : typeof args.kind === "string"
                    ? args.kind
                    : typeof args.operation === "string"
                      ? args.operation
                      : undefined,
              argsPreview: JSON.stringify(args, (_key, value) =>
                typeof value === "string" && value.length > 80
                  ? `${value.slice(0, 80)}…`
                  : value,
              ).slice(0, 400),
              startedMs: Date.now() - start,
            };
            if (record.name === "paper_read") {
              record.readMode = paperReadMode(args.mode);
              record.paperIds = paperIdsOfArgs(args);
            }
            if (record.name === "library_search")
              record.includesAbstract =
                Array.isArray(args.include) &&
                args.include.includes("abstract");
            tools.set(key, record);
          }
          if (event?.type === "tool_result") {
            const key = String(event.callId || "");
            const record =
              tools.get(key) ||
              [...tools.values()]
                .reverse()
                .find((tool) => tool.name === event.name && tool.ok == null);
            if (record) {
              record.ok = Boolean(event.ok);
              record.endedMs = Date.now() - start;
              try {
                record.resultChars = JSON.stringify(event.content ?? "").length;
              } catch {
                record.resultChars = undefined;
              }
              if (!event.ok && !record.error) {
                const content = event.content;
                record.error = String(
                  (content && (content.error || content.message)) ||
                    JSON.stringify(content || {}).slice(0, 300),
                );
              }
            }
          }
          // The host emits tool_error for every failure except a user denial.
          if (event?.type === "tool_error") {
            const record = tools.get(String(event.callId || ""));
            if (record) {
              record.ok = false;
              record.error = String(event.error || record.error || "");
              record.inputRejected =
                /\b(invalid|expected|must (?:be|include|provide)|is required|unknown (?:field|argument|parameter))\b/i.test(
                  record.error,
                );
            }
          }
          if (event?.type === "status" && event.text)
            statuses.push(String(event.text));
          if (event?.type === "paper_ledger_update") {
            ledgerDeltas += 1;
            const reader = tools.get(
              String(event.callId || event.delta?.callId || ""),
            );
            for (const entry of event.delta?.papers || []) {
              const key = String(entry.key || entry.itemId || "");
              const previous = ledgerPapers.get(key);
              if (
                !previous ||
                STATE_RANK.indexOf(entry.state) > STATE_RANK.indexOf(previous)
              )
                ledgerPapers.set(key, String(entry.state));
              const itemId = Number(entry.itemId) || 0;
              if (!itemId) continue;
              const before = paperStates.get(itemId);
              if (
                !before ||
                STATE_RANK.indexOf(entry.state) > STATE_RANK.indexOf(before)
              )
                paperStates.set(itemId, String(entry.state));
              // A read without named targets reads the turn's scope: the
              // ledger names the papers it returned.
              if (
                reader?.name === "paper_read" &&
                !reader.paperIds?.includes(itemId)
              )
                reader.paperIds = [...(reader.paperIds || []), itemId];
            }
          }
          if (
            event?.type === "execution_checkpoint" ||
            event?.type === "execution_checkpoint_delta"
          ) {
            checkpoints += 1;
            const folded = ledger.apply(event);
            if (event.type === "execution_checkpoint_delta" && !folded)
              foldRefusals += 1;
          }
          if (event?.type === "provider_event") {
            const payload =
              event.payload && typeof event.payload === "object"
                ? (event.payload as Record<string, unknown>)
                : {};
            if (event.providerType === "agent_run_stop") {
              runStatus = String(payload.status || "");
              stopRule = String(payload.rule || "");
            }
            if (event.providerType === "agent_long_job_page") {
              longJobEvents.push(payload);
              if (payload.complete) longJobComplete = true;
              else longJobPages += 1;
            }
          }
          if (event?.type === "confirmation_required" && event.requestId) {
            confirmations += 1;
            // Stop cancels a card still open, as the panel's Stop does.
            void agent.resolveConfirmation(
              event.requestId,
              !stopped() && params.approve !== false,
            );
          }
        },
        stopController ? { signal: stopController.signal } : undefined,
      );
    } catch (caught) {
      error = String((caught as Error)?.message || caught);
    } finally {
      settled = true;
      toolkit.getGlobal = original;
      await Promise.all(pending);
      await polling;
    }
    // runTurn answers kind "completed" even for a run it ended as failed; the
    // stored run status is the honest outcome.
    const storedStatus = result?.runId
      ? (
          (await Zotero.DB.queryAsync(
            "SELECT status FROM llm_for_zotero_agent_runs WHERE run_id = ?",
            [result.runId],
          )) as Array<{ status?: string }> | undefined
        )?.[0]?.status
      : undefined;
    const turn: TurnRecord & { result: any } = {
      scenario: params.scenario,
      label: params.label,
      userText: params.userText,
      outcome: storedStatus || result?.kind,
      // The last ledger the events proved, as Task progress shows it.
      endState: ledger.latest?.end?.state || "",
      steps: (ledger.latest?.tasks || []).map(
        (task: any) =>
          `${task.origin || "legacy"}:${task.effect || "-"}:${task.status}`,
      ),
      parts: (ledger.latest?.tasks || [])
        .filter((task: any) => task.origin === "model" && task.targets?.length)
        .map(partRecord),
      runStatus,
      stopRule,
      error,
      answer: String(result?.text || ""),
      documentId: result?.documentId,
      wallMs: Date.now() - start,
      requests,
      tools: order.map((key) => tools.get(key)!).filter(Boolean),
      confirmations,
      ledgerDeltas,
      ledgerPapers: ledgerPapers.size,
      ledgerStates: [...ledgerPapers.values()].reduce(
        (counts: Record<string, number>, state) => {
          counts[state] = (counts[state] || 0) + 1;
          return counts;
        },
        {},
      ),
      paperStates: Object.fromEntries(
        [...paperStates].map(([itemId, state]) => [String(itemId), state]),
      ),
      checkpoints,
      foldRefusals,
      longJobPages,
      longJobComplete,
      longJobEvents,
      ...(stop ? { stop } : {}),
      statuses: statuses.slice(0, 60),
      result,
    };
    return turn;
  }

  async function record(
    scenario: string,
    turns: Array<TurnRecord & { result?: any }>,
    checks: Record<string, unknown>,
    notes: string[] = [],
  ): Promise<void> {
    const turnSummaries = turns.map(summarizeTurn);
    summaries.push(
      ...turnSummaries.map((summary) => ({ ...summary, checks, notes })),
    );
    await write(`${variant}-${scenario}.json`, {
      variant,
      scenario,
      model: creds?.model,
      reasoning: creds?.reasoningLevel || null,
      checks,
      notes,
      turns: turns.map(({ result: _result, ...turn }) => ({
        ...turn,
        summary: summarizeTurn(turn),
      })),
    });
  }

  async function scenario(id: string, body: () => Promise<void>) {
    if (!wanted(id)) return;
    try {
      await body();
    } catch (caught) {
      const message = String((caught as Error)?.stack || caught);
      summaries.push({
        scenario: id,
        outcome: "harness-error",
        error: message,
      });
      await write(`${variant}-${id}.error.txt`, message);
    }
  }

  async function seedRealPaper(name: string): Promise<PaperFixture> {
    const meta = JSON.parse(
      String(await IOUtils.readUTF8(`${papersDir}/${name}.json`)),
    );
    const markdown = String(await IOUtils.readUTF8(`${papersDir}/${name}.md`));
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID();
    item.setField("title", meta.title);
    const year = String(meta.date || "").split(" ")[0];
    item.setField("date", year);
    item.setCreators(
      (meta.creators || []).map((creator: any) => ({
        creatorType: "author",
        firstName: creator.firstName || "",
        lastName: creator.lastName || "",
      })),
    );
    const itemId = Number(await item.saveTx());
    created.items.push(itemId);
    const attachment = await Zotero.Attachments.importFromFile({
      file: `${papersDir}/${name}.pdf`,
      parentItemID: itemId,
      contentType: "application/pdf",
    });
    await writeMineruCacheFiles(attachment.id, markdown, [
      { relativePath: "full.md", data: new TextEncoder().encode(markdown) },
    ]);
    await writeMineruSourceProvenanceForAttachment(attachment);
    const firstCreator = String(meta.creators?.[0]?.lastName || "");
    return {
      name,
      itemId,
      attachmentId: attachment.id,
      title: meta.title,
      firstCreator,
      year: year.slice(0, 4),
      markdown,
      ref: {
        libraryID: libraryID(),
        itemId,
        contextItemId: attachment.id,
        title: meta.title,
        firstCreator,
        year: year.slice(0, 4),
      },
    };
  }

  async function newCollection(name: string, parentId?: number) {
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID();
    collection.name = name;
    if (parentId) collection.parentID = parentId;
    await collection.saveTx();
    created.collections.push(collection.id);
    return collection;
  }

  async function seedItem(title: string, options: { tags?: string[] } = {}) {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID();
    item.setField("title", title);
    item.setField("date", "2021");
    item.setCreators([
      { creatorType: "author", firstName: "L.", lastName: "Fixture" },
    ]);
    for (const tag of options.tags || []) item.addTag(tag);
    const id = Number(await item.saveTx());
    created.items.push(id);
    return Zotero.Items.get(id);
  }

  async function addToCollection(collection: any, items: any[]) {
    // addItems does not open its own transaction: it requires one.
    await Zotero.DB.executeTransaction(async () => {
      await collection.addItems(items.map((item: any) => item.id));
    });
  }

  function childNotesCreatedAfter(itemId: number, since: number): any[] {
    const parent = Zotero.Items.get(itemId);
    return (parent?.getNotes?.() || [])
      .map((id: number) => Zotero.Items.get(id))
      .filter(
        (note: any) =>
          note && Date.parse(`${note.dateAdded.replace(" ", "T")}Z`) >= since,
      );
  }

  function noteText(note: any): string {
    return String(note?.getNote?.() || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Concept groups that only the body of the Ratzon et al. paper supports. */
  const RATZON_BODY_CONCEPTS: Record<string, RegExp> = {
    phasesOfLearning:
      /\bthree (?:overlapping )?phases|phases? of learning|second (?:slower )?phase|fast initial phase/i,
    lowLossManifold:
      /(?:low|zero)[- ]loss manifold|manifold of (?:solutions|minima)/i,
    hessianFlatness: /hessian|flat(?:ter|ness)?\b|curvature/i,
    noiseMechanism:
      /label noise|stochastic|sgd|noisy (?:learning|updates)|noise[- ]driven/i,
    generality:
      /generali[sz]|robust (?:to|across)|different (?:architectures|tasks|networks)|across (?:architectures|tasks)/i,
    experimentalLink:
      /experiment(?:al)? data|deitch|mice|mouse|ca1|active (?:cells|units) (?:decrease|decline)|fraction of active/i,
    predictiveCoding: /predictive coding/i,
  };

  function conceptCoverage(text: string, concepts: Record<string, RegExp>) {
    const hits = Object.entries(concepts)
      .filter(([, pattern]) => pattern.test(text))
      .map(([name]) => name);
    return { hits, score: `${hits.length}/${Object.keys(concepts).length}` };
  }

  let largeCorpus: Promise<LargeCorpus> | null = null;

  /**
   * The large fixture, seeded once for every scenario that uses it: the
   * synthetic corpus (seed 11), each paper an item with a PDF filed in one
   * folder, four in five with MinerU text.
   */
  function seedLargeCorpus(scenarioId: string): Promise<LargeCorpus> {
    largeCorpus ||= (async () => {
      const corpus = generateSyntheticCorpus({
        papers: corpusSize,
        seed: 11,
        pdfShare: 0.2,
      });
      const collection = await newCollection(`Corpus ${MARK}`);
      const seededAt = Date.now();
      const attachmentIds: number[] = [];
      const itemIds = new Map<number, number>();
      const paperOf = new Map<number, SyntheticPaper>();
      for (const paper of corpus.papers) {
        const fixture = await api.createPaperWithPdfFixture({
          title: paper.title,
          pdfTitle: `${paper.title}.pdf`,
          pages: paper.pages,
        });
        created.items.push(fixture.parentItemId);
        attachmentIds.push(fixture.pdfAttachmentId);
        itemIds.set(paper.id, fixture.parentItemId);
        paperOf.set(fixture.parentItemId, paper);
        const item = Zotero.Items.get(fixture.parentItemId);
        item.setField("date", paper.year);
        item.setCreators(
          paper.authors.slice(0, 2).map((author) => ({
            creatorType: "author",
            firstName: "",
            lastName: author,
          })),
        );
        item.setCollections([collection.id]);
        await item.saveTx();
        if (paper.mode === "mineru") {
          const encoder = new TextEncoder();
          await writeMineruCacheFiles(fixture.pdfAttachmentId, paper.markdown, [
            { relativePath: "full.md", data: encoder.encode(paper.markdown) },
            {
              relativePath: "content_list.json",
              data: encoder.encode(JSON.stringify(paper.contentList)),
            },
          ]);
          await writeMineruSourceProvenanceForAttachment(
            Zotero.Items.get(fixture.pdfAttachmentId),
          );
        }
      }
      const seedSeconds = Math.round((Date.now() - seededAt) / 1000);
      let indexCoverage: unknown = "unavailable";
      try {
        const idle = await api.waitForLibraryTextIndexIdle?.(240_000);
        const coverage = await api.libraryTextIndexCoverage(attachmentIds);
        indexCoverage = {
          idle,
          indexed: coverage.indexed.length,
          missing: coverage.missing.length,
          failed: coverage.failed.length,
        };
      } catch (caught) {
        indexCoverage = `error: ${String(caught)}`;
      }
      return {
        corpus,
        collection,
        itemIds,
        paperOf,
        attachmentIds,
        seedSeconds,
        indexCoverage,
        seededFor: scenarioId,
      };
    })();
    return largeCorpus;
  }

  /**
   * The corpus papers an answer names: by the "study N" that ends every
   * title (the only part that tells one topic's papers apart), or by the
   * paper a quote citation points to.
   */
  function corpusPapersCited(
    turn: TurnRecord & { result?: any },
    large: LargeCorpus,
  ) {
    const size = large.corpus.papers.length;
    const byText = new Set<number>();
    for (const match of turn.answer.matchAll(/\bstudy\s+(\d{1,4})\b/gi)) {
      const id = Number(match[1]);
      if (id >= 1 && id <= size) byText.add(id);
    }
    const byQuote = new Set<number>();
    for (const citation of turn.result?.quoteCitations || []) {
      const itemId =
        Number(citation?.itemId) ||
        Number(Zotero.Items.get(Number(citation?.contextItemId))?.parentID) ||
        0;
      const paper = large.paperOf.get(itemId);
      if (paper) byQuote.add(paper.id);
    }
    return { byText, byQuote, all: new Set([...byText, ...byQuote]) };
  }

  /**
   * A library chat opened as the panel opens one, so its conversation key
   * has a key ledger entry: for a key without one the runtime stores no run
   * row, and "continue" finds no run to resume. Throws rather than run a
   * resume check that could not pass.
   */
  async function registeredLibraryConversation(
    itemId: number,
  ): Promise<number> {
    const panel = await api.renderPanelForItem(itemId);
    const library = await api.togglePanelConversationMode(panel.panelId);
    if (library.conversationKind !== "global")
      throw new Error(
        `The panel stayed in ${library.conversationKind || "unknown"} chat`,
      );
    const fresh = await api.startNewPanelConversation(panel.panelId, {
      allowReusedDraft: true,
    });
    const key = Number(fresh.conversationKey || 0);
    const entry = key ? await getConversationKeyLedgerEntry(key) : null;
    if (fresh.conversationKind !== "global" || !entry || entry.retiredAt)
      throw new Error(
        `Library conversation ${key} has no live key ledger entry`,
      );
    return key;
  }

  /**
   * Reads a task that works from metadata should not make: paper_read in
   * full or overview mode never, targeted only on a paper without an
   * abstract. Run it before a scenario restores abstracts it set.
   */
  function metadataOnlyReads(tools: ToolRecord[]) {
    const reads = tools.filter((tool) => tool.name === "paper_read");
    const deep = reads.filter(
      (tool) => tool.readMode === "full" || tool.readMode === "overview",
    );
    const targeted = reads.filter((tool) => tool.readMode === "targeted");
    const targetedPapers = [
      ...new Set(targeted.flatMap((tool) => tool.paperIds || [])),
    ];
    const withAbstract = targetedPapers.filter((itemId) =>
      String(Zotero.Items.get(itemId)?.getField?.("abstractNote") || "").trim(),
    );
    return {
      noFullOrOverviewReads: deep.length === 0,
      fullOrOverviewReads: deep.length,
      targetedReads: targeted.length,
      targetedReadPapers: targetedPapers.length,
      targetedOnPapersWithAbstract: withAbstract.length,
      targetedOnlyWithoutAbstract: withAbstract.length === 0,
      otherPaperReads: reads.length - deep.length - targeted.length,
      ...readDepth(tools),
    };
  }

  /**
   * Follows a reorganization: what the chat showed before the first write
   * and the first move, the move and tag batches, the review cards, and the
   * declared part as Task progress counts it ("n of N"), from the run's
   * whole ledger and the deltas after it. A card is answered as the panel
   * submits it untouched, every row as shown; a question, with `answer`.
   */
  function reorganizeTracker(answer: string) {
    const agent = Zotero.LLMForZotero.api.agent;
    const state = {
      sequence: 0,
      firstWriteAt: Infinity,
      firstMoveAt: Infinity,
      shown: [] as Array<{ at: number; text: string }>,
      moveBatches: [] as number[],
      tagBatches: [] as number[],
      cards: [] as Array<{ title: string; rows: number; type: string }>,
      questions: [] as string[],
      loadedSkill: false,
      paperReads: 0,
      writePart: undefined as Record<string, unknown> | undefined,
    };
    const ledger = new ExecutionCheckpointFold();
    const batchSize = (args: any): number =>
      Array.isArray(args.assignments)
        ? args.assignments.length
        : Array.isArray(args.itemIds)
          ? args.itemIds.length
          : 0;
    const onEvent = (event: any) => {
      state.sequence += 1;
      if (
        event?.type === "execution_checkpoint" ||
        event?.type === "execution_checkpoint_delta"
      ) {
        const part = (ledger.apply(event)?.tasks || []).find(
          (task: any) =>
            task.origin === "model" &&
            task.effect === "mutation" &&
            task.targets?.length,
        );
        if (part)
          state.writePart = {
            description: part.description,
            capability: part.capability,
            scope: Boolean(part.scope),
            status: part.status,
            targets: part.targets?.length || 0,
            done: part.doneTargets?.length || 0,
            excepted: (part.exceptions || []).reduce(
              (total: number, entry: any) => total + entry.targets.length,
              0,
            ),
          };
      }
      if (event?.type === "message_delta" && event.text)
        state.shown.push({ at: state.sequence, text: String(event.text) });
      if (event?.type === "tool_call") {
        const args = event.arguments ?? event.args ?? {};
        if (event.name === "load_skill" && args.id === "reorganize-library")
          state.loadedSkill = true;
        if (event.name === "paper_read") state.paperReads += 1;
        if (event.name === "library_update") {
          state.firstWriteAt = Math.min(state.firstWriteAt, state.sequence);
          if (args.kind === "collections") {
            state.firstMoveAt = Math.min(state.firstMoveAt, state.sequence);
            state.moveBatches.push(batchSize(args));
          }
          if (args.kind === "tags") state.tagBatches.push(batchSize(args));
        }
      }
      if (event?.type !== "confirmation_required") return;
      const fields: any[] = event.action?.fields || [];
      const table = fields.find(
        (field: any) =>
          field?.type === "assignment_table" ||
          field?.type === "tag_assignment_table",
      );
      state.cards.push({
        title: String(event.action?.title || ""),
        rows: table?.rows?.length || 0,
        type: String(table?.type || event.action?.interaction || ""),
      });
      if (table) {
        agent.resolveConfirmation(event.requestId, {
          approved: true,
          data: {
            [table.id]: table.rows.map((row: any) =>
              table.type === "tag_assignment_table"
                ? { id: row.id, value: tagList(row.value) }
                : { id: row.id, value: row.value, checked: true },
            ),
          },
        });
        return;
      }
      if (event.action?.interaction === "user_input") {
        const data: Record<string, unknown> = {};
        for (const field of fields) {
          state.questions.push(String(field?.label || ""));
          data[field.id] =
            field.type === "choice" ? { kind: "custom", text: answer } : answer;
        }
        agent.resolveConfirmation(event.requestId, {
          approved: true,
          actionId: "continue",
          data,
        });
      }
    };
    return { state, onEvent };
  }

  /** What the chat showed before a point in a tracker's event sequence. */
  function shownBefore(
    state: ReturnType<typeof reorganizeTracker>["state"],
    turns: Array<TurnRecord & { result?: any }>,
    at: number,
  ): string {
    return [
      ...(turns.length > 1 ? [turns[0].answer] : []),
      ...state.shown.filter((entry) => entry.at < at).map((e) => e.text),
    ].join("");
  }

  before(async function () {
    if (!reportDir) this.skip();
    api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
    creds = await resolveLiveAgentCredentials();
    if (!creds) this.skip();
    if (indexSetting === "off")
      Zotero.Prefs.set(
        "extensions.zotero.llmforzotero.libraryTextIndexEnabled",
        false,
        true,
      );
    if (papersDir) {
      for (const name of ["ratzon2024", "rule2020", "devalle2022"]) {
        try {
          papers.push(await seedRealPaper(name));
        } catch (caught) {
          await write(
            `${variant}-setup-${name}.error.txt`,
            String((caught as Error)?.stack || caught),
          );
        }
      }
    }
    await write(`${variant}-setup.json`, {
      variant,
      mark: MARK,
      model: creds?.model,
      reasoning: creds?.reasoningLevel || null,
      papers: papers.map(({ markdown: _m, ...paper }) => paper),
      corpusSize,
      index: indexSetting || "default",
      startedAt: new Date().toISOString(),
    });
  });

  after(async function () {
    if (!reportDir) return;
    const columns: Array<[string, (s: any) => unknown]> = [
      ["scenario", (s) => s.scenario],
      ["turn", (s) => s.label],
      ["outcome", (s) => s.outcome],
      ["run status", (s) => s.runStatus],
      ["wall s", (s) => s.wallSeconds],
      ["agent req", (s) => s.agentRequests],
      ["utility req", (s) => s.utilityRequests],
      ["input tok", (s) => s.inputTokens],
      ["cached", (s) => s.cachedInputTokens],
      ["uncached", (s) => s.uncachedInputTokens],
      ["output tok", (s) => s.outputTokens],
      ["pages", (s) => s.longJobPages],
      ["fold refusals", (s) => s.foldRefusals],
      ["tools", (s) => s.toolCalls],
      ["tool errors", (s) => s.toolErrors?.length || 0],
      ["rejects", (s) => s.inputRejections],
      ["confirms", (s) => s.confirmations],
      ["ledger papers", (s) => s.ledgerPapers],
      ["declared", (s) => s.declaredTasks],
      ["docs", (s) => s.documents],
      ["end", (s) => s.endState],
      ["steps", (s) => (s.steps || []).join(", ")],
    ];
    // A scenario that failed in the harness or was skipped has no turn row.
    const rows = summaries.map((s: any) =>
      s.label === undefined
        ? `| ${s.scenario} | — | ${s.outcome} |${" |".repeat(columns.length - 3)}`
        : `| ${columns.map(([, value]) => String(value(s) ?? "")).join(" | ")} |`,
    );
    await write(
      `${variant}-summary.md`,
      [
        `# Adaptive loop live run: ${variant}`,
        "",
        `Model ${creds?.model} · reasoning ${creds?.reasoningLevel || "default"} · finished ${new Date().toISOString()}`,
        "",
        `| ${columns.map(([name]) => name).join(" | ")} |`,
        `|${"---|".repeat(columns.length)}`,
        ...rows,
        "",
      ].join("\n"),
    );
    await write(`${variant}-summary.json`, summaries);
  });

  it("paper chat: summarize and save as a note (mixture)", async function () {
    await scenario("paper.summary_note", async () => {
      const paper = papers.find((entry) => entry.name === "ratzon2024");
      assert.isOk(paper, "the Ratzon paper fixture is required");
      const since = Date.now() - 1000;
      const turn = await runTurn({
        scenario: "paper.summary_note",
        label: "summary+note",
        conversationKey: 910_000 + Math.floor(Math.random() * 10_000),
        userText:
          "Summarize this paper for me and save the summary as a note on it.",
        scope: paperChat(paper!),
      });
      const notes = childNotesCreatedAfter(paper!.itemId, since);
      const saved = notes.map(noteText).join("\n\n");
      const coverage = conceptCoverage(
        saved || turn.answer,
        RATZON_BODY_CONCEPTS,
      );
      await record("paper.summary_note", [turn], {
        completed: turn.outcome === "completed",
        noteSaved: notes.length > 0,
        notesCreated: notes.length,
        noteChars: saved.length,
        bodyConceptCoverage: coverage,
        answerCoverage: conceptCoverage(turn.answer, RATZON_BODY_CONCEPTS),
        submittedDocument: turn.tools.some((t) => t.name === "submit_document"),
        noteText: saved.slice(0, 6000),
        answer: turn.answer.slice(0, 6000),
      });
    });
  });

  it("paper chat: easy question", async function () {
    await scenario("paper.qa_easy", async () => {
      const paper = papers.find((entry) => entry.name === "ratzon2024")!;
      const turn = await runTurn({
        scenario: "paper.qa_easy",
        label: "easy",
        conversationKey: 920_000 + Math.floor(Math.random() * 10_000),
        userText: "What task did the authors train their network on?",
        scope: paperChat(paper),
      });
      await record("paper.qa_easy", [turn], {
        completed: turn.outcome === "completed",
        mentionsNavigation:
          /navigat|spatial|predictive coding|arena|position/i.test(turn.answer),
        answer: turn.answer.slice(0, 3000),
      });
    });
  });

  it("paper chat: hard question", async function () {
    await scenario("paper.qa_hard", async () => {
      const paper = papers.find((entry) => entry.name === "ratzon2024")!;
      const turn = await runTurn({
        scenario: "paper.qa_hard",
        label: "hard",
        conversationKey: 930_000 + Math.floor(Math.random() * 10_000),
        userText:
          "Which of this paper's claims is least supported by its own evidence? Weigh the simulations against the experimental data they compare with, say what evidence would change your view, and cite the passages you rely on.",
        scope: paperChat(paper),
      });
      await record("paper.qa_hard", [turn], {
        completed: turn.outcome === "completed",
        citesPassages:
          /\[\[cite:|\[\[quote:/.test(turn.answer) ||
          (turn.result?.quoteCitations?.length || 0) > 0,
        quoteCitations: turn.result?.quoteCitations?.length || 0,
        bodyConceptCoverage: conceptCoverage(turn.answer, RATZON_BODY_CONCEPTS),
        answer: turn.answer.slice(0, 6000),
      });
    });
  });

  it("paper chat: annotation (quick action)", async function () {
    await scenario("paper.annotation", async () => {
      const paper = papers.find((entry) => entry.name === "ratzon2024")!;
      const attachment = Zotero.Items.get(paper.attachmentId);
      const before = attachment.getAnnotations().length;
      const turn = await runTurn({
        scenario: "paper.annotation",
        label: "annotate",
        conversationKey: 940_000 + Math.floor(Math.random() * 10_000),
        userText:
          "Highlight the sentence where the authors state their main conclusion and add a short comment explaining it.",
        scope: paperChat(paper),
      });
      const annotations = attachment.getAnnotations();
      const added = annotations.slice(before);
      await record("paper.annotation", [turn], {
        completed: turn.outcome === "completed",
        annotationsAdded: annotations.length - before,
        annotations: added.map((annotation: any) => ({
          text: String(annotation.annotationText || "").slice(0, 400),
          comment: String(annotation.annotationComment || "").slice(0, 400),
          type: annotation.annotationType,
        })),
        answer: turn.answer.slice(0, 2000),
      });
    });
  });

  it("paper chat: answer and tag in one request (mixture)", async function () {
    await scenario("paper.answer_and_tag", async () => {
      const paper = papers.find((entry) => entry.name === "ratzon2024")!;
      const item = Zotero.Items.get(paper.itemId);
      const tag = "drift-reviewed";
      const turn = await runTurn({
        scenario: "paper.answer_and_tag",
        label: "answer+tag",
        conversationKey: 945_000 + Math.floor(Math.random() * 10_000),
        userText: `In one sentence, what is this paper's main claim? Then add the tag "${tag}" to it.`,
        scope: paperChat(paper),
      });
      const tagged = item
        .getTags()
        .some((entry: { tag: string }) => entry.tag === tag);
      await record("paper.answer_and_tag", [turn], {
        completed: turn.outcome === "completed",
        tagged,
        answered: turn.answer.trim().length > 40,
        answer: turn.answer.slice(0, 1200),
      });
    });
  });

  it("paper chat: compare three papers", async function () {
    await scenario("paper.multi_compare", async () => {
      assert.isAtLeast(papers.length, 3, "three real paper fixtures");
      const [first, ...rest] = papers;
      const turn = await runTurn({
        scenario: "paper.multi_compare",
        label: "compare3",
        conversationKey: 950_000 + Math.floor(Math.random() * 10_000),
        userText:
          "Compare how these three papers explain representational drift: one short paragraph per paper, then a table of mechanism, evidence type and main limitation.",
        scope: paperChat(first, rest),
      });
      const mentioned = papers.filter((paper) =>
        new RegExp(paper.firstCreator, "i").test(turn.answer),
      );
      await record("paper.multi_compare", [turn], {
        completed: turn.outcome === "completed",
        papersMentioned: mentioned.map((paper) => paper.firstCreator),
        hasTable: /\n\|.+\|\n\|[- :|]+\|/.test(turn.answer),
        answer: turn.answer.slice(0, 6000),
      });
    });
  });

  it("library chat: a series of library actions in one request", async function () {
    await scenario("library.action_series", async () => {
      const drift = await newCollection(`Drift ${MARK}`);
      const driftOld = await newCollection(`Drift old ${MARK}`);
      const inbox = await newCollection(`Inbox ${MARK}`);
      const a = await seedItem(`Place fields remap slowly ${MARK}`, {
        tags: [`place-cell ${MARK}`],
      });
      const b = await seedItem(`Grid cells and drift ${MARK}`, {
        tags: [`placecell ${MARK}`],
      });
      const c = await seedItem(`Drift in CA1 over weeks ${MARK}`, {
        tags: [`place cells ${MARK}`],
      });
      const d = await seedItem(`Old drift model ${MARK}`);
      const x = await seedItem(`Replay and consolidation ${MARK}`);
      await addToCollection(drift, [a, c]);
      await addToCollection(driftOld, [b, d]);
      await addToCollection(inbox, [x]);
      const readName = `To read ${MARK}`;
      const turn = await runTurn({
        scenario: "library.action_series",
        label: "series",
        conversationKey: 960_000 + Math.floor(Math.random() * 10_000),
        userText: [
          "Please tidy my library:",
          `1. Merge the tags "place-cell ${MARK}" and "placecell ${MARK}" into "place cells ${MARK}".`,
          `2. Merge the folder "Drift old ${MARK}" into "Drift ${MARK}".`,
          `3. Create a folder named "${readName}".`,
          `4. Move "Replay and consolidation ${MARK}" from "Inbox ${MARK}" to "${readName}".`,
          `5. Then tag every paper in "Drift ${MARK}" with "reviewed ${MARK}".`,
        ].join("\n"),
        scope: libraryChat(),
      });
      const tagsOf = (item: any) =>
        (Zotero.Items.get(item.id)?.getTags?.() || []).map((t: any) => t.tag);
      const inCollection = (collection: any, item: any) =>
        Zotero.Items.get(item.id)?.getCollections?.().includes(collection.id);
      const readFolder = Zotero.Collections.getByLibrary(libraryID()).find(
        (collection: any) => collection.name === readName,
      );
      if (readFolder) created.collections.push(readFolder.id);
      const oldStill = Zotero.Collections.get(driftOld.id);
      const driftMembers = [a, b, c, d].filter((item) =>
        inCollection(drift, item),
      );
      const checks = {
        completed: turn.outcome === "completed",
        tagsMerged:
          [a, b, c].every((item) =>
            tagsOf(item).includes(`place cells ${MARK}`),
          ) &&
          ![a, b, c].some((item) =>
            tagsOf(item).some((tag: string) =>
              [`place-cell ${MARK}`, `placecell ${MARK}`].includes(tag),
            ),
          ),
        folderMerged:
          [b, d].every((item) => inCollection(drift, item)) &&
          (!oldStill || oldStill.deleted || !oldStill.hasChildItems?.()),
        oldFolderRemoved: !oldStill || Boolean(oldStill.deleted),
        folderCreated: Boolean(readFolder),
        itemMoved:
          Boolean(readFolder) &&
          inCollection(readFolder, x) &&
          !inCollection(inbox, x),
        taggedAfterMerge:
          driftMembers.length === 4 &&
          driftMembers.every((item) =>
            tagsOf(item).includes(`reviewed ${MARK}`),
          ),
        driftMembers: driftMembers.length,
        answer: turn.answer.slice(0, 3000),
      };
      await record("library.action_series", [turn], checks);
    });
  });

  it("library chat: single quick actions", async function () {
    await scenario("library.quick_actions", async () => {
      const item = await seedItem(`Theta sequences in navigation ${MARK}`);
      const folder = `Quick ${MARK}`;
      const key = 970_000 + Math.floor(Math.random() * 10_000);
      const turns = [];
      turns.push(
        await runTurn({
          scenario: "library.quick_actions",
          label: "create-folder",
          conversationKey: key,
          userText: `Create a folder named "${folder}".`,
          scope: libraryChat(),
        }),
      );
      turns.push(
        await runTurn({
          scenario: "library.quick_actions",
          label: "add-to-folder",
          conversationKey: key,
          userText: `Add "Theta sequences in navigation ${MARK}" to the folder "${folder}".`,
          scope: libraryChat(),
        }),
      );
      turns.push(
        await runTurn({
          scenario: "library.quick_actions",
          label: "tag",
          conversationKey: key,
          userText: `Tag "Theta sequences in navigation ${MARK}" with "quick ${MARK}".`,
          scope: libraryChat(),
        }),
      );
      const quick = Zotero.Collections.getByLibrary(libraryID()).find(
        (collection: any) => collection.name === folder,
      );
      if (quick) created.collections.push(quick.id);
      const fresh = Zotero.Items.get(item.id);
      await record("library.quick_actions", turns, {
        folderCreated: Boolean(quick),
        added: Boolean(quick) && fresh.getCollections().includes(quick.id),
        tagged: fresh.getTags().some((tag: any) => tag.tag === `quick ${MARK}`),
      });
    });
  });

  it("library chat: find, summarize and save (mixture)", async function () {
    await scenario("library.find_summarize_save", async () => {
      const paper = papers.find((entry) => entry.name === "devalle2022");
      assert.isOk(paper, "the Devalle paper fixture is required");
      const since = Date.now() - 1000;
      const turn = await runTurn({
        scenario: "library.find_summarize_save",
        label: "find+summary+note",
        conversationKey: 980_000 + Math.floor(Math.random() * 10_000),
        userText:
          "Find the paper in my library about network mechanisms of representational drift in CA1, summarize its main finding in a short paragraph, and save that summary as a note on the paper.",
        scope: libraryChat(),
      });
      const notes = childNotesCreatedAfter(paper!.itemId, since);
      await record("library.find_summarize_save", [turn], {
        completed: turn.outcome === "completed",
        noteSaved: notes.length > 0,
        noteOnRightPaper: notes.length > 0,
        noteText: notes.map(noteText).join("\n\n").slice(0, 4000),
        answer: turn.answer.slice(0, 3000),
      });
    });
  });

  it("library chat: large collection, task progress and coverage", async function () {
    await scenario("library.large_collection", async () => {
      const large = await seedLargeCorpus("library.large_collection");
      const { corpus, collection } = large;
      const needle = corpus.papers[Math.floor(corpus.papers.length / 3)];
      const fact = needle.facts[0];
      const topic = "place cell stability";
      const topical = corpus.papers.filter((paper) =>
        paper.title.toLowerCase().includes(topic),
      );
      // The fixture's relevant papers are those whose title names the
      // topic; in these it is the studied factor, in the rest the condition.
      const primary = topical.filter((paper) =>
        paper.title.toLowerCase().startsWith(topic),
      );
      const key = 990_000 + Math.floor(Math.random() * 10_000);
      const needleTurn = await runTurn({
        scenario: "library.large_collection",
        label: "needle",
        conversationKey: key,
        userText: `In this collection, which paper reports that ${fact.paraphrase}? Name the paper and quote the finding.`,
        scope: libraryChat([collection]),
      });
      const broadTurn = await runTurn({
        scenario: "library.large_collection",
        label: "broad",
        conversationKey: key + 1,
        userText: `Which papers in this collection study ${topic}, and what does each of them find? List every one you can find.`,
        scope: libraryChat([collection]),
      });
      const coveredTopical = topical.filter((paper) =>
        broadTurn.answer.includes(paper.title.slice(0, 40)),
      );
      const cited = corpusPapersCited(broadTurn, large);
      const citedRelevant = topical.filter((paper) => cited.all.has(paper.id));
      const inScope = new Set(large.itemIds.values());
      const papersRead = Object.entries(broadTurn.paperStates).filter(
        ([itemId, state]) =>
          inScope.has(Number(itemId)) &&
          ["skimmed", "read", "cited"].includes(state),
      ).length;
      const paperReadPapers = new Set(
        broadTurn.tools
          .filter((tool) => tool.name === "paper_read" && tool.ok)
          .flatMap((tool) => tool.paperIds || [])
          .filter((itemId) => inScope.has(itemId)),
      ).size;
      const broadSummary = summarizeTurn(broadTurn);
      await record(
        "library.large_collection",
        [needleTurn, broadTurn],
        {
          corpusSize,
          seedSeconds: large.seedSeconds,
          seededFor: large.seededFor,
          indexCoverage: large.indexCoverage,
          needle: {
            expectedTitle: needle.title,
            found: needleTurn.answer.includes(needle.title.slice(0, 40)),
            sentence: fact.sentence,
          },
          broad: {
            topic,
            relevant: topical.length,
            relevantPrimary: primary.length,
            cited: cited.all.size,
            citedByStudyNumber: cited.byText.size,
            citedByQuote: cited.byQuote.size,
            citedRelevant: citedRelevant.length,
            recall: ratio(citedRelevant.length, topical.length),
            recallPrimary: ratio(
              primary.filter((paper) => cited.all.has(paper.id)).length,
              primary.length,
            ),
            precision: ratio(citedRelevant.length, cited.all.size),
            missedStudies: topical
              .filter((paper) => !cited.all.has(paper.id))
              .map((paper) => paper.id),
            prefixMentioned: coveredTopical.length,
            prefixRecall: ratio(coveredTopical.length, topical.length),
            paged: broadTurn.longJobPages > 0,
            pages: broadTurn.longJobPages,
            jobComplete: broadTurn.longJobComplete,
            coverage: {
              scopePapers: corpus.papers.length,
              papersRead,
              share: ratio(papersRead, corpus.papers.length),
              paperReadPapers,
              readPart:
                broadTurn.parts.find((part) => part.effect === "read") || null,
            },
            agentRequests: broadSummary.agentRequests,
            utilityRequests: broadSummary.utilityRequests,
            inputTokens: broadSummary.inputTokens,
            uncachedInputTokens: broadSummary.uncachedInputTokens,
            cachedInputTokens: broadSummary.cachedInputTokens,
            outputTokens: broadSummary.outputTokens,
            wallSeconds: broadSummary.wallSeconds,
            foldRefusals: broadTurn.foldRefusals,
            readDepth: broadSummary.readDepth,
          },
          needleAnswer: needleTurn.answer.slice(0, 3000),
          broadAnswer: broadTurn.answer.slice(0, 6000),
        },
        [
          `broad.recall: a relevant paper counts as cited when the answer names its "study N" (every title ends with one) or a quote citation points to it; the relevant papers are the ${topical.length} whose title names the topic, ${primary.length} of them as the studied factor (recallPrimary).`,
          "broad.prefixRecall is the earlier measure, a title's first 40 characters in the answer: the relevant titles share two such prefixes, so it cannot tell their papers apart.",
          "broad.coverage.papersRead counts scope papers that reached skimmed, read or cited in the turn's paper ledger; paperReadPapers counts those a successful paper_read named.",
        ],
      );
    });
  });

  it("library chat: a reading note for each paper of a folder, stopped and continued", async function () {
    this.timeout(3 * 3_600_000);
    const id = "library.per_paper_notes_stop_continue";
    await scenario(id, async () => {
      const large = await seedLargeCorpus(id);
      const paperIds = large.corpus.papers
        .slice(0, NOTE_JOB_PAPERS)
        .map((paper) => large.itemIds.get(paper.id)!);
      const folder = await newCollection(`Reading notes ${MARK}`);
      await addToCollection(
        folder,
        paperIds.map((itemId) => Zotero.Items.get(itemId)),
      );
      const notesOf = () =>
        new Map<number, Set<number>>(
          paperIds.map((itemId) => [
            itemId,
            new Set<number>(Zotero.Items.get(itemId)?.getNotes?.() || []),
          ]),
        );
      const before = notesOf();
      const newNotes = (
        after: Map<number, Set<number>>,
        base: Map<number, Set<number>>,
      ) =>
        paperIds.map(
          (itemId) =>
            [...(after.get(itemId) || [])].filter(
              (noteId) => !base.get(itemId)?.has(noteId),
            ).length,
        );
      // Each paper's first read and first note, in one event sequence over
      // both turns, so a page read before Stop counts for a note after it.
      let sequence = 0;
      const firstRead = new Map<number, number>();
      const firstWrite = new Map<number, number>();
      const firstSeen = new Map<number, number>();
      const readCalls = new Map<string, number[]>();
      const mark = (at: Map<number, number>, itemId: number) => {
        if (itemId > 0 && !at.has(itemId)) at.set(itemId, sequence);
      };
      /** Papers with a new note now; notes each one's first sighting. */
      const notedNow = (): number => {
        let noted = 0;
        for (const itemId of paperIds) {
          const known = before.get(itemId)!;
          const ids: number[] = Zotero.Items.get(itemId)?.getNotes?.() || [];
          if (!ids.some((noteId) => !known.has(noteId))) continue;
          noted += 1;
          mark(firstSeen, itemId);
        }
        return noted;
      };
      const agent = Zotero.LLMForZotero.api.agent;
      const questions: string[] = [];
      // Set from Stop to the end of the stopped turn.
      let stopping = false;
      let notesAtStop: number | null = null;
      const onEvent = (event: any) => {
        sequence += 1;
        if (event?.type === "tool_call") {
          const args = event.arguments ?? event.args ?? {};
          if (event.name === "paper_read")
            readCalls.set(
              String(event.callId || event.id || ""),
              paperIdsOfArgs(args),
            );
          if (args.target !== "standalone") {
            if (event.name === "note_write")
              mark(firstWrite, Number(args.targetItemId) || 0);
            if (event.name === "note_write_batch")
              for (const note of Array.isArray(args.notes) ? args.notes : [])
                mark(firstWrite, Number(note?.targetItemId) || 0);
          }
        }
        if (
          event?.type === "tool_result" &&
          event.name === "paper_read" &&
          event.ok
        )
          for (const itemId of readCalls.get(String(event.callId || "")) || [])
            mark(firstRead, itemId);
        if (
          event?.type === "paper_ledger_update" &&
          event.delta?.toolName === "paper_read"
        )
          for (const paper of event.delta?.papers || [])
            mark(firstRead, Number(paper?.itemId) || 0);
        if (event?.type === "tool_result") notedNow();
        // A question before the job is answered as a user who wants it
        // done; after Stop, the run's own handler cancels it.
        if (
          event?.type === "confirmation_required" &&
          event.action?.interaction === "user_input" &&
          !stopping
        ) {
          const data: Record<string, unknown> = {};
          for (const field of event.action?.fields || []) {
            questions.push(String(field?.label || ""));
            data[field.id] =
              field.type === "choice"
                ? { kind: "custom", text: "Yes, go ahead." }
                : "Yes, go ahead.";
          }
          agent.resolveConfirmation(event.requestId, {
            approved: true,
            actionId: "continue",
            data,
          });
        }
      };
      const conversationKey = await registeredLibraryConversation(paperIds[0]);
      const since = Date.now() - 1000;
      const turns: Array<TurnRecord & { result?: any }> = [];
      turns.push(
        await runTurn({
          scenario: id,
          label: "notes",
          conversationKey,
          userText: "Write a short reading note for each paper in this folder.",
          scope: libraryChat([folder]),
          onEvent,
          stop: {
            when: () => {
              const noted = notedNow();
              if (noted < NOTE_JOB_STOP_AT) return false;
              stopping = true;
              notesAtStop = noted;
              return true;
            },
          },
        }),
      );
      stopping = false;
      notedNow();
      const afterStop = notesOf();
      turns.push(
        await runTurn({
          scenario: id,
          label: "continue",
          conversationKey,
          userText: "continue",
          scope: libraryChat([folder]),
          onEvent,
        }),
      );
      notedNow();
      const afterContinue = notesOf();
      const total = newNotes(afterContinue, before);
      const inStopped = newNotes(afterStop, before);
      const inContinue = newNotes(afterContinue, afterStop);
      const sum = (counts: number[]) =>
        counts.reduce((all, count) => all + count, 0);
      const stoppedNotes = sum(inStopped);
      const continueNotes = sum(inContinue);
      const stopTriggered = turns[0].stop?.requestedAtMs !== undefined;
      const noted = paperIds.filter((_, index) => total[index] > 0);
      const readFirst = noted.filter((itemId) => {
        const read = firstRead.get(itemId);
        const written = firstWrite.get(itemId) ?? firstSeen.get(itemId);
        return read !== undefined && written !== undefined && read < written;
      });
      const fixtureIds = new Set(paperIds);
      const notesElsewhere = (await Zotero.Items.getAll(libraryID())).filter(
        (item: any) =>
          item.isNote?.() &&
          !item.deleted &&
          addedSince(item, since) &&
          !fixtureIds.has(Number(item.parentID || 0)),
      ).length;
      const sample = paperIds
        .flatMap((itemId) =>
          [...(afterContinue.get(itemId) || [])].filter(
            (noteId) => !before.get(itemId)?.has(noteId),
          ),
        )
        .slice(0, 2)
        .map((noteId) => noteText(Zotero.Items.get(noteId)).slice(0, 800));
      await record(
        id,
        turns,
        {
          papers: paperIds.length,
          permissionMode: String(
            Zotero.Prefs.get(
              `${PREF_PREFIX}.originalAgentPermissionMode`,
              true,
            ) || "default",
          ),
          stopAt: NOTE_JOB_STOP_AT,
          stopTriggered,
          notesAtStop,
          stopEnding: !stopTriggered
            ? "not stopped"
            : turns[0].runStatus === "cancelled"
              ? "cancelled, as the panel's Stop ends a run"
              : `aborted at fetch: run ${turns[0].runStatus || "status unknown"}, ${turns[0].stopRule || "no stop rule"}, end ${turns[0].endState || "none"}`,
          everyPaperExactlyOneNewNote: total.every((count) => count === 1),
          noPaperTwoNotes: total.every((count) => count <= 1),
          papersWithoutNote: total.filter((count) => count === 0).length,
          papersWithSeveralNotes: total.filter((count) => count > 1).length,
          resumedNotRestarted:
            stopTriggered &&
            stoppedNotes > 0 &&
            continueNotes < paperIds.length,
          notedAgainInContinue: paperIds.filter(
            (_, index) => inStopped[index] > 0 && inContinue[index] > 0,
          ).length,
          ledgerCompleted: turns[1]?.endState === "completed",
          endStates: turns.map((turn) => turn.endState),
          readBeforeNote: noted.length > 0 && readFirst.length === noted.length,
          notedWithoutPriorRead: noted.filter(
            (itemId) => !readFirst.includes(itemId),
          ),
          notedNeverRead: noted.filter((itemId) => !firstRead.has(itemId))
            .length,
          notesElsewhere,
          questions,
          perTurn: turns.map((turn, index) => {
            const summary = summarizeTurn(turn);
            return {
              label: turn.label,
              agentRequests: summary.agentRequests,
              utilityRequests: summary.utilityRequests,
              inputTokens: summary.inputTokens,
              uncachedInputTokens: summary.uncachedInputTokens,
              wallSeconds: summary.wallSeconds,
              pages: turn.longJobPages,
              notesWritten: index === 0 ? stoppedNotes : continueNotes,
              runStatus: turn.runStatus || "",
              stopRule: turn.stopRule || "",
              endState: turn.endState || "",
              foldRefusals: turn.foldRefusals,
              readDepth: summary.readDepth,
            };
          }),
          noteSample: sample,
          answers: turns.map((turn) => turn.answer.slice(0, 2000)),
        },
        [
          `Stop: the public agent API takes no abort signal, so once ${NOTE_JOB_STOP_AT} papers have a note the harness aborts the plugin's model requests at fetch (the one in flight and every later one) and cancels open cards. The runtime then ends the run as failed by that error (end state interrupted), where the panel's Stop ends it as cancelled; stopEnding says which happened.`,
          "The conversation is a library chat the panel opened, so its runs are stored and continue can find the stopped one.",
          "readBeforeNote: a paper's first successful paper_read (named in the call, or in the host's paper ledger entry for it) comes before the first note_write or note_write_batch call naming the paper, or, without one, before its note is first seen.",
        ],
      );
    });
  });

  it("library chat: sort the large fixture's unfiled papers into topic folders", async function () {
    const id = "library.reorganize_unfiled_large";
    if (!heavy) {
      if (wanted(id))
        summaries.push({
          scenario: id,
          outcome: "skipped: set LLM_FOR_ZOTERO_LIVE_HEAVY=1",
        });
      this.skip();
    }
    this.timeout(3 * 3_600_000);
    await scenario(id, async () => {
      const large = await seedLargeCorpus(id);
      const paperIds = large.corpus.papers.map(
        (paper) => large.itemIds.get(paper.id)!,
      );
      const fixtureIds = new Set(paperIds);
      const topicOf = new Map(
        paperIds.map((itemId) => [
          itemId,
          primaryTopic(large.paperOf.get(itemId)!),
        ]),
      );
      const regular = (await Zotero.Items.getAll(libraryID())).filter(
        (item: any) => item.isRegularItem?.() && !item.deleted,
      );
      const otherUnfiled: number[] = regular
        .filter(
          (item: any) =>
            !fixtureIds.has(item.id) && !item.getCollections().length,
        )
        .map((item: any) => item.id);
      if (otherUnfiled.length > OTHER_UNFILED_LIMIT) {
        const reason = `${otherUnfiled.length} unfiled papers outside the fixture (limit ${OTHER_UNFILED_LIMIT})`;
        summaries.push({ scenario: id, outcome: `skipped: ${reason}` });
        await write(`${variant}-${id}.json`, {
          variant,
          scenario: id,
          skipped: reason,
        });
        return;
      }
      // Every paper's folders, and the fixture's abstracts, as they were, to
      // put back afterwards.
      const filing = new Map<number, number[]>(
        regular.map((item: any) => [item.id, [...item.getCollections()]]),
      );
      const abstracts = new Map<number, string>(
        paperIds.map((itemId) => [
          itemId,
          String(Zotero.Items.get(itemId)?.getField?.("abstractNote") || ""),
        ]),
      );
      const collectionsBefore = new Set<number>(
        Zotero.Collections.getByLibrary(libraryID(), true).map(
          (collection: any) => collection.id,
        ),
      );
      const modeKey = `${PREF_PREFIX}.originalAgentPermissionMode`;
      const priorMode = Zotero.Prefs.get(modeKey, true);
      const sort = reorganizeTracker(
        "Yes, go ahead with the proposed grouping.",
      );
      const turns: Array<TurnRecord & { result?: any }> = [];
      let checks: Record<string, unknown> = {};
      try {
        // An inbox: every fixture paper unfiled, each with its abstract, so
        // the papers can be sorted from their records.
        for (const itemId of paperIds) {
          const item = Zotero.Items.get(itemId);
          item.setCollections([]);
          item.setField("abstractNote", abstractOf(large.paperOf.get(itemId)!));
          await item.saveTx();
        }
        // Safe mode, so each batch of moves is one review card.
        Zotero.Prefs.set(modeKey, "safe", true);
        const conversationKey = 1_080_000 + Math.floor(Math.random() * 10_000);
        turns.push(
          await runTurn({
            scenario: id,
            label: "sort",
            conversationKey,
            userText: "Sort my unfiled papers into topic folders.",
            scope: libraryChat(),
            onEvent: sort.onEvent,
          }),
        );
        // A model that stopped after its proposal to ask is told to go on.
        if (!sort.state.moveBatches.length) {
          turns.push(
            await runTurn({
              scenario: id,
              label: "go-ahead",
              conversationKey,
              userText: "Yes, go ahead.",
              scope: libraryChat(),
              onEvent: sort.onEvent,
            }),
          );
        }
        const foldersOf = (itemId: number): number[] => [
          ...(Zotero.Items.get(itemId)?.getCollections?.() || []),
        ];
        // Papers the moves part excepted, with the reason the host recorded.
        const reportedNotMoved = new Set(
          turns.flatMap((turn) =>
            turn.parts
              .filter((part) => part.effect === "mutation")
              .flatMap((part) =>
                part.exceptions.flatMap((entry) => entry.itemIds),
              ),
          ),
        );
        const homes = paperIds.map((itemId) => foldersOf(itemId).length);
        const members = new Map<number, number[]>();
        for (const itemId of paperIds)
          for (const collectionId of foldersOf(itemId))
            members.set(collectionId, [
              ...(members.get(collectionId) || []),
              itemId,
            ]);
        const report = turns[turns.length - 1]?.answer || "";
        const folders = [...members].map(([collectionId, inFolder]) => {
          const collection = Zotero.Collections.get(collectionId);
          const counts = new Map<string, number>();
          for (const itemId of inFolder)
            counts.set(
              topicOf.get(itemId)!,
              (counts.get(topicOf.get(itemId)!) || 0) + 1,
            );
          const [dominant, dominantCount] = [...counts].sort(
            (left, right) => right[1] - left[1],
          )[0] || ["", 0];
          const name = String(collection?.name || collectionId);
          const parent = collection?.parentID
            ? Zotero.Collections.get(collection.parentID)
            : null;
          return {
            name,
            parent: parent ? String(parent.name) : null,
            isNew: !collectionsBefore.has(collectionId),
            papers: inFolder.length,
            reported: reportedCountIn(report, name),
            dominantTopic: dominant,
            purity: ratio(dominantCount, inFolder.length),
            topics: counts.size,
          };
        });
        const proposalNames = (text: string) =>
          folders.length > 0 &&
          folders.every((entry) =>
            text.toLowerCase().includes(entry.name.toLowerCase()),
          );
        const beforeFirstMove = shownBefore(
          sort.state,
          turns,
          sort.state.firstMoveAt,
        );
        const lost = paperIds.filter((itemId) => {
          const item = Zotero.Items.get(itemId);
          return !item || item.deleted;
        });
        const collectionsAfter = new Set<number>(
          Zotero.Collections.getByLibrary(libraryID(), true).map(
            (collection: any) => collection.id,
          ),
        );
        checks = {
          completed: turns.every((turn) => turn.outcome === "completed"),
          mode: "safe",
          papers: paperIds.length,
          abstractsSet: paperIds.length,
          otherUnfiledPapers: otherUnfiled.length,
          otherUnfiledMoved: otherUnfiled.filter(
            (itemId) => foldersOf(itemId).length > 0,
          ).length,
          proposalBeforeFirstMove:
            sort.state.moveBatches.length > 0 && proposalNames(beforeFirstMove),
          proposalBeforeFirstWrite: proposalNames(
            shownBefore(sort.state, turns, sort.state.firstWriteAt),
          ),
          proposalText: beforeFirstMove.slice(0, 4000),
          askedBeforeMoving:
            turns.length > 1 || sort.state.questions.length > 0,
          questions: sort.state.questions,
          everyPaperInOneFolderOrReported: paperIds.every(
            (itemId, index) =>
              homes[index] === 1 ||
              (homes[index] === 0 && reportedNotMoved.has(itemId)),
          ),
          papersInOneFolder: homes.filter((count) => count === 1).length,
          papersInNoFolder: homes.filter((count) => count === 0).length,
          papersInNoFolderReported: paperIds.filter(
            (itemId, index) =>
              homes[index] === 0 && reportedNotMoved.has(itemId),
          ).length,
          papersInSeveral: homes.filter((count) => count > 1).length,
          notMovedReasons: [
            ...new Set(
              turns.flatMap((turn) =>
                turn.parts.flatMap((part) =>
                  part.exceptions.map((entry) => entry.reason),
                ),
              ),
            ),
          ],
          noPaperLost: lost.length === 0,
          papersLost: lost.length,
          foldersRemoved: [...collectionsBefore].filter(
            (collectionId) => !collectionsAfter.has(collectionId),
          ).length,
          newFolders: folders.filter((entry) => entry.isNew).length,
          reusedFolders: folders
            .filter((entry) => !entry.isNew)
            .map((entry) => entry.name),
          reportCountsMatch:
            folders.length > 0 &&
            folders.every((entry) => entry.reported === entry.papers),
          folders,
          // Sorting reads records, not papers (before abstracts are reset).
          reads: metadataOnlyReads(turns.flatMap((turn) => turn.tools)),
          movesPart: sort.state.writePart || null,
          moveCalls: sort.state.moveBatches.length,
          batchSizes: sort.state.moveBatches,
          moveCards: sort.state.cards.filter(
            (card) => card.type === "assignment_table",
          ).length,
          cards: sort.state.cards.length,
          loadedSkill: sort.state.loadedSkill,
          pages: turns.map((turn) => turn.longJobPages),
          endStates: turns.map((turn) => turn.endState),
          steps: turns.map((turn) => turn.steps),
          answer: turns
            .map((turn) => turn.answer)
            .join("\n\n")
            .slice(0, 6000),
        };
      } finally {
        if (priorMode === undefined) Zotero.Prefs.clear(modeKey, true);
        else Zotero.Prefs.set(modeKey, priorMode, true);
        // Back as it was: folders the run trashed, every paper's folders,
        // the fixture without abstracts, and no folder the run made.
        try {
          for (const collectionId of collectionsBefore) {
            const collection = Zotero.Collections.get(collectionId);
            if (collection?.deleted) {
              collection.deleted = false;
              await collection.saveTx();
            }
          }
          for (const [itemId, collections] of filing) {
            const item = Zotero.Items.get(itemId);
            if (!item) continue;
            const keep = collections.filter((collectionId) =>
              Zotero.Collections.get(collectionId),
            );
            const order = (ids: number[]) =>
              [...ids].sort((left, right) => left - right).join(",");
            let changed = false;
            if (item.deleted) {
              item.deleted = false;
              changed = true;
            }
            if (order(item.getCollections()) !== order(keep)) {
              item.setCollections(keep);
              changed = true;
            }
            const abstract = abstracts.get(itemId);
            if (
              abstract !== undefined &&
              String(item.getField("abstractNote") || "") !== abstract
            ) {
              item.setField("abstractNote", abstract);
              changed = true;
            }
            if (changed) await item.saveTx();
          }
          for (const collection of Zotero.Collections.getByLibrary(
            libraryID(),
            true,
          )) {
            if (collectionsBefore.has(collection.id)) continue;
            const made = Zotero.Collections.get(collection.id);
            if (made) await made.eraseTx();
          }
        } catch (caught) {
          await write(
            `${variant}-${id}.restore-error.txt`,
            String((caught as Error)?.stack || caught),
          );
        }
      }
      await record(id, turns, checks, [
        "Setup: the fixture's papers are unfiled and each gets its synthetic Abstract section as abstractNote; afterwards every library item's folders and the fixture's abstracts are put back as they were, and the folders the run made are erased.",
        "everyPaperInOneFolderOrReported: a paper counts when it is in exactly one folder, or in none and excepted on the moves part with a reason.",
        "reads: no paper_read in full or overview mode; a targeted read counts against the rule only on a paper with an abstract (every fixture paper has one here).",
      ]);
    });
  });

  it("library chat: literature review over the real papers, no plan mode", async function () {
    await scenario("library.literature_review", async () => {
      assert.isAtLeast(papers.length, 3, "three real paper fixtures");
      const collection = await newCollection(`Review ${MARK}`);
      for (const paper of papers) {
        const item = Zotero.Items.get(paper.itemId);
        item.addToCollection(collection.id);
        await item.saveTx();
      }
      const conversationKey = 1_000_000 + Math.floor(Math.random() * 10_000);
      // The same request the plan-mode scenario sent, as one ordinary turn.
      const review = await runTurn({
        scenario: "library.literature_review",
        label: "review",
        conversationKey,
        userText: `Write a literature review of the papers in "${collection.name}" on the mechanisms proposed for representational drift and how the evidence for each compares.`,
        scope: libraryChat([collection]),
      });
      const checks: Record<string, unknown> = {
        completed: review.outcome === "completed",
        documentPublished: Boolean(review.documentId),
        papersCited: papers
          .filter((paper) =>
            new RegExp(paper.firstCreator, "i").test(review.answer),
          )
          .map((paper) => paper.firstCreator),
        coverageLine: /coverage|papers? (?:read|reviewed)/i.test(review.answer),
        answerChars: review.answer.length,
        answer: review.answer.slice(0, 8000),
      };
      await record("library.literature_review", [review], checks);
    });
  });

  it("plain chat: section intent calibration against the live embedding model", async function () {
    await scenario("plain_chat.section_intent_calibration", async () => {
      const profilePath = env("LLM_FOR_ZOTERO_LIVE_PROFILE_PATH");
      assert.isOk(profilePath, "the live profile owns the embedding settings");
      const contents = String(await Zotero.File.getContentsAsync(profilePath));
      const previous = EMBEDDING_PREF_KEYS.map(
        (key) =>
          [key, Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true)] as const,
      );
      const globalScope = globalThis as any;
      const previousToolkit = globalScope.ztoolkit;
      try {
        for (const key of EMBEDDING_PREF_KEYS) {
          const value = prefFromContents(contents, key);
          if (value !== undefined)
            Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
        }
        // The bundled llmClient reaches the network through the plugin's
        // toolkit.
        globalScope.ztoolkit = Zotero.LLMForZotero.data.ztoolkit;
        const groups = Object.keys(SECTION_INTENT_EXAMPLES) as Array<
          keyof typeof SECTION_INTENT_EXAMPLES
        >;
        const examples = groups.flatMap((group) =>
          SECTION_INTENT_EXAMPLES[group].map((text) => ({ group, text })),
        );
        const started = Date.now();
        let vectors: number[][];
        try {
          vectors = await callEmbeddings([
            ...examples.map((example) => example.text),
            ...SECTION_CALIBRATION_QUESTIONS.map((question) => question.text),
          ]);
        } catch (caught) {
          throw new Error(
            `Embedding request failed: ${redactKeys(String((caught as Error)?.message || caught))}`,
          );
        }
        const elapsedMs = Date.now() - started;
        assert.lengthOf(
          vectors,
          examples.length + SECTION_CALIBRATION_QUESTIONS.length,
          "one embedding per text",
        );
        const dimensions = vectors[0]?.length || 0;
        assert.isAbove(dimensions, 0, "the embeddings are not empty");
        assert.isTrue(
          vectors.every((vector) => vector.length === dimensions),
          "every embedding has the same dimension",
        );
        const round = (value: number) => Math.round(value * 10_000) / 10_000;
        const questions = SECTION_CALIBRATION_QUESTIONS.map(
          (question, index) => {
            const vector = vectors[examples.length + index];
            const closest = Object.fromEntries(
              groups.map((group) => [
                group,
                round(
                  Math.max(
                    ...examples.flatMap((example, at) =>
                      example.group === group
                        ? [cosineSimilarity(vector, vectors[at])]
                        : [],
                    ),
                  ),
                ),
              ]),
            ) as Record<string, number>;
            const marginOverGeneral = Object.fromEntries(
              groups
                .filter((group) => group !== "general")
                .map((group) => [
                  group,
                  round(closest[group] - closest.general),
                ]),
            ) as Record<string, number>;
            return {
              ...question,
              closest,
              marginOverGeneral,
              wantedAtCurrentMargin: Object.keys(marginOverGeneral).filter(
                (kind) => marginOverGeneral[kind] >= SECTION_INTENT_MARGIN,
              ),
            };
          },
        );
        // The provider and model name the calibration; the key never leaves.
        const config = getResolvedEmbeddingConfig();
        await write(`${variant}-plain_chat.section_intent_calibration.json`, {
          variant,
          scenario: "plain_chat.section_intent_calibration",
          embedding: { provider: config.providerKey, model: config.model },
          dimensions,
          elapsedMs,
          currentMargin: SECTION_INTENT_MARGIN,
          examples: SECTION_INTENT_EXAMPLES,
          questions,
        });
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined)
            Zotero.Prefs.clear(`${PREF_PREFIX}.${key}`, true);
          else Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
        }
        if (previousToolkit === undefined) delete globalScope.ztoolkit;
        else globalScope.ztoolkit = previousToolkit;
      }
    });
  });

  it("library chat: methods, then results, asked in Chinese", async function () {
    await scenario("library.sections_zh", async () => {
      assert.isAtLeast(papers.length, 3, "three real paper fixtures");
      const collection = await newCollection(`Sections ${MARK}`);
      for (const paper of papers) {
        const item = Zotero.Items.get(paper.itemId);
        item.addToCollection(collection.id);
        await item.saveTx();
      }
      let indexCoverage: unknown = "unavailable";
      try {
        const idle = await api.waitForLibraryTextIndexIdle?.(240_000);
        const coverage = await api.libraryTextIndexCoverage(
          papers.map((paper) => paper.attachmentId),
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
      const conversationKey = 1_010_000 + Math.floor(Math.random() * 10_000);
      const asks: Array<{
        label: string;
        section: EvidenceSectionKind;
        userText: string;
      }> = [
        {
          label: "methods",
          section: "methods",
          userText: "这些论文的研究方法是什么？请引用方法部分的原文证据。",
        },
        {
          label: "results",
          section: "results",
          userText: "这些论文的主要研究结果是什么？请引用结果部分的原文证据。",
        },
      ];
      const turns: Array<TurnRecord & { result?: any }> = [];
      const retrieval: Array<ReturnType<typeof retrieveSummary>> = [];
      for (const ask of asks) {
        const calls: RetrieveCall[] = [];
        turns.push(
          await runTurn({
            scenario: "library.sections_zh",
            label: ask.label,
            conversationKey,
            userText: ask.userText,
            scope: libraryChat([collection]),
            onEvent: collectRetrieveCalls(calls),
          }),
        );
        retrieval.push(retrieveSummary(ask.section, calls));
      }
      await record("library.sections_zh", turns, {
        indexCoverage,
        turns: asks.map((ask, index) => {
          const summary = summarizeTurn(turns[index]);
          return {
            label: ask.label,
            completed: turns[index].outcome === "completed",
            endState: summary.endState,
            agentRequests: summary.agentRequests,
            inputTokens: summary.inputTokens,
            toolSequence: summary.toolSequence,
            ...retrieval[index],
            answer: turns[index].answer.slice(0, 4000),
          };
        }),
      });
    });
  });

  /** Whether Zotero added the item at or after `since` (its UTC dateAdded). */
  function addedSince(item: any, since: number): boolean {
    return (
      Date.parse(`${String(item?.dateAdded || "").replace(" ", "T")}Z`) >= since
    );
  }

  it("library chat: discover two papers and import them into a new folder", async function () {
    await scenario("library.discover_import", async () => {
      const folderName = `Drift new ${MARK}`;
      const since = Date.now() - 1000;
      const cards: Array<{ title: string; offered: number; chose: string[] }> =
        [];
      const agent = Zotero.LLMForZotero.api.agent;
      const turn = await runTurn({
        scenario: "library.discover_import",
        label: "discover+import",
        conversationKey: 1_020_000 + Math.floor(Math.random() * 10_000),
        userText: `Find two recent papers on representational drift in hippocampus and add them to my library in a new folder "${folderName}".`,
        scope: libraryChat(),
        // A selection card is answered with its first two candidates; the
        // harness approves every other confirmation as usual.
        onEvent: (event: any) => {
          if (event?.type !== "confirmation_required") return;
          const list = (event.action?.fields || []).find(
            (field: any) => field?.id === "selectedPaperIds",
          );
          if (!list || !Array.isArray(list.rows)) return;
          const chose = list.rows.slice(0, 2).map((row: any) => String(row.id));
          cards.push({
            title: String(event.action?.title || ""),
            offered: list.rows.length,
            chose,
          });
          agent.resolveConfirmation(event.requestId, {
            approved: true,
            actionId: "import",
            data: { selectedPaperIds: chose },
          });
        },
      });
      const folder = Zotero.Collections.getByLibrary(libraryID()).find(
        (collection: any) =>
          collection.name === folderName && !collection.deleted,
      );
      const inFolder = folder
        ? (folder.getChildItems?.(false) || []).filter((item: any) =>
            item.isRegularItem?.(),
          )
        : [];
      const fixtures = new Set(created.items);
      const importedElsewhere = (await Zotero.Items.getAll(libraryID()))
        .filter(
          (item: any) =>
            item.isRegularItem?.() &&
            !item.deleted &&
            addedSince(item, since) &&
            !fixtures.has(item.id) &&
            !inFolder.some((member: any) => member.id === item.id),
        )
        .map((item: any) => item.id);
      try {
        await record("library.discover_import", [turn], {
          completed: turn.outcome === "completed",
          folderCreated: Boolean(folder),
          newItemsInFolder: inFolder.filter((item: any) =>
            addedSince(item, since),
          ).length,
          exactlyTwoNewItems:
            inFolder.length === 2 &&
            inFolder.every((item: any) => addedSince(item, since)),
          importedOutsideFolder: importedElsewhere.length,
          usedSelectionCard:
            cards.length > 0 ||
            turn.tools.some((tool) => tool.name === "literature_review"),
          usedLibraryImport: turn.tools.some(
            (tool) => tool.name === "library_import",
          ),
          cards,
          titles: inFolder.map((item: any) => item.getField("title")),
          answer: turn.answer.slice(0, 2000),
        });
      } finally {
        const imported = [
          ...inFolder.map((item: any) => item.id),
          ...importedElsewhere,
        ];
        if (imported.length) await Zotero.Items.erase(imported);
        if (folder) await folder.eraseTx();
      }
    });
  });

  it("paper chat: add to an existing note", async function () {
    await scenario("paper.edit_note", async () => {
      // No other scenario writes notes on this paper, so "my existing note"
      // names exactly one note.
      const paper = papers.find((entry) => entry.name === "rule2020");
      assert.isOk(paper, "the Rule paper fixture is required");
      const original = `Reading notes ${MARK}: the population code drifts while a linear readout stays stable.`;
      const note = new Zotero.Item("note");
      note.libraryID = libraryID();
      note.parentID = paper!.itemId;
      note.setNote(`<p>${original}</p>`);
      const noteId = Number(await note.saveTx());
      created.items.push(noteId);
      const before = noteText(Zotero.Items.get(noteId));
      const since = Date.now() - 1000;
      const turn = await runTurn({
        scenario: "paper.edit_note",
        label: "edit-note",
        conversationKey: 1_030_000 + Math.floor(Math.random() * 10_000),
        userText:
          "Add a short paragraph about the paper's limitations to my existing note on this paper.",
        scope: paperChat(paper!),
      });
      const edited = Zotero.Items.get(noteId);
      const after = noteText(edited);
      const otherNotes = childNotesCreatedAfter(paper!.itemId, since).filter(
        (entry: any) => entry.id !== noteId,
      );
      await record("paper.edit_note", [turn], {
        completed: turn.outcome === "completed",
        sameNoteEdited: Boolean(edited) && !edited.deleted && after !== before,
        noNewNote: otherNotes.length === 0,
        oldTextKept: after.includes(original),
        newTextAdded: after.length - before.length >= 80,
        mentionsLimitations: /limitation/i.test(after.replace(original, "")),
        addedChars: after.length - before.length,
        noteText: after.slice(0, 3000),
        answer: turn.answer.slice(0, 1500),
      });
    });
  });

  it("library chat: rename one folder and delete an empty one", async function () {
    await scenario("library.rename_delete_folder", async () => {
      const parent = await newCollection(`Parent ${MARK}`);
      const old = await newCollection(`Old name ${MARK}`);
      const empty = await newCollection(`Empty ${MARK}`, parent.id);
      const member = await seedItem(`Folder fixture ${MARK}`);
      await addToCollection(old, [member]);
      const turn = await runTurn({
        scenario: "library.rename_delete_folder",
        label: "rename+delete",
        conversationKey: 1_040_000 + Math.floor(Math.random() * 10_000),
        userText: `Rename the folder "Old name ${MARK}" to "New name ${MARK}", then delete the empty folder "Empty ${MARK}".`,
        scope: libraryChat(),
      });
      const live = (name: string) =>
        Zotero.Collections.getByLibrary(libraryID()).filter(
          (collection: any) => collection.name === name && !collection.deleted,
        );
      const renamed = Zotero.Collections.get(old.id);
      const emptyAfter = Zotero.Collections.get(empty.id);
      const parentAfter = Zotero.Collections.get(parent.id);
      await record("library.rename_delete_folder", [turn], {
        completed: turn.outcome === "completed",
        renamed:
          Boolean(renamed) &&
          !renamed.deleted &&
          renamed.name === `New name ${MARK}`,
        renamedInPlace:
          live(`New name ${MARK}`).length === 1 &&
          live(`Old name ${MARK}`).length === 0,
        memberKept: Zotero.Items.get(member.id)
          .getCollections()
          .includes(old.id),
        emptyGone: !emptyAfter || Boolean(emptyAfter.deleted),
        emptyTrashed: Boolean(emptyAfter?.deleted),
        parentUnaffected:
          Boolean(parentAfter) &&
          !parentAfter.deleted &&
          parentAfter.name === `Parent ${MARK}`,
        answer: turn.answer.slice(0, 1500),
      });
    });
  });

  it("paper chat: fix a wrong year and a missing DOI the user states", async function () {
    await scenario("paper.fix_metadata", async () => {
      const title = `Drift metadata fixture ${MARK}`;
      const fixture = await api.createPaperWithPdfFixture({
        title,
        pdfTitle: `${title}.pdf`,
        pages: [
          `${title}\nPlace fields drift over days while the readout stays stable.`,
        ],
      });
      created.items.push(fixture.parentItemId);
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setField("date", "2019");
      item.setField("publicationTitle", "Journal of Drift Fixtures");
      item.setField("volume", "7");
      item.setField("pages", "1-10");
      item.setCreators([
        { creatorType: "author", firstName: "Ada", lastName: "Fixture" },
      ]);
      await item.saveTx();
      const before = item.toJSON();
      const fixturePaper: PaperFixture = {
        name: "metadata-fixture",
        itemId: fixture.parentItemId,
        attachmentId: fixture.pdfAttachmentId,
        title,
        firstCreator: "Fixture",
        year: "2019",
        markdown: "",
        ref: {
          libraryID: libraryID(),
          itemId: fixture.parentItemId,
          contextItemId: fixture.pdfAttachmentId,
          title,
          firstCreator: "Fixture",
          year: "2019",
        },
      };
      const doi = `10.1234/abcd.${MARK}`;
      const turn = await runTurn({
        scenario: "paper.fix_metadata",
        label: "fix-metadata",
        conversationKey: 1_050_000 + Math.floor(Math.random() * 10_000),
        userText: `The year should be 2024 and the DOI is ${doi}. Please fix this paper's metadata.`,
        scope: paperChat(fixturePaper),
      });
      const fresh = Zotero.Items.get(fixture.parentItemId);
      const after = fresh.toJSON();
      const expectedChanges = new Set([
        "date",
        "DOI",
        "dateModified",
        "version",
      ]);
      const otherChanges = [
        ...new Set([...Object.keys(before), ...Object.keys(after)]),
      ]
        .filter((key) => !expectedChanges.has(key))
        .filter(
          (key) =>
            JSON.stringify((before as any)[key]) !==
            JSON.stringify((after as any)[key]),
        );
      await record("paper.fix_metadata", [turn], {
        completed: turn.outcome === "completed",
        yearFixed: /\b2024\b/.test(String(fresh.getField("date"))),
        doiFixed: String(fresh.getField("DOI")).toLowerCase() === doi,
        nothingElseChanged: otherChanges.length === 0,
        otherChanges,
        date: fresh.getField("date"),
        DOI: fresh.getField("DOI"),
        answer: turn.answer.slice(0, 1500),
      });
    });
  });

  it("paper chat: a short report on Figure 2 with the figure, saved as a note", async function () {
    await scenario("paper.figure_document", async () => {
      const paper = papers.find((entry) => entry.name === "ratzon2024");
      assert.isOk(paper, "the Ratzon paper fixture is required");
      const since = Date.now() - 1000;
      const assetCounts: number[] = [];
      const turn = await runTurn({
        scenario: "paper.figure_document",
        label: "figure-report",
        conversationKey: 1_060_000 + Math.floor(Math.random() * 10_000),
        userText:
          "Write a short report on Figure 2 of this paper with the figure included, and save it as a note.",
        scope: paperChat(paper!),
        onEvent: (event: any) => {
          if (event?.type === "tool_call" && event.name === "submit_document") {
            const args = event.arguments ?? event.args ?? {};
            assetCounts.push(
              Array.isArray(args.assets) ? args.assets.length : 0,
            );
          }
        },
      });
      const document = turn.documentId
        ? await loadPlanDocument(turn.documentId)
        : null;
      const paperKey = Zotero.Items.get(paper!.itemId)?.key;
      const assets = document?.assets || [];
      const notes = childNotesCreatedAfter(paper!.itemId, since);
      const notesWithImage = notes.filter(
        (note: any) =>
          /<img\b/i.test(String(note.getNote?.() || "")) ||
          (note.getAttachments?.() || []).length > 0,
      );
      const assetsOnThisPaper = assets.filter(
        (asset: any) =>
          asset.provenance?.origin === "extracted" &&
          asset.provenance.itemKey === paperKey,
      ).length;
      const notesElsewhere = (await Zotero.Items.getAll(libraryID())).filter(
        (item: any) =>
          item.isNote?.() &&
          addedSince(item, since) &&
          Number(item.parentID || 0) !== paper!.itemId,
      ).length;
      await record("paper.figure_document", [turn], {
        completed: turn.outcome === "completed",
        figureSaved: assetsOnThisPaper > 0 || notesWithImage.length > 0,
        documentAssets: assets.length,
        assetsOnThisPaper,
        submittedAssets: assetCounts,
        notesSaved: notes.length,
        notesWithImage: notesWithImage.length,
        notesElsewhere,
        noteText: notes.map(noteText).join("\n\n").slice(0, 3000),
        answer: turn.answer.slice(0, 2000),
      });
    });
  });

  it("library chat: sort a folder's papers into topic subfolders", async function () {
    await scenario("library.reorganize", async () => {
      const folder = await newCollection(`Unsorted ${MARK}`);
      const topicOf = new Map<number, string>();
      for (const topic of REORGANIZE_TOPICS) {
        for (const paper of topic.papers) {
          const fixture = await api.createPaperWithPdfFixture({
            title: paper.title,
            pdfTitle: `${paper.title}.pdf`,
            pages: [`${paper.title}\n${paper.abstract}`],
          });
          created.items.push(fixture.parentItemId);
          const item = Zotero.Items.get(fixture.parentItemId);
          item.setField("abstractNote", paper.abstract);
          item.setField("date", "2023");
          item.setCreators([
            { creatorType: "author", firstName: "", lastName: "Fixture" },
          ]);
          // Filed in the folder only, as an inbox of unsorted papers.
          item.setCollections([folder.id]);
          await item.saveTx();
          topicOf.set(fixture.parentItemId, topic.topic);
        }
      }
      const paperIds = [...topicOf.keys()];
      // Every folder, nested ones too: getByLibrary lists only top-level
      // folders unless asked to recurse, and the subfolders sit in `folder`.
      const allCollections = (): any[] =>
        Zotero.Collections.getByLibrary(libraryID(), true);
      const before = new Set(allCollections().map((c: any) => c.id));
      // Safe mode, so each batch of moves (and of tags) is one review card.
      const modeKey = `${PREF_PREFIX}.originalAgentPermissionMode`;
      const priorMode = Zotero.Prefs.get(modeKey, true);
      Zotero.Prefs.set(modeKey, "safe", true);
      const sort = reorganizeTracker(
        "Yes, go ahead with the proposed grouping.",
      );
      const tagging = reorganizeTracker("Yes, go ahead.");
      const conversationKey = 1_070_000 + Math.floor(Math.random() * 10_000);
      const turns: Array<TurnRecord & { result?: any }> = [];
      let checks: Record<string, unknown> = {};
      try {
        turns.push(
          await runTurn({
            scenario: "library.reorganize",
            label: "sort",
            conversationKey,
            userText: `Sort the papers in "${folder.name}" into topic subfolders.`,
            scope: libraryChat([folder]),
            onEvent: sort.onEvent,
          }),
        );
        // A model that stopped after its proposal to ask is told to go on.
        if (!sort.state.moveBatches.length) {
          turns.push(
            await runTurn({
              scenario: "library.reorganize",
              label: "go-ahead",
              conversationKey,
              userText: "Yes, go ahead.",
              scope: libraryChat([folder]),
              onEvent: sort.onEvent,
            }),
          );
        }
        const sortTurns = [...turns];
        const subfolders = allCollections().filter(
          (collection: any) =>
            !before.has(collection.id) && collection.parentID === folder.id,
        );
        const elsewhere = allCollections()
          .filter(
            (collection: any) =>
              !before.has(collection.id) && collection.parentID !== folder.id,
          )
          .map((collection: any) => collection.name);
        const subfolderIds = new Set(subfolders.map((c: any) => c.id));
        const homes = paperIds.map(
          (id) =>
            (Zotero.Items.get(id)?.getCollections?.() || []).filter(
              (collectionId: number) => subfolderIds.has(collectionId),
            ).length,
        );
        const answer = sortTurns.map((turn) => turn.answer).join("\n\n");
        // The counts the final report states, per folder.
        const report = sortTurns[sortTurns.length - 1]?.answer || "";
        const folders: Array<{
          name: string;
          papers: number;
          reported: number | null;
          dominantTopic: string;
          purity: number;
          namedFor: string[];
        }> = subfolders.map((collection: any) => {
          const members = paperIds.filter((id) =>
            Zotero.Items.get(id)?.getCollections?.().includes(collection.id),
          );
          const counts = new Map<string, number>();
          for (const id of members)
            counts.set(
              topicOf.get(id)!,
              (counts.get(topicOf.get(id)!) || 0) + 1,
            );
          const [dominant, dominantCount] = [...counts].sort(
            (left, right) => right[1] - left[1],
          )[0] || ["", 0];
          const named = REORGANIZE_TOPICS.filter((topic) =>
            topic.folder.test(String(collection.name)),
          ).map((topic) => topic.topic);
          return {
            name: String(collection.name),
            papers: members.length,
            reported: reportedCountIn(report, String(collection.name)),
            dominantTopic: dominant,
            purity: members.length
              ? Math.round((dominantCount / members.length) * 100) / 100
              : 0,
            namedFor: named,
          };
        });
        // What the user had seen in the chat before the first move.
        const beforeFirstMove = shownBefore(
          sort.state,
          sortTurns,
          sort.state.firstMoveAt,
        );
        const beforeFirstWrite = shownBefore(
          sort.state,
          sortTurns,
          sort.state.firstWriteAt,
        );
        const proposalNames = (text: string) =>
          folders.length > 0 &&
          folders.every((entry) =>
            text.toLowerCase().includes(entry.name.toLowerCase()),
          );
        checks = {
          completed: sortTurns.every((turn) => turn.outcome === "completed"),
          mode: "safe",
          papers: paperIds.length,
          proposalBeforeFirstMove:
            sort.state.moveBatches.length > 0 && proposalNames(beforeFirstMove),
          proposalBeforeFirstWrite: proposalNames(beforeFirstWrite),
          proposalText: beforeFirstMove.slice(0, 3000),
          askedBeforeMoving:
            sortTurns.length > 1 || sort.state.questions.length > 0,
          questions: sort.state.questions,
          everyPaperInExactlyOneNewSubfolder: homes.every(
            (count) => count === 1,
          ),
          papersInNoSubfolder: homes.filter((count) => count === 0).length,
          papersInSeveral: homes.filter((count) => count > 1).length,
          papersStillInSource: paperIds.filter((id) =>
            Zotero.Items.get(id)?.getCollections?.().includes(folder.id),
          ).length,
          foldersNamedByTopic:
            folders.length > 0 &&
            folders.every(
              (entry) =>
                entry.namedFor.length > 0 &&
                entry.namedFor.includes(entry.dominantTopic),
            ),
          reportCountsMatch:
            folders.length > 0 &&
            folders.every((entry) => entry.reported === entry.papers),
          folders,
          newFoldersElsewhere: elsewhere,
          // Sorting reads records, not papers: every paper has an abstract.
          reads: metadataOnlyReads(sortTurns.flatMap((turn) => turn.tools)),
          movesPart: sort.state.writePart || null,
          moveCalls: sort.state.moveBatches.length,
          batchSizes: sort.state.moveBatches,
          moveCards: sort.state.cards.filter(
            (card) => card.type === "assignment_table",
          ).length,
          cards: sort.state.cards,
          loadedSkill: sort.state.loadedSkill,
          paperReads: sort.state.paperReads,
          endStates: sortTurns.map((turn) => turn.endState),
          steps: sortTurns.map((turn) => turn.steps),
          answer: answer.slice(0, 4000),
        };
        // A second request in the same chat: one topic tag per paper, from
        // the same records. The folder and its new subfolders are the scope,
        // so the turn covers the papers wherever the sort left them.
        try {
          const tagsOf = (itemId: number): string[] =>
            (Zotero.Items.get(itemId)?.getTags?.() || []).map((tag: any) =>
              String(tag.tag),
            );
          const filingOf = (itemId: number): string =>
            [...(Zotero.Items.get(itemId)?.getCollections?.() || [])]
              .sort((left, right) => left - right)
              .join(",");
          const tagsBefore = new Map(
            paperIds.map((itemId) => [itemId, tagsOf(itemId)]),
          );
          const filingBefore = new Map(
            paperIds.map((itemId) => [itemId, filingOf(itemId)]),
          );
          const tagTurn = await runTurn({
            scenario: "library.reorganize",
            label: "tag",
            conversationKey,
            userText: "Also tag each paper with its topic.",
            scope: libraryChat([folder, ...subfolders]),
            onEvent: tagging.onEvent,
          });
          turns.push(tagTurn);
          const added = paperIds.map((itemId) =>
            tagsOf(itemId).filter(
              (tag) => !tagsBefore.get(itemId)!.includes(tag),
            ),
          );
          const tagsByTopic = new Map<string, Set<string>>();
          paperIds.forEach((itemId, index) => {
            const topic = topicOf.get(itemId)!;
            const tags = tagsByTopic.get(topic) || new Set<string>();
            for (const tag of added[index]) tags.add(tag);
            tagsByTopic.set(topic, tags);
          });
          const namesTopic = (itemId: number, tag: string) =>
            Boolean(
              REORGANIZE_TOPICS.find(
                (topic) => topic.topic === topicOf.get(itemId),
              )?.folder.test(tag),
            );
          checks.tagTurn = {
            completed: tagTurn.outcome === "completed",
            everyPaperExactlyOneTopicTag: added.every(
              (tags) => tags.length === 1,
            ),
            tagsNameTopic: paperIds.every(
              (itemId, index) =>
                added[index].length === 1 &&
                namesTopic(itemId, added[index][0]),
            ),
            oneTagPerTopic: [...tagsByTopic.values()].every(
              (tags) => tags.size === 1,
            ),
            papersWithoutNewTag: added.filter((tags) => !tags.length).length,
            papersWithSeveralNewTags: added.filter((tags) => tags.length > 1)
              .length,
            tagsByTopic: Object.fromEntries(
              [...tagsByTopic].map(([topic, tags]) => [topic, [...tags]]),
            ),
            foldersUnchanged: paperIds.every(
              (itemId) => filingOf(itemId) === filingBefore.get(itemId),
            ),
            reads: metadataOnlyReads(tagTurn.tools),
            tagCalls: tagging.state.tagBatches.length,
            batchSizes: tagging.state.tagBatches,
            moveCalls: tagging.state.moveBatches.length,
            tagCards: tagging.state.cards.filter(
              (card) => card.type === "tag_assignment_table",
            ).length,
            cards: tagging.state.cards,
            tagsPart: tagging.state.writePart || null,
            loadedSkill: tagging.state.loadedSkill,
            endState: tagTurn.endState,
            steps: tagTurn.steps,
            answer: tagTurn.answer.slice(0, 2000),
          };
        } catch (caught) {
          checks.tagTurn = {
            harnessError: String((caught as Error)?.stack || caught),
          };
        }
      } finally {
        if (priorMode === undefined) Zotero.Prefs.clear(modeKey, true);
        else Zotero.Prefs.set(modeKey, priorMode, true);
        created.collections.push(
          ...allCollections()
            .filter((collection: any) => !before.has(collection.id))
            .map((collection: any) => collection.id),
        );
      }
      await record("library.reorganize", turns, checks, [
        "Folders are found with getByLibrary(libraryID, true): without true it lists only top-level folders, so the run's subfolders were never seen.",
        "tagTurn: a second request in the same chat, scoped to the folder and its new subfolders; each paper should get exactly one new tag naming its topic, still with no full or overview read.",
      ]);
    });
  });
});
