import {
  auditCrossPaperSupport,
  type SupportAuditEdge,
  type SupportAuditResult,
} from "../documents/supportAudit";
import type { PlanCitationCluster } from "../documents/types";
import { computeResearchQualityReport } from "./rubric";
import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchEdge,
  ResearchJob,
  ResearchOpenQuestion,
  ResearchQualityReport,
  ResearchSubquestion,
  ResearchSynthesisPhase,
  ThemeFinding,
} from "./types";

/**
 * Flight 0: one report for one research job, from durable state and the run
 * event trace. The command-line script and the in-app workflow API both
 * render it, so every flight is measured with the same numbers.
 */

export type FlightRunEvent = Readonly<{
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
}>;

export type FlightRun = Readonly<{
  runId: string;
  createdAt: number;
  completedAt?: number;
  status: string;
  events: readonly FlightRunEvent[];
}>;

export type FlightPhase =
  | "planning"
  | "inventory"
  | "nodes"
  | "links"
  | "verification"
  | "structure"
  | "writing";

export type FlightTimings = Readonly<{
  runs: number;
  wallTimeMs: number;
  rounds: number;
  toolCalls: Readonly<Record<string, number>>;
  malformedArguments: number;
  toolErrors: number;
  documentRejections: number;
  checkpointRestarts: number;
  targetedReads: number;
  phaseMs: Readonly<Record<FlightPhase, number>>;
}>;

export type ResearchFlightReport = Readonly<{
  researchJobId: string;
  executionId: string;
  status: ResearchJob["status"];
  coverageStatus?: ResearchJob["coverageStatus"];
  phase: ResearchSynthesisPhase | "legacy";
  tiers: Readonly<Record<string, number>>;
  capacity?: ResearchJob["nodeCapacity"];
  quality: ResearchQualityReport;
  audit?: SupportAuditResult;
  timings?: FlightTimings;
}>;

const ITEM_LINK =
  /\(zotero:\/\/select\/(?:library|groups\/\d+)\/items\/([A-Za-z0-9]+)\)/g;

/**
 * Stored documents carry rendered citations, not tokens. Turn every Zotero
 * item link back into a citation token so the same audit runs on them.
 */
export function auditStoredDocumentSupport(params: {
  visibleMarkdown: string;
  clusters: readonly PlanCitationCluster[];
  edges: readonly SupportAuditEdge[];
}): SupportAuditResult {
  const libraryByKey = new Map<string, number>();
  for (const cluster of params.clusters) {
    for (const source of cluster.sources) {
      libraryByKey.set(source.itemKey, source.libraryID);
    }
  }
  const keys = new Set<string>();
  const markdown = params.visibleMarkdown.replace(
    ITEM_LINK,
    (match, key: string) => {
      if (!libraryByKey.has(key)) return match;
      keys.add(key);
      return ` [[cite:${key}]]`;
    },
  );
  return auditCrossPaperSupport({
    markdown,
    clusters: [...keys].map((key) => ({
      citationId: key,
      sources: [
        { libraryID: libraryByKey.get(key)!, itemKey: key, evidenceRefs: [] },
      ],
    })),
    edges: params.edges,
  });
}

function phaseOfCall(
  name: string,
  args: Record<string, unknown>,
  current: FlightPhase,
): FlightPhase {
  if (name === "update_plan") return "planning";
  if (name === "submit_document") return "writing";
  if (name === "research_update") {
    const operation = String(args.operation || "");
    if (operation === "inventory_scope") return "inventory";
    if (["record_papers", "set_tiers", "set_frame"].includes(operation))
      return "nodes";
    if (["record_edges", "list_findings"].includes(operation)) {
      return current === "verification" || current === "structure"
        ? current
        : "links";
    }
    if (["update_edges", "next_work"].includes(operation))
      return "verification";
    if (
      [
        "list_graph",
        "record_themes",
        "record_questions",
        "resolve_questions",
        "list_themes",
        "finalize",
      ].includes(operation)
    ) {
      return "structure";
    }
    if (operation === "advance_phase") {
      const phase = String(args.phase || "");
      return phase === "links" ||
        phase === "verification" ||
        phase === "structure" ||
        phase === "writing"
        ? phase
        : current;
    }
    return current;
  }
  if (name === "paper_read") {
    return current === "verification" || current === "structure"
      ? "verification"
      : "nodes";
  }
  return current;
}

export function summarizeFlightRuns(runs: readonly FlightRun[]): FlightTimings {
  const toolCalls: Record<string, number> = {};
  const phaseMs: Record<FlightPhase, number> = {
    planning: 0,
    inventory: 0,
    nodes: 0,
    links: 0,
    verification: 0,
    structure: 0,
    writing: 0,
  };
  let wallTimeMs = 0;
  let rounds = 0;
  let malformedArguments = 0;
  let toolErrors = 0;
  let documentRejections = 0;
  let checkpointRestarts = 0;
  let targetedReads = 0;
  for (const run of runs) {
    const end =
      run.completedAt ?? run.events.at(-1)?.createdAt ?? run.createdAt;
    wallTimeMs += Math.max(0, end - run.createdAt);
    let phase: FlightPhase = "inventory";
    let boundary = run.createdAt;
    const callNames = new Map<string, string>();
    for (const event of run.events) {
      const payload = event.payload;
      if (event.type === "status") {
        const match = /Continuing agent \((\d+)\/\d+\)/.exec(
          String(payload.text || ""),
        );
        if (match) rounds = Math.max(rounds, Number(match[1]));
      }
      if (event.type === "tool_call") {
        const name = String(payload.name || "");
        const args =
          payload.args && typeof payload.args === "object"
            ? (payload.args as Record<string, unknown>)
            : {};
        if (args.__llmForZoteroMalformedToolArguments) malformedArguments += 1;
        const operation = String(args.operation || args.mode || "");
        const label = operation ? `${name}:${operation}` : name;
        toolCalls[label] = (toolCalls[label] || 0) + 1;
        if (name === "paper_read" && args.mode === "targeted")
          targetedReads += 1;
        phase = phaseOfCall(name, args, phase);
        callNames.set(String(payload.callId || ""), name);
        phaseMs[phase] += Math.max(0, event.createdAt - boundary);
        boundary = event.createdAt;
      }
      if (event.type === "tool_result") {
        const name =
          callNames.get(String(payload.callId || "")) ||
          String(payload.name || "");
        if (payload.ok === false) {
          toolErrors += 1;
          if (name === "submit_document") documentRejections += 1;
        }
        phaseMs[phase] += Math.max(0, event.createdAt - boundary);
        boundary = event.createdAt;
      }
      if (
        event.type === "provider_event" &&
        payload.providerType === "agent_context_budget"
      ) {
        checkpointRestarts += 1;
      }
      if (event.type === "final") {
        phaseMs[phase === "inventory" ? "planning" : "writing"] += Math.max(
          0,
          event.createdAt - boundary,
        );
        boundary = event.createdAt;
      }
    }
  }
  return {
    runs: runs.length,
    wallTimeMs,
    rounds,
    toolCalls,
    malformedArguments,
    toolErrors,
    documentRejections,
    checkpointRestarts,
    targetedReads,
    phaseMs,
  };
}

export function buildResearchFlightReport(params: {
  job: ResearchJob;
  corpus: readonly ResearchCorpusItem[];
  findings: readonly PaperFinding[];
  edges: readonly ResearchEdge[];
  questions: readonly ResearchOpenQuestion[];
  themes: readonly ThemeFinding[];
  subquestions: readonly ResearchSubquestion[];
  document?: Readonly<{
    visibleMarkdown: string;
    clusters: readonly PlanCitationCluster[];
  }>;
  runs?: readonly FlightRun[];
  now?: number;
}): ResearchFlightReport {
  const audit = params.document
    ? auditStoredDocumentSupport({
        visibleMarkdown: params.document.visibleMarkdown,
        clusters: params.document.clusters,
        edges: params.edges,
      })
    : undefined;
  const quality = computeResearchQualityReport({
    corpus: params.corpus,
    findings: params.findings,
    edges: params.edges,
    questions: params.questions,
    themes: params.themes,
    subquestions: params.subquestions,
    ...(audit
      ? {
          audit: {
            crossPaperParagraphs: audit.crossPaperParagraphs,
            supported: audit.supported,
          },
        }
      : {}),
    now: params.now,
  });
  const tiers: Record<string, number> = {};
  for (const item of params.corpus) {
    if (item.screeningStatus === "missing") continue;
    const tier = item.tier || "untiered";
    tiers[tier] = (tiers[tier] || 0) + 1;
  }
  return {
    researchJobId: params.job.researchJobId,
    executionId: params.job.executionId,
    status: params.job.status,
    coverageStatus: params.job.coverageStatus,
    phase: params.job.frame ? params.job.synthesisPhase || "nodes" : "legacy",
    tiers,
    ...(params.job.nodeCapacity ? { capacity: params.job.nodeCapacity } : {}),
    quality,
    ...(audit ? { audit } : {}),
    ...(params.runs ? { timings: summarizeFlightRuns(params.runs) } : {}),
  };
}

function row(label: string, value: string | number): string {
  return `${label.padEnd(34)} ${String(value)}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function renderResearchFlightReport(
  report: ResearchFlightReport,
): string {
  const q = report.quality;
  const lines = [
    `Research flight report — ${report.researchJobId}`,
    row(
      "status / coverage",
      `${report.status} / ${report.coverageStatus || "-"}`,
    ),
    row("loop phase", report.phase),
    row(
      "tiers",
      Object.entries(report.tiers)
        .map(([tier, count]) => `${tier} ${count}`)
        .join(", ") || "-",
    ),
    ...(report.capacity
      ? [
          row(
            "full-node capacity",
            `${report.capacity.fullNodeCapacity} (link view ${report.capacity.linkViewTokens} tokens, tiering ${
              report.capacity.mandatoryTiering ? "mandatory" : "optional"
            })`,
          ),
        ]
      : []),
    "",
    "Quality",
    row("papers / nodes", `${q.papers} / ${q.nodes}`),
    row("claims (verified locators)", `${q.claims} (${q.claimsWithLocators})`),
    row("nodes with an edge", `${q.nodesWithEdges} / ${q.nodes}`),
    row(
      "edges (verified/tentative/refuted)",
      `${q.edges} (${q.edgesVerified}/${q.edgesTentative}/${q.edgesRefuted})`,
    ),
    row("contradictions surfaced", q.contradictions),
    row(
      "claims per subquestion",
      Object.entries(q.subquestionClaims)
        .map(([id, count]) => `${id}=${count}`)
        .join(", ") || "-",
    ),
    row("themes (bound to edges)", `${q.themes} (${q.themesWithEdges})`),
    row(
      "open / answered questions",
      `${q.openQuestions} / ${q.answeredQuestions}`,
    ),
    ...(report.audit
      ? [
          row(
            "cross-paper paragraphs supported",
            `${report.audit.supported} / ${report.audit.crossPaperParagraphs}`,
          ),
        ]
      : []),
  ];
  if (report.timings) {
    const t = report.timings;
    lines.push(
      "",
      "Run",
      row("runs / wall time", `${t.runs} / ${seconds(t.wallTimeMs)}`),
      row("model rounds", t.rounds),
      row(
        "phase time",
        (Object.keys(t.phaseMs) as FlightPhase[])
          .filter((phase) => t.phaseMs[phase] > 0)
          .map((phase) => `${phase} ${seconds(t.phaseMs[phase])}`)
          .join(", ") || "-",
      ),
      row("targeted reads", t.targetedReads),
      row("malformed tool arguments", t.malformedArguments),
      row(
        "tool errors / document rejections",
        `${t.toolErrors} / ${t.documentRejections}`,
      ),
      row("checkpoint restarts", t.checkpointRestarts),
      row(
        "tool calls",
        Object.entries(t.toolCalls)
          .sort((left, right) => right[1] - left[1])
          .map(([name, count]) => `${name} ×${count}`)
          .join(", ") || "-",
      ),
    );
  }
  return lines.join("\n");
}
