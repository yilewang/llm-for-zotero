/**
 * Flight 0 report for a research job in a Zotero database, opened read-only.
 *
 *   npx tsx scripts/research-flight-report.ts --db ~/Zotero/zotero.sqlite [--job <researchJobId>] [--list]
 *
 * Without --job the most recent research job is reported. Run events of the
 * job's execution are summarized when they are still in the database.
 */
import { DatabaseSync } from "node:sqlite";
import { decodePlanArtifact } from "../src/agent/plans/decoders";
import {
  decodePaperFinding,
  decodeResearchCorpusItem,
  decodeResearchJob,
  decodeThemeFinding,
} from "../src/agent/research/decoders";
import {
  decodeResearchEdge,
  decodeResearchOpenQuestion,
} from "../src/agent/research/graphSchema";
import {
  buildResearchFlightReport,
  renderResearchFlightReport,
  type FlightRun,
} from "../src/agent/research/flightReport";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dbPath = argument("--db");
if (!dbPath) {
  console.error(
    "Usage: npx tsx scripts/research-flight-report.ts --db <zotero.sqlite> [--job <id>] [--list]",
  );
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

function rows<T>(
  sql: string,
  params: unknown[],
  decode: (value: unknown) => T,
): T[] {
  try {
    return (
      db.prepare(sql).all(...(params as never[])) as Array<{
        payloadJson: string;
      }>
    )
      .map((row) => {
        try {
          return decode(JSON.parse(row.payloadJson));
        } catch {
          return null;
        }
      })
      .filter((entry): entry is T => Boolean(entry));
  } catch (error) {
    if (/no such table/i.test(String(error))) return [];
    throw error;
  }
}

if (process.argv.includes("--list")) {
  const jobs = db
    .prepare(
      "SELECT research_job_id AS id, status, created_at AS createdAt FROM llm_for_zotero_research_jobs ORDER BY created_at DESC LIMIT 20",
    )
    .all() as Array<{ id: string; status: string; createdAt: number }>;
  for (const job of jobs) {
    console.log(
      `${new Date(job.createdAt).toISOString()}  ${job.status.padEnd(12)}  ${job.id}`,
    );
  }
  process.exit(0);
}

const jobId =
  argument("--job") ||
  (
    db
      .prepare(
        "SELECT research_job_id AS id FROM llm_for_zotero_research_jobs ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { id?: string } | undefined
  )?.id;
if (!jobId) {
  console.error("No research job found");
  process.exit(1);
}
const job = rows(
  "SELECT payload_json AS payloadJson FROM llm_for_zotero_research_jobs WHERE research_job_id = ?",
  [jobId],
  decodeResearchJob,
)[0];
if (!job) {
  console.error(`Research job ${jobId} not found or undecodable`);
  process.exit(1);
}
const corpus = rows(
  "SELECT payload_json AS payloadJson FROM llm_for_zotero_research_corpus_items WHERE research_job_id = ? ORDER BY ordinal",
  [jobId],
  decodeResearchCorpusItem,
);
const findings = rows(
  "SELECT payload_json AS payloadJson FROM llm_for_zotero_research_paper_findings WHERE research_job_id = ?",
  [jobId],
  decodePaperFinding,
);
const edges = rows(
  "SELECT payload_json AS payloadJson FROM llm_for_zotero_research_edges WHERE research_job_id = ?",
  [jobId],
  decodeResearchEdge,
);
const questions = rows(
  "SELECT payload_json AS payloadJson FROM llm_for_zotero_research_open_questions WHERE research_job_id = ?",
  [jobId],
  decodeResearchOpenQuestion,
);
const themes = rows(
  "SELECT payload_json AS payloadJson FROM llm_for_zotero_research_theme_findings WHERE research_job_id = ?",
  [jobId],
  decodeThemeFinding,
).filter((theme) => theme.status !== "invalidated");
const execution = db
  .prepare(
    "SELECT plan_id AS planId, revision, conversation_key AS conversationKey FROM llm_for_zotero_plan_executions WHERE execution_id = ?",
  )
  .get(job.executionId) as
  | { planId: string; revision: number; conversationKey: number }
  | undefined;
const artifact = execution
  ? rows(
      "SELECT payload_json AS payloadJson FROM llm_for_zotero_plan_artifacts WHERE plan_id = ? AND revision = ?",
      [execution.planId, execution.revision],
      decodePlanArtifact,
    )[0]
  : undefined;
const subquestions = artifact?.contract?.investigation?.subquestions || [];
const documentRow = db
  .prepare(
    "SELECT payload_json AS payloadJson FROM llm_for_zotero_plan_documents WHERE execution_id = ? ORDER BY created_at DESC LIMIT 1",
  )
  .get(job.executionId) as { payloadJson: string } | undefined;
const document = documentRow
  ? (() => {
      const payload = JSON.parse(documentRow.payloadJson) as {
        visibleMarkdown?: string;
        citationBundle?: {
          clusters?: Array<{
            citationId: string;
            sources: Array<{ libraryID: number; itemKey: string }>;
          }>;
        };
      };
      return {
        visibleMarkdown: String(payload.visibleMarkdown || ""),
        clusters: (payload.citationBundle?.clusters || []).map((cluster) => ({
          citationId: cluster.citationId,
          sources: cluster.sources.map((source) => ({
            libraryID: source.libraryID,
            itemKey: source.itemKey,
            evidenceRefs: [] as string[],
          })),
        })),
      };
    })()
  : undefined;
const runs: FlightRun[] = execution
  ? (
      db
        .prepare(
          "SELECT run_id AS runId, status, created_at AS createdAt, completed_at AS completedAt FROM llm_for_zotero_agent_runs WHERE conversation_key = ? AND created_at >= ? ORDER BY created_at",
        )
        .all(execution.conversationKey, job.createdAt - 5 * 60_000) as Array<{
        runId: string;
        status: string;
        createdAt: number;
        completedAt: number | null;
      }>
    ).map((run) => ({
      runId: run.runId,
      status: run.status,
      createdAt: run.createdAt,
      completedAt: run.completedAt ?? undefined,
      events: (
        db
          .prepare(
            "SELECT event_type AS type, payload_json AS payloadJson, created_at AS createdAt FROM llm_for_zotero_agent_run_events WHERE run_id = ? ORDER BY seq",
          )
          .all(run.runId) as Array<{
          type: string;
          payloadJson: string;
          createdAt: number;
        }>
      ).map((event) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
        } catch {
          payload = {};
        }
        return { type: event.type, createdAt: event.createdAt, payload };
      }),
    }))
  : [];
// Keep only runs that touched this execution.
const executionRuns = runs.filter((run) =>
  run.events.some(
    (event) =>
      event.type === "tool_call" &&
      String(event.payload.executionId || "") === job.executionId,
  ),
);
console.log(
  renderResearchFlightReport(
    buildResearchFlightReport({
      job,
      corpus,
      findings,
      edges,
      questions,
      themes,
      subquestions,
      document,
      runs: executionRuns.length ? executionRuns : undefined,
    }),
  ),
);
db.close();
