/**
 * Live acceptance of instruction-driven per-paper digests and agent-owned
 * selection (plan 2026-10-02, section 6).
 *
 * Seeds folder F (and, for "1h", a held-out folder) into real Zotero
 * collections with neutral names, then runs each scenario in a new Library
 * chat conversation, in the real panel, in Agent mode, on the live model,
 * with the folder attached as the composer context. Scenario 7 instead runs
 * over the whole library with nothing attached: the library then holds only
 * the 16 papers of LLM_FOR_ZOTERO_DIGEST_LIBRARY_DIR (the folder papers are
 * erased first, as both sets share papers). Each scenario reads structured
 * data only, except where a check names the answer text:
 *
 * - the run's final ledger: `latestExecutionCheckpoint` over the run's events
 *   (`api.agent.getRunTrace`), as runtime.ts reads it;
 * - the digest reads: `paper_ledger_update` events whose reads have
 *   granularity "digest" (they carry partId, label, relevance and stance;
 *   the Task progress snapshot's paper rows do not project those fields);
 * - the digest records: the conversation's `paper_digest` rows in the
 *   tool-result handle store (`content.digest`, with its facets);
 * - the cited papers: `material_finalized.citedSources` (the submitted
 *   document), `final.quoteCitations` (the chat answer), and the Task
 *   progress paper rows in state "cited";
 * - the tool-call order: the run's `tool_call` events by sequence;
 * - the rounds and tokens: the run's `usage` events (see `usageOf`);
 * - the Task progress row: the driven panel's own row element and curtain.
 *
 * Every failed check goes into the scenario's `violations`, the scenario
 * writes `<scenario>-<n>.json` (and `<scenario>-<n>.answer.md`) into
 * LLM_FOR_ZOTERO_PERF_REPORT_DIR, and the `it` then asserts that
 * `violations` is empty. No check asserts an exact number of parts or tool
 * calls, and no check sets a time limit: wall time is recorded only.
 * Missing env vars, fixtures or credentials skip the tests (not run).
 * The suite erases the items and collections it seeded when it ends.
 *
 * Fixture JSON (`name.json`, plus `name.md` and `name.pdf` unless
 * `metadataOnly: true`): `title`, `date`, `creators`, and a test-only
 * `role`: N1, N2, N3, C1, C2, X1 in the folders; G (must be shortlisted),
 * P (either way), U (must not be read in depth), X (no text) in the library
 * set. Roles never reach titles, file names or collection names.
 *
 * Run (the wrapper starts a second Zotero with `-no-remote`, and the no-op
 * kill command keeps the scaffold from closing the user's own Zotero):
 *
 *   ZOTERO_PLUGIN_ZOTERO_BIN_PATH=<wrapper script: exec <zotero binary> -no-remote "$@"> \
 *   ZOTERO_PLUGIN_KILL_COMMAND=/usr/bin/true \
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/perf \
 *   LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-flash \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js with the provider> \
 *   LLM_FOR_ZOTERO_PERF_REPORT_DIR=<dir> \
 *   LLM_FOR_ZOTERO_DIGEST_PAPERS_DIR=<folder F: f01..f08 .json/.md/.pdf> \
 *   [LLM_FOR_ZOTERO_DIGEST_HELDOUT_DIR=<dir with h01 .json/.md/.pdf>] \
 *   [LLM_FOR_ZOTERO_DIGEST_LIBRARY_DIR=<dir with l01..l16 .json/.md/.pdf>] \
 *   [LLM_FOR_ZOTERO_DIGEST_SCENARIOS=1,2,3,4,5,6,1h,7] \
 *   [LLM_FOR_ZOTERO_DIGEST_REPEAT=3] \
 *   node scripts/run-workflow-tests.mjs --agent-live
 *
 * Leave LLM_FOR_ZOTERO_PERF_PAPERS_DIR unset so the 12-paper lag test in
 * this folder skips. LLM_FOR_ZOTERO_DIGEST_SCENARIOS defaults to
 * "1,2,3,4,5,6" ("1h" and "7" are opt-in and need the held-out and the
 * library directory), and LLM_FOR_ZOTERO_DIGEST_REPEAT (default 1) repeats
 * scenarios 1 and 7. The folder directory is needed only by scenarios 1-6 and
 * 1h.
 */
import { assert } from "chai";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "../agent/liveAgentCredentials";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../src/services/mineru/mineruCache";
import { latestExecutionCheckpoint } from "../../src/agent/execution/checkpoint";
import { loadPlanDocument } from "../../src/agent/documents/store";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
  OutcomeException,
} from "../../src/agent/execution/types";
import type { AgentRunEventRecord } from "../../src/agent/types";
import type { HostPaperDigest } from "../../src/agent/digests/paperDigestWorker";
import type { CollectionContextRef } from "../../src/shared/types";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const Services: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const MODEL_ENTRY_ID = "live-digest-model";
/** As the 12-paper lag test: one turn may take up to 14 minutes. */
const TURN_TIMEOUT_MS = 840_000;
/** How often the turn is checked for an approval request to deny. */
const APPROVAL_POLL_MS = 2_000;
/** `PAPER_DIGEST_HANDLE_TOOL` in src/agent/digests/digestJobHost.ts. */
const PAPER_DIGEST_HANDLE_TOOL = "paper_digest";
/** Characters of a title that count as naming the paper. */
const TITLE_HEAD_CHARS = 30;
const FOLDER_NAME = "Navigation reading list";
const HELDOUT_FOLDER_NAME = "Navigation papers";
const FIXTURE_ROLES = [
  "N1",
  "N2",
  "N3",
  "C1",
  "C2",
  "X1",
  "G",
  "P",
  "U",
  "X",
] as const;
type Role = (typeof FIXTURE_ROLES)[number];

function env(name: string): string {
  try {
    return String(Services.env.get(name) || "").trim();
  } catch {
    return "";
  }
}

const reportDir = env("LLM_FOR_ZOTERO_PERF_REPORT_DIR");
const papersDir = env("LLM_FOR_ZOTERO_DIGEST_PAPERS_DIR");
const heldoutDir = env("LLM_FOR_ZOTERO_DIGEST_HELDOUT_DIR");
const libraryDir = env("LLM_FOR_ZOTERO_DIGEST_LIBRARY_DIR");
const requestedModel = env("LLM_FOR_ZOTERO_LIVE_MODEL") || "deepseek-flash";
const selectedScenarios = (
  env("LLM_FOR_ZOTERO_DIGEST_SCENARIOS") || "1,2,3,4,5,6"
)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const scenarioOneRepeat = Math.max(
  1,
  Math.floor(Number(env("LLM_FOR_ZOTERO_DIGEST_REPEAT") || 1)) || 1,
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type FixtureMeta = {
  title?: string;
  date?: string;
  creators?: Array<{ firstName?: string; lastName?: string }>;
  role?: string;
  metadataOnly?: boolean;
};

type FixtureFile = {
  dir: string;
  name: string;
  meta: FixtureMeta;
  role: Role;
  hasText: boolean;
};

type SeededPaper = {
  name: string;
  role: Role;
  title: string;
  itemId: number;
  hasText: boolean;
  /** First author's last name and year, for an author-year mention. */
  firstAuthor?: string;
  year?: string;
};

/** The papers a scenario runs over: a folder's, or the whole library's. */
type SeededSet = {
  /** The folder attached as context; null for the whole library. */
  ref: CollectionContextRef | null;
  libraryID: number;
  papers: SeededPaper[];
};

/** The fixture files of one directory, or why they cannot be used. */
async function readFixtureDir(
  dir: string,
): Promise<{ files: FixtureFile[]; problems: string[] }> {
  const problems: string[] = [];
  if (!(await IOUtils.exists(dir))) {
    return { files: [], problems: [`${dir} does not exist`] };
  }
  const names = ((await IOUtils.getChildren(dir)) as string[])
    .map((path) => String(PathUtils.filename(path)))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .sort();
  const files: FixtureFile[] = [];
  for (const name of names) {
    let meta: FixtureMeta;
    try {
      meta = JSON.parse(
        String(await IOUtils.readUTF8(PathUtils.join(dir, `${name}.json`))),
      ) as FixtureMeta;
    } catch (error) {
      problems.push(`${name}.json is not JSON: ${String(error)}`);
      continue;
    }
    const role = String(meta.role || "") as Role;
    if (!FIXTURE_ROLES.includes(role)) {
      problems.push(`${name}.json has no known role`);
      continue;
    }
    if (!String(meta.title || "").trim()) {
      problems.push(`${name}.json has no title`);
      continue;
    }
    const hasText = meta.metadataOnly !== true;
    if (hasText) {
      for (const extension of ["md", "pdf"]) {
        if (
          !(await IOUtils.exists(PathUtils.join(dir, `${name}.${extension}`)))
        )
          problems.push(`${name}.${extension} is missing`);
      }
    }
    files.push({ dir, name, meta, role, hasText });
  }
  return { files, problems };
}

/** Why folder F cannot run the scenarios, or "" when it can. */
function folderProblem(files: FixtureFile[]): string {
  const count = (role: Role) => files.filter((f) => f.role === role).length;
  const problems: string[] = [];
  for (const role of ["C1", "C2", "X1"] as const) {
    if (count(role) !== 1)
      problems.push(`${count(role)} papers with role ${role}, expected 1`);
  }
  if (count("N1") + count("N2") < 2)
    problems.push("fewer than two papers with role N1 or N2");
  if (files.some((f) => f.role === "X1" && f.hasText))
    problems.push("the X1 paper must be metadataOnly");
  return problems.join("; ");
}

/** Why the library set cannot run scenario 7, or "" when it can. */
function libraryProblem(files: FixtureFile[]): string {
  const count = (role: Role) => files.filter((f) => f.role === role).length;
  const problems: string[] = [];
  if (count("G") !== 1)
    problems.push(`${count("G")} papers with role G, expected 1`);
  if (count("U") < 3)
    problems.push(`${count("U")} papers with role U, expected at least 3`);
  if (count("X") !== 1)
    problems.push(`${count("X")} papers with role X, expected 1`);
  if (files.some((f) => f.role === "G" && !f.hasText))
    problems.push("the G paper must have text");
  if (files.some((f) => f.role === "X" && f.hasText))
    problems.push("the X paper must be metadataOnly");
  const others = files.filter((f) => !["G", "P", "U", "X"].includes(f.role));
  if (others.length)
    problems.push(
      `papers with folder roles: ${others.map((f) => f.name).join(", ")}`,
    );
  return problems.join("; ");
}

/** Saves one fixture paper into the given collections, with its text. */
async function seedPaper(
  file: FixtureFile,
  libraryID: number,
  collectionIds: number[],
): Promise<SeededPaper> {
  const { meta } = file;
  const title = String(meta.title);
  const item = new Zotero.Item("journalArticle");
  item.libraryID = libraryID;
  item.setField("title", title);
  item.setField("date", String(meta.date || "").slice(0, 4));
  item.setCreators(
    (meta.creators || []).map((creator) => ({
      creatorType: "author",
      firstName: creator.firstName || "",
      lastName: creator.lastName || "",
    })),
  );
  item.setCollections(collectionIds);
  const itemId = Number(await item.saveTx());
  if (file.hasText) {
    const markdown = String(
      await IOUtils.readUTF8(PathUtils.join(file.dir, `${file.name}.md`)),
    );
    const attachment = await Zotero.Attachments.importFromFile({
      file: PathUtils.join(file.dir, `${file.name}.pdf`),
      parentItemID: itemId,
      contentType: "application/pdf",
    });
    await writeMineruCacheFiles(attachment.id, markdown, [
      { relativePath: "full.md", data: new TextEncoder().encode(markdown) },
    ]);
    await writeMineruSourceProvenanceForAttachment(attachment);
  }
  return {
    name: file.name,
    role: file.role,
    title,
    itemId,
    hasText: file.hasText,
    firstAuthor: String(file.meta.creators?.[0]?.lastName || "").trim(),
    year: String(file.meta.date || "").slice(0, 4),
  };
}

async function createCollection(
  libraryID: number,
  name: string,
): Promise<{ id: number; name: string }> {
  const collection = new Zotero.Collection();
  collection.libraryID = libraryID;
  collection.name = name;
  await collection.saveTx();
  return { id: Number(collection.id), name };
}

// ---------------------------------------------------------------------------
// Text and identities
// ---------------------------------------------------------------------------

/** Lowercase, plain-quote, no-emphasis, whitespace-collapsed text. */
function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[*_`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function titleHead(title: string): string {
  return normalizeText(title).slice(0, TITLE_HEAD_CHARS).trim();
}

function clip(value: string | undefined, max: number): string {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function targetOf(paper: SeededPaper): string {
  return `item:${paper.itemId}`;
}

function itemIdOfTarget(target: string): number {
  const match = /^item:(\d+)$/.exec(target);
  return match ? Number(match[1]) : 0;
}

/** The regular item an attachment belongs to, else the item itself. */
function regularItemId(itemId: number): number {
  const item = itemId > 0 ? Zotero.Items.get(itemId) : null;
  return item?.isAttachment?.() && item.parentItemID
    ? Number(item.parentItemID)
    : itemId;
}

// ---------------------------------------------------------------------------
// What one scenario's run produced
// ---------------------------------------------------------------------------

type Judgment = { value: string; reason: string };

type DigestRead = {
  partId?: string;
  label?: string;
  /** A digest with an answer; false for a failed digest. */
  ok: boolean;
  answer?: string;
  failure?: string;
  relevance?: Judgment;
  stance?: Judgment;
};

type ToolCallRecord = {
  seq: number;
  callId: string;
  name: string;
  /** From the call's tool_result or tool_error; null when neither arrived. */
  ok: boolean | null;
  /** A task_update call that declares a digest part. */
  digest: boolean;
  /** The expectedEffect of every part a task_update call declares. */
  effects: string[];
};

/** The run's model rounds and tokens, from its `usage` events. */
type UsageSummary = {
  rounds: number;
  inputTokens: number;
  outputTokens: number;
};

/** The Task progress row of the driven panel, as the user sees it. */
type TaskProgressRowView = {
  /** The row is down: its curtain open and the row not hidden. */
  shown: boolean;
  curtain: string;
  hidden: boolean;
  /** The row's status word (idle, working, done, ...). */
  state: string;
  /** Its count text ("2/3 steps"). */
  count: string;
};

type TaskProgressSnapshot = ReturnType<
  WorkflowTestApi["getTaskProgressSnapshot"]
>;

type ScenarioData = {
  collection: SeededSet;
  conversationKey: number;
  runId: string | null;
  runStatus: string | null;
  ledger: ExecutionCheckpoint | undefined;
  tasks: readonly ExecutionCheckpointTask[];
  /** Parts no other part replaced. */
  standing: readonly ExecutionCheckpointTask[];
  endState: string | undefined;
  /** Notes for the report that are not failures. */
  warnings: string[];
  toolCalls: ToolCallRecord[];
  digestReads: Map<number, DigestRead[]>;
  /** Papers this run read in depth (`isInDepthRead`), by regular item id. */
  inDepth: Set<number>;
  digestRecords: HostPaperDigest[];
  cited: {
    document: Set<number>;
    answer: Set<number>;
    rows: Set<number>;
    all: Set<number>;
  };
  /** The answer, the final event text and the documents, normalized. */
  text: string;
  answerText: string;
  snapshot: TaskProgressSnapshot;
  usage: UsageSummary;
  /** Null when the panel's row element was not found. */
  row: TaskProgressRowView | null;
};

function judgment(value: unknown, field: "level" | "position") {
  const record = value as Record<string, unknown> | null | undefined;
  const label = record?.[field];
  return typeof label === "string" && label
    ? { value: label, reason: String(record?.reason || "") }
    : undefined;
}

/** Each paper's digest reads in this run, by regular item id. */
function digestReadsOf(
  events: readonly AgentRunEventRecord[],
): Map<number, DigestRead[]> {
  const byItem = new Map<number, DigestRead[]>();
  for (const event of events) {
    const payload = event.payload;
    if (payload?.type !== "paper_ledger_update") continue;
    for (const read of payload.delta?.reads || []) {
      if (read.granularity !== "digest") continue;
      const itemId = Number(String(read.key || "").split(":")[1]) || 0;
      if (!itemId) continue;
      const answer = String(read.snippet || "").trim();
      const entry: DigestRead = {
        ...(read.partId ? { partId: read.partId } : {}),
        ...(read.label ? { label: read.label } : {}),
        ok: Boolean(answer),
        ...(answer ? { answer } : { failure: String(read.whyMatched || "") }),
      };
      const relevance = judgment(read.relevance, "level");
      if (relevance) entry.relevance = relevance;
      const stance = judgment(read.stance, "position");
      if (stance) entry.stance = stance;
      const list = byItem.get(itemId) || [];
      list.push(entry);
      byItem.set(itemId, list);
    }
  }
  return byItem;
}

/**
 * A read that took in the paper's text: a digest with an answer, or a
 * paper_read of the whole text or of its overview body (not its metadata,
 * abstract or outline, and not a targeted passage).
 */
function isInDepthRead(read: {
  toolName?: string;
  granularity?: string;
  method?: string;
  snippet?: string;
}): boolean {
  if (read.granularity === "digest")
    return Boolean(String(read.snippet || "").trim());
  if (read.toolName !== "paper_read") return false;
  return (
    read.granularity === "full" ||
    ((read.granularity === "passage" || read.granularity === "section") &&
      (read.method === "overview" || read.method === "full"))
  );
}

function inDepthOf(events: readonly AgentRunEventRecord[]): Set<number> {
  const items = new Set<number>();
  for (const event of events) {
    const payload = event.payload;
    if (payload?.type !== "paper_ledger_update") continue;
    for (const read of payload.delta?.reads || []) {
      const itemId = Number(String(read.key || "").split(":")[1]) || 0;
      if (itemId && isInDepthRead(read)) items.add(itemId);
    }
  }
  return items;
}

/** The expectedEffect of every part a task_update call's args declare. */
function declaredEffects(args: unknown): string[] {
  const tasks = (args as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map(
      (task) => (task as { expectedEffect?: unknown } | null)?.expectedEffect,
    )
    .filter((effect): effect is string => typeof effect === "string");
}

function toolCallsOf(events: readonly AgentRunEventRecord[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  const byCallId = new Map<string, ToolCallRecord>();
  for (const event of events) {
    const payload = event.payload;
    if (payload?.type === "tool_call") {
      const effects =
        payload.name === "task_update" ? declaredEffects(payload.args) : [];
      const call: ToolCallRecord = {
        seq: event.seq,
        callId: payload.callId,
        name: payload.name,
        ok: null,
        digest: effects.includes("digest"),
        effects,
      };
      calls.push(call);
      byCallId.set(payload.callId, call);
    } else if (payload?.type === "tool_result") {
      const call = byCallId.get(payload.callId);
      if (call && call.ok !== false) call.ok = payload.ok;
    } else if (payload?.type === "tool_error") {
      const call = byCallId.get(payload.callId);
      if (call) call.ok = false;
    }
  }
  return calls;
}

/**
 * The run's model rounds and tokens from its `usage` events. A round's
 * counters are cumulative within the round (runtime.ts `onUsage`), so each
 * round counts its largest report. Input per report: cacheReadTokens +
 * cacheMissTokens when cacheMissTokens > 0, else promptTokens +
 * cacheReadTokens; output: completionTokens. Rounds: the largest `round`.
 */
function usageOf(events: readonly AgentRunEventRecord[]): UsageSummary {
  const perRound = new Map<number, { input: number; output: number }>();
  let rounds = 0;
  for (const event of events) {
    const payload = event.payload;
    if (payload?.type !== "usage" || !("round" in payload)) continue;
    const round = Number(payload.round) || 0;
    rounds = Math.max(rounds, round);
    const prompt = Number(payload.promptTokens) || 0;
    const read = Number(payload.cacheReadTokens) || 0;
    const miss = Number(payload.cacheMissTokens) || 0;
    const input = miss > 0 ? read + miss : prompt + read;
    const output = Number(payload.completionTokens) || 0;
    const previous = perRound.get(round) || { input: 0, output: 0 };
    perRound.set(round, {
      input: Math.max(previous.input, input),
      output: Math.max(previous.output, output),
    });
  }
  let inputTokens = 0;
  let outputTokens = 0;
  for (const totals of perRound.values()) {
    inputTokens += totals.input;
    outputTokens += totals.output;
  }
  return { rounds, inputTokens, outputTokens };
}

/** The conversation's complete digest records in the handle store. */
async function digestRecordsOf(
  conversationKey: number,
): Promise<HostPaperDigest[]> {
  let rows: any[] = [];
  try {
    rows =
      (await Zotero.DB.queryAsync(
        "SELECT content_json AS contentJson FROM llm_for_zotero_agent_tool_result_handles WHERE conversation_key = ? AND tool_name = ? ORDER BY created_at",
        [conversationKey, PAPER_DIGEST_HANDLE_TOOL],
      )) || [];
  } catch (error) {
    if (!/no such table/i.test(String(error))) throw error;
  }
  const records: HostPaperDigest[] = [];
  for (const row of rows) {
    try {
      const content = JSON.parse(String(row.contentJson || "null")) as {
        digest?: HostPaperDigest;
      } | null;
      const digest = content?.digest;
      if (
        digest &&
        digest.schema === 2 &&
        typeof digest.answer === "string" &&
        digest.answer.trim()
      )
        records.push(digest);
    } catch {
      // A row that is not JSON is no digest record.
    }
  }
  return records;
}

/** The newest run of the conversation, once it is no longer running. */
async function settledRun(
  conversationKey: number,
): Promise<{ runId: string; status: string } | null> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const rows = await Zotero.DB.queryAsync(
      "SELECT run_id, status FROM llm_for_zotero_agent_runs WHERE conversation_key = ? ORDER BY created_at DESC LIMIT 1",
      [conversationKey],
    );
    const row = rows?.[0];
    if (!row) return null;
    const run = { runId: String(row.run_id), status: String(row.status) };
    if (run.status !== "running" || Date.now() > deadline) return run;
    await Zotero.Promise.delay(500);
  }
}

async function runEvents(runId: string): Promise<AgentRunEventRecord[]> {
  const trace = (await Zotero.LLMForZotero.api.agent.getRunTrace(runId)) as {
    events?: AgentRunEventRecord[];
  } | null;
  return trace?.events || [];
}

async function gatherScenarioData(params: {
  collection: SeededSet;
  conversationKey: number;
  answerText: string;
  warnings: string[];
  row: TaskProgressRowView | null;
}): Promise<ScenarioData> {
  const { conversationKey, warnings } = params;
  const api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
  const run = await settledRun(conversationKey);
  let events = run ? await runEvents(run.runId) : [];
  let ledger = latestExecutionCheckpoint(events);
  // The ledger's end is written as the run settles; give it a moment.
  for (let tries = 0; run && ledger && !ledger.end && tries < 20; tries++) {
    await Zotero.Promise.delay(500);
    events = await runEvents(run.runId);
    ledger = latestExecutionCheckpoint(events);
  }
  if (run && ledger && !ledger.end)
    warnings.push("the run's ledger has no end state");
  const tasks = ledger?.tasks || [];
  const libraryID = params.collection.libraryID;

  const document = new Set<number>();
  const answer = new Set<number>();
  const texts = [params.answerText];
  const documentIds = new Set<string>();
  for (const event of events) {
    const payload = event.payload;
    if (payload?.type === "material_finalized") {
      if (payload.materialRef?.documentId)
        documentIds.add(payload.materialRef.documentId);
      for (const source of payload.citedSources || []) {
        const id =
          Number(source.itemId) > 0
            ? Number(source.itemId)
            : Number(
                Zotero.Items.getIDFromLibraryAndKey(
                  source.libraryID || libraryID,
                  source.itemKey,
                ),
              ) || 0;
        if (id > 0) document.add(regularItemId(id));
      }
    } else if (payload?.type === "final") {
      texts.push(payload.text || "");
      if (payload.documentId) documentIds.add(payload.documentId);
      for (const citation of payload.quoteCitations || []) {
        const id = Number(citation.itemId || citation.contextItemId) || 0;
        if (id > 0) answer.add(regularItemId(id));
      }
    }
  }
  for (const documentId of documentIds) {
    try {
      const loaded = await loadPlanDocument(documentId);
      if (loaded) texts.push(loaded.title || "", loaded.visibleMarkdown || "");
    } catch (error) {
      warnings.push(`document ${documentId} could not be loaded: ${error}`);
    }
  }
  const snapshot = api.getTaskProgressSnapshot(conversationKey);
  const rows = new Set<number>();
  for (const [key, row] of Object.entries(snapshot?.paperRows || {})) {
    const itemId = Number(key.split(":")[1]) || 0;
    if (itemId > 0 && row.state === "cited") rows.add(itemId);
  }
  return {
    collection: params.collection,
    conversationKey,
    runId: run?.runId || null,
    runStatus: run?.status || null,
    ledger,
    tasks,
    standing: tasks.filter((task) => !task.supersededBy),
    endState: ledger?.end?.state,
    warnings,
    toolCalls: toolCallsOf(events),
    digestReads: digestReadsOf(events),
    inDepth: inDepthOf(events),
    digestRecords: await digestRecordsOf(conversationKey),
    cited: {
      document,
      answer,
      rows,
      all: new Set([...document, ...answer, ...rows]),
    },
    text: normalizeText(texts.join("\n")),
    answerText: params.answerText,
    snapshot,
    usage: usageOf(events),
    row: params.row,
  };
}

/**
 * The driven panel's Task progress row, read from its own elements once the
 * row settles (it may still be lowering when the turn ends): down means the
 * curtain is open and the row is not hidden.
 */
async function readTaskProgressRow(
  panelId: string,
): Promise<TaskProgressRowView | null> {
  const api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
  const probe = (): TaskProgressRowView | null => {
    const root = Zotero.getMainWindow()?.document?.querySelector(
      `[data-workflow-panel-id="${panelId}"]`,
    );
    const row = root?.querySelector("#llm-task-progress") as
      | HTMLElement
      | null
      | undefined;
    if (!root || !row) return null;
    const curtain = root.querySelector(".llm-task-progress-curtain") as
      | HTMLElement
      | null
      | undefined;
    const state = curtain?.dataset.curtain || "";
    return {
      shown: !row.hidden && state === "open",
      curtain: state,
      hidden: row.hidden,
      state: row.dataset.state || "",
      count:
        root.querySelector(".llm-task-progress-count")?.textContent?.trim() ||
        "",
    };
  };
  const deadline = Date.now() + 5_000;
  for (;;) {
    api.flushTaskProgress();
    const view = probe();
    if (!view || view.shown || Date.now() > deadline) return view;
    await Zotero.Promise.delay(100);
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type Check = (ok: unknown, message: string) => void;

function paperWithRole(data: ScenarioData, role: Role): SeededPaper {
  const paper = data.collection.papers.find((p) => p.role === role);
  if (!paper) throw new Error(`the folder has no ${role} paper`);
  return paper;
}

function describePaper(paper: SeededPaper): string {
  return `${paper.name} (${paper.role}, "${clip(paper.title, 50)}")`;
}

function readsOf(data: ScenarioData, paper: SeededPaper): DigestRead[] {
  return data.digestReads.get(paper.itemId) || [];
}

function allDigestReads(data: ScenarioData): DigestRead[] {
  return [...data.digestReads.values()].flat();
}

function answered(data: ScenarioData, paper: SeededPaper): boolean {
  return readsOf(data, paper).some((read) => read.ok);
}

/**
 * Whether the text names the paper: its title head, or its first author
 * followed within a short span by its year ("Bond and Lang (2014)").
 */
function namesPaper(data: ScenarioData, paper: SeededPaper): boolean {
  const head = titleHead(paper.title);
  if (head && data.text.includes(head)) return true;
  const author = normalizeText(paper.firstAuthor || "");
  if (!author || !/^\d{4}$/.test(paper.year || "")) return false;
  const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b[^\\n]{0,60}?${paper.year}`).test(
    data.text,
  );
}

/** Relevance levels the digests gave the paper, in reads and records. */
function relevanceLevels(data: ScenarioData, paper: SeededPaper): string[] {
  return [
    ...readsOf(data, paper).map((read) => read.relevance?.value),
    ...data.digestRecords
      .filter((record) => record.itemId === paper.itemId)
      .map((record) => record.relevance?.level),
  ].filter((level): level is string => Boolean(level));
}

function exclusionsOf(
  tasks: readonly ExecutionCheckpointTask[],
  paper: SeededPaper,
): Array<{ task: ExecutionCheckpointTask; exclusion: OutcomeException }> {
  return tasks.flatMap((task) =>
    (task.excludedTargets || [])
      .filter((exclusion) => exclusion.targets.includes(targetOf(paper)))
      .map((exclusion) => ({ task, exclusion })),
  );
}

/** Scenario 1 and its held-out variant: the misfiled paper is left out. */
function checkMisfiledPaper(data: ScenarioData, check: Check): void {
  const c1 = paperWithRole(data, "C1");
  const c2 = paperWithRole(data, "C2");
  const x1 = paperWithRole(data, "X1");
  const withText = data.collection.papers.filter((paper) => paper.hasText);

  // Some digest part covers the folder (X1, which has no text, has its own
  // check below). The agent may instead read the papers itself; then the
  // per-paper verdict checks do not apply, and only its decision is checked.
  const digestParts = data.tasks.filter((task) => task.effect === "digest");
  const digested = digestParts.length > 0;
  if (!digested)
    data.warnings.push(
      "no digest part was declared: the agent read the papers itself, so the per-paper verdict checks were skipped",
    );
  const verdictCheck: Check = (ok, message) => {
    if (digested) check(ok, message);
  };
  const digestTargets = new Set(
    digestParts.flatMap((task) => task.targets || []),
  );
  const uncovered = withText.filter(
    (paper) => !digestTargets.has(targetOf(paper)),
  );
  verdictCheck(
    !uncovered.length,
    `no digest part covers: ${uncovered.map(describePaper).join("; ")}`,
  );
  for (const paper of withText) {
    verdictCheck(
      answered(data, paper),
      `${describePaper(paper)} has no digest read with an answer`,
    );
  }

  // X1: a digest failure or named in the answer, never judged irrelevant.
  const x1Failed =
    readsOf(data, x1).some((read) => !read.ok) ||
    digestParts.some((task) =>
      (task.exceptions || []).some((exception) =>
        exception.targets.includes(targetOf(x1)),
      ),
    );
  verdictCheck(
    x1Failed || namesPaper(data, x1),
    `${describePaper(x1)} has no digest failure and the answer does not name it`,
  );
  check(
    !relevanceLevels(data, x1).includes("none"),
    `${describePaper(x1)} has relevance "none" without text`,
  );

  // C1: judged irrelevant with a reason, excluded with a reason, not cited,
  // named in the answer.
  const c1Judged = readsOf(data, c1).filter((read) => read.relevance);
  verdictCheck(
    c1Judged.some(
      (read) =>
        read.ok &&
        read.relevance?.value === "none" &&
        read.relevance.reason.trim(),
    ),
    `${describePaper(c1)} has no digest relevance "none" with a reason (relevance: ${
      c1Judged.map((read) => read.relevance?.value).join(", ") || "none given"
    })`,
  );
  check(
    c1Judged.every((read) => read.relevance?.value === "none"),
    `${describePaper(c1)} has a digest relevance other than "none": ${c1Judged
      .map((read) => read.relevance?.value)
      .join(", ")}`,
  );
  // The review is an artifact (a document) or a reasoning part (the answer).
  const synthesis = data.standing.filter(
    (task) => task.effect === "artifact" || task.effect === "answer",
  );
  const c1Excluded = exclusionsOf(synthesis, c1);
  check(
    c1Excluded.some(({ exclusion }) => exclusion.reason.trim()),
    `${describePaper(c1)} is not in a review part's excludedTargets with a reason`,
  );
  // Missing text is never a reason to leave a paper out; the skill says to
  // name it as not read. A model that excludes it anyway is noted.
  if (exclusionsOf(synthesis, x1).length)
    data.warnings.push(`${describePaper(x1)} was excluded for missing text`);
  check(!data.cited.all.has(c1.itemId), `${describePaper(c1)} is cited`);
  check(
    namesPaper(data, c1),
    `the answer and document do not name ${describePaper(c1)} (looked for "${titleHead(c1.title)}")`,
  );

  // C2: relevant across fields, never excluded.
  check(
    !relevanceLevels(data, c2).includes("none"),
    `${describePaper(c2)} has relevance "none"`,
  );
  const c2Excluded = exclusionsOf(data.standing, c2);
  check(
    !c2Excluded.length,
    `${describePaper(c2)} is excluded: ${c2Excluded
      .map(({ exclusion }) => exclusion.reason)
      .join(" | ")}`,
  );

  // The papers on the question are cited.
  const core = data.collection.papers.filter(
    (paper) => paper.role === "N1" || paper.role === "N2",
  );
  const coreCited = core.filter((paper) => data.cited.all.has(paper.itemId));
  check(
    coreCited.length >= 2,
    `${coreCited.length} of the N1/N2 papers are cited, expected at least 2`,
  );

  // The run ends completed, or with exceptions that name only X1.
  if (data.endState === "completed_with_exceptions") {
    for (const task of data.standing) {
      // A synthesis or digest part must complete. A side part the agent
      // planned and then skipped (a listing, a read) is planning noise,
      // reported as a warning, not as the selection failing.
      const ended = `part ${task.taskId} ended ${task.status}${task.reason ? `: ${task.reason}` : ""}`;
      // A digest part over the unreadable X1 alone (a retry) ends skipped
      // with the host's reason; that is the honest end for it.
      const onlyX1 =
        (task.targets || []).length > 0 &&
        (task.targets || []).every((target) => target === targetOf(x1));
      if (task.effect === "digest" && onlyX1) {
        if (task.status !== "completed") data.warnings.push(ended);
      } else if (
        ["artifact", "answer", "digest"].includes(task.effect || "answer")
      )
        check(task.status === "completed", ended);
      else if (task.status !== "completed") data.warnings.push(ended);
      for (const exception of task.exceptions || []) {
        check(
          exception.targets.length &&
            exception.targets.every((target) => target === targetOf(x1)),
          `part ${task.taskId} has an exception that does not name only X1: ${exception.targets.join(", ")} (${exception.reason})`,
        );
      }
    }
  } else {
    check(
      data.endState === "completed",
      `the run ended ${data.endState || "without an end state"}`,
    );
  }
}

/** Scenario 2: every paper is summarized; nothing is left out. */
function checkPairedRequest(data: ScenarioData, check: Check): void {
  const c1 = paperWithRole(data, "C1");
  check(
    answered(data, c1),
    `${describePaper(c1)} has no digest read with an answer`,
  );
  const excluding = data.tasks.filter(
    (task) => (task.excludedTargets || []).length,
  );
  check(
    !excluding.length,
    `parts with excludedTargets: ${excluding
      .map(
        (task) =>
          `${task.taskId} (${(task.excludedTargets || [])
            .map((exclusion) => exclusion.reason)
            .join(" | ")})`,
      )
      .join("; ")}`,
  );
  check(
    namesPaper(data, c1),
    `the answer does not name ${describePaper(c1)} (looked for "${titleHead(c1.title)}")`,
  );
}

/** Scenario 3: per-paper evidence reads carry the part label and relevance. */
function checkEvidencePerPaper(data: ScenarioData, check: Check): void {
  const reads = allDigestReads(data);
  check(reads.length, "no digest read was recorded");
  const unlabeled = reads.filter((read) => !String(read.label || "").trim());
  check(!unlabeled.length, `${unlabeled.length} digest reads have no label`);
  const papersWithout = [...data.digestReads.entries()]
    .filter(([, list]) => list.some((read) => read.ok && !read.relevance))
    .map(([itemId]) => itemId);
  check(
    !papersWithout.length,
    `successful digest reads without a relevance on items: ${papersWithout.join(", ")}`,
  );
}

/** Scenario 4: shortlist first, then a review from the folder only. */
function checkRetrieveSelectReview(data: ScenarioData, check: Check): void {
  const c1 = paperWithRole(data, "C1");
  const submit = data.toolCalls.find((call) => call.name === "submit_document");
  const before = data.toolCalls.filter(
    (call) =>
      (!submit || call.seq < submit.seq) &&
      call.ok !== false &&
      (call.name === "library_retrieve" ||
        (call.name === "task_update" && call.digest)),
  );
  check(
    before.length,
    submit
      ? "no library_retrieve or digest task_update call precedes submit_document"
      : "no library_retrieve or digest task_update call was made",
  );
  const inFolder = new Set(data.collection.papers.map((p) => p.itemId));
  const outside = [...data.cited.all].filter((id) => !inFolder.has(id));
  check(
    !outside.length,
    `cited papers outside the folder: ${outside
      .map(
        (id) =>
          `item:${id} "${clip(Zotero.Items.get(id)?.getField?.("title"), 50)}"`,
      )
      .join("; ")}`,
  );
  check(!data.cited.all.has(c1.itemId), `${describePaper(c1)} is cited`);
  check(data.cited.all.size, "no paper is cited");
}

/** Scenario 5: a stance on the idea for every paper analyzed. */
function checkVagueIdea(data: ScenarioData, check: Check): void {
  const reads = allDigestReads(data);
  check(reads.length, "no digest read was recorded");
  const papersWithout = [...data.digestReads.entries()]
    .filter(([, list]) => list.some((read) => read.ok && !read.stance))
    .map(([itemId]) => itemId);
  check(
    !papersWithout.length,
    `successful digest reads without a stance on items: ${papersWithout.join(", ")}`,
  );
  const core = data.collection.papers.filter(
    (paper) => paper.role === "N1" || paper.role === "N2",
  );
  check(
    core.some((paper) =>
      readsOf(data, paper).some(
        (read) =>
          read.ok &&
          (read.stance?.value === "supports" || read.stance?.value === "mixed"),
      ),
    ),
    'no N1/N2 paper has the stance "supports" or "mixed"',
  );
}

/** Scenario 6: comparison dimensions come back as facets. */
function checkComparison(data: ScenarioData, check: Check): void {
  check(data.digestRecords.length, "no digest record is in the handle store");
  const thin = data.digestRecords.filter(
    (record) => (record.facets || []).length < 2,
  );
  check(
    !thin.length,
    `digest records with fewer than two facets: ${thin
      .map(
        (record) => `item:${record.itemId} (${(record.facets || []).length})`,
      )
      .join(", ")}`,
  );
}

/**
 * The papers the agent chose to read in depth: the targets of its digest
 * and read parts declared over explicit targets (not scope:true), replaced
 * parts included, in first-declared order.
 */
function shortlistOf(data: ScenarioData): string[] {
  const targets = data.tasks
    .filter(
      (task) =>
        (task.effect === "digest" || task.effect === "read") && !task.scope,
    )
    .flatMap((task) => task.targets || []);
  return [...new Set(targets)];
}

/** Scenario 7: a question over the whole library, nothing attached. */
function checkWholeLibrary(data: ScenarioData, check: Check): void {
  const papers = data.collection.papers;
  const g = paperWithRole(data, "G");
  const x = paperWithRole(data, "X");
  const unrelated = papers.filter((paper) => paper.role === "U");
  const known = new Set(papers.map(targetOf));
  const list = (items: SeededPaper[]) => items.map(describePaper).join("; ");

  // The row the user sees is down: with nothing attached it shows the
  // papers read in depth, whether or not the run declared steps.
  check(data.row, "the panel has no Task progress row element");
  check(
    data.row?.shown,
    `the Task progress row is not shown after the run (curtain "${data.row?.curtain ?? ""}", hidden ${data.row?.hidden})`,
  );
  const declared = (data.snapshot?.checklist?.steps || []).filter(
    (step) => step.outcome && !step.outcome.host,
  );
  if (!declared.length)
    data.warnings.push(
      "no declared step: the papers read in depth stand for the shortlist",
    );

  // A shortlist over explicit targets, from the 16 papers.
  const inDepthParts = data.tasks.filter(
    (task) => task.effect === "digest" || task.effect === "read",
  );
  const scoped = inDepthParts.filter((task) => task.scope);
  check(
    !scoped.length,
    `digest or read parts over the whole library (scope:true): ${scoped
      .map((task) => task.taskId)
      .join(", ")}`,
  );
  // The papers the agent chose: its declared parts' targets, or, with no
  // part declared, the papers it read in depth.
  const declaredShortlist = shortlistOf(data);
  const shortlist = declaredShortlist.length
    ? declaredShortlist
    : papers.filter((paper) => data.inDepth.has(paper.itemId)).map(targetOf);
  check(
    shortlist.length,
    "no paper was chosen: no part over explicit targets and no paper read in depth",
  );
  if (shortlist.length)
    check(
      shortlist.length <= 8,
      `the shortlist has ${shortlist.length} papers, expected 1 to 8`,
    );
  const foreign = shortlist.filter((target) => !known.has(target));
  check(
    !foreign.length,
    `shortlisted targets that are not among the 16 papers: ${foreign.join(", ")}`,
  );

  // The G paper in, no U paper read in depth, the X paper honest.
  check(
    shortlist.includes(targetOf(g)),
    `${describePaper(g)} is not in the shortlist`,
  );
  const shortlistedU = unrelated.filter((paper) =>
    shortlist.includes(targetOf(paper)),
  );
  check(
    !shortlistedU.length,
    `unrelated papers in the shortlist: ${list(shortlistedU)}`,
  );
  const readU = unrelated.filter((paper) => data.inDepth.has(paper.itemId));
  check(!readU.length, `unrelated papers read in depth: ${list(readU)}`);
  const noText = (reason: string | undefined) =>
    /^no readable text/i.test(String(reason || "").trim());
  if (
    data.tasks.some(
      (task) =>
        task.effect === "digest" && (task.targets || []).includes(targetOf(x)),
    )
  )
    check(
      readsOf(data, x).some((read) => !read.ok && noText(read.failure)) ||
        data.tasks.some((task) =>
          (task.exceptions || []).some(
            (exception) =>
              exception.targets.includes(targetOf(x)) &&
              noText(exception.reason),
          ),
        ),
      `${describePaper(x)} is in a digest part but did not fail with "No readable text"`,
    );
  check(
    !relevanceLevels(data, x).includes("none"),
    `${describePaper(x)} has relevance "none" without text`,
  );

  // The paper rows show each shortlisted paper read in depth.
  for (const paper of papers) {
    if (!paper.hasText || !shortlist.includes(targetOf(paper))) continue;
    const row =
      data.snapshot?.paperRows?.[
        `${data.collection.libraryID}:${paper.itemId}`
      ];
    check(
      (row?.reads || []).some(isInDepthRead),
      `${describePaper(paper)} is shortlisted, but its row shows no digest answer or full read (row state: ${row?.state || "no row"})`,
    );
  }

  // Retrieval before the first in-depth part.
  const retrieve = data.toolCalls.find(
    (call) =>
      (call.name === "library_retrieve" || call.name === "library_search") &&
      call.ok !== false,
  );
  const declare = data.toolCalls.find(
    (call) =>
      call.name === "task_update" &&
      call.ok !== false &&
      (call.effects.includes("digest") || call.effects.includes("read")),
  );
  check(retrieve, "no library_retrieve or library_search call was made");
  if (retrieve && declare)
    check(
      retrieve.seq < declare.seq,
      "the first digest or read part was declared before any library_retrieve or library_search call",
    );

  // The answer covers the G paper and cites no U paper.
  check(
    data.cited.all.has(g.itemId) || namesPaper(data, g),
    `the answer neither cites nor names ${describePaper(g)}`,
  );
  const citedU = unrelated.filter((paper) => data.cited.all.has(paper.itemId));
  check(!citedU.length, `unrelated papers cited: ${list(citedU)}`);
}

type ScenarioSpec = {
  title: string;
  prompt: string;
  /** The folder attached as context, or the whole library with nothing. */
  collection: "folder" | "heldout" | "library";
  checks: (data: ScenarioData, check: Check) => void;
};

const SCENARIOS: Record<string, ScenarioSpec> = {
  "1": {
    title: "misfiled paper",
    prompt:
      "Using the papers in this folder, write a literature review on how the brain keeps track of position and beliefs about hidden goals during naturalistic navigation (path integration under uncertainty).",
    collection: "folder",
    checks: checkMisfiledPaper,
  },
  "2": {
    title: "paired request",
    prompt: "Summarize every paper in this folder.",
    collection: "folder",
    checks: checkPairedRequest,
  },
  "3": {
    title: "evidence per paper",
    prompt:
      "For each paper in this folder, give me the evidence that connects it to this question: how do animals combine self-motion cues to keep track of where they are?",
    collection: "folder",
    checks: checkEvidencePerPaper,
  },
  "4": {
    title: "retrieve, select, review",
    prompt:
      "Find the most relevant papers in this folder about eye movements as a window into beliefs during navigation, then write a short review from them.",
    collection: "folder",
    checks: checkRetrieveSelectReview,
  },
  "5": {
    title: "vague idea",
    prompt:
      "I have an idea: during navigation the brain keeps a probabilistic belief over its position rather than a single estimate. Which papers in this folder support or challenge it?",
    collection: "folder",
    checks: checkVagueIdea,
  },
  "6": {
    title: "comparison",
    prompt:
      "Compare the papers in this folder and tell me what they have in common.",
    collection: "folder",
    checks: checkComparison,
  },
  "1h": {
    title: "held-out misfiled paper",
    prompt:
      "From the papers in this collection, write a short review of how animals and artificial agents estimate their own position from self-motion when landmarks are absent.",
    collection: "heldout",
    checks: checkMisfiledPaper,
  },
  "7": {
    title: "whole library",
    prompt:
      "Find the papers in my library that use eye movements or gaze to study what an animal believes or infers during navigation, and summarize what each one found.",
    collection: "library",
    checks: checkWholeLibrary,
  },
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function write(name: string, value: unknown): Promise<void> {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  await IOUtils.writeUTF8(PathUtils.join(reportDir, name), text);
}

function scenarioReport(data: ScenarioData, label: (target: string) => string) {
  const exceptionsOf = (list: readonly OutcomeException[] | undefined) =>
    (list || []).map((entry) => ({
      targets: entry.targets.map(label),
      reason: entry.reason,
    }));
  const nameOf = (id: number) => label(`item:${id}`);
  const rowOf = (paper: SeededPaper) =>
    data.snapshot?.paperRows?.[`${data.collection.libraryID}:${paper.itemId}`];
  return {
    runId: data.runId,
    runStatus: data.runStatus,
    endState: data.endState || null,
    usage: data.usage,
    shortlist: shortlistOf(data).map((target) => ({
      target,
      paper: label(target),
    })),
    parts: data.tasks.map((task) => ({
      taskId: task.taskId,
      effect: task.effect || "answer",
      status: task.status,
      description: clip(task.description, 240),
      ...(task.scope ? { scope: true } : {}),
      targets: (task.targets || []).map(label),
      done: (task.doneTargets || []).map(label),
      exceptions: exceptionsOf(task.exceptions),
      excluded: exceptionsOf(task.excludedTargets),
      ...(task.supersededBy ? { supersededBy: task.supersededBy } : {}),
      ...(task.reason ? { reason: task.reason } : {}),
      ...(task.question ? { question: clip(task.question, 200) } : {}),
    })),
    toolCalls: data.toolCalls.map((call) => ({
      seq: call.seq,
      name: call.name,
      ok: call.ok,
      ...(call.digest ? { digest: true } : {}),
    })),
    papers: data.collection.papers.map((paper) => ({
      name: paper.name,
      role: paper.role,
      itemId: paper.itemId,
      title: paper.title,
      hasText: paper.hasText,
      rowState: rowOf(paper)?.state || null,
      readInDepth: data.inDepth.has(paper.itemId),
      cited: data.cited.all.has(paper.itemId),
      excluded: exclusionsOf(data.tasks, paper).map(({ task, exclusion }) => ({
        taskId: task.taskId,
        reason: exclusion.reason,
      })),
      digestReads: readsOf(data, paper).map((read) => ({
        ...(read.partId ? { partId: read.partId } : {}),
        label: read.label ?? null,
        ok: read.ok,
        ...(read.answer ? { answerHead: clip(read.answer, 200) } : {}),
        ...(read.failure !== undefined ? { failure: read.failure } : {}),
        relevance: read.relevance || null,
        stance: read.stance || null,
      })),
      digestRecords: data.digestRecords
        .filter((record) => record.itemId === paper.itemId)
        .map((record) => ({
          facets: (record.facets || []).map((facet) => facet.label),
          relevance: record.relevance || null,
          stance: record.stance || null,
          gaps: (record.gaps || []).length,
          evidence: (record.evidence || []).length,
          answerHead: clip(record.answer, 200),
        })),
    })),
    cited: {
      document: [...data.cited.document].map(nameOf),
      answer: [...data.cited.answer].map(nameOf),
      rows: [...data.cited.rows].map(nameOf),
    },
    taskProgressRow: data.row,
    taskProgressPlanSeen: data.snapshot?.planSeen ?? null,
    taskProgress: data.snapshot?.checklist
      ? {
          end: data.snapshot.checklist.end || null,
          steps: data.snapshot.checklist.steps.map((step) => ({
            label: step.label,
            status: step.status,
            ...(step.detail ? { detail: step.detail } : {}),
            ...(step.outcome
              ? {
                  targets: step.outcome.targets,
                  doneTargets: step.outcome.doneTargets,
                  excluded: step.outcome.excluded.length,
                  replaced: step.outcome.replaced,
                }
              : {}),
          })),
        }
      : null,
    answerChars: data.answerText.length,
    answerHead: clip(data.answerText, 600),
  };
}

// ---------------------------------------------------------------------------
// Prefs
// ---------------------------------------------------------------------------

function applyPrefs(prefs: Record<string, unknown>): () => void {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
    Zotero.Prefs.set(fullKey, value, true);
  }
  return () => {
    for (const [fullKey, value] of previous) {
      if (value === undefined) Zotero.Prefs.clear?.(fullKey, true);
      else Zotero.Prefs.set(fullKey, value, true);
    }
  };
}

function livePrefs(creds: LiveAgentCredentials): Record<string, unknown> {
  return {
    conversationSystem: "upstream",
    enableAgentMode: true,
    enableClaudeCodeMode: false,
    enableCodexAppServerMode: false,
    modelProviderGroups: JSON.stringify([
      {
        id: "live-digest-provider",
        apiBase: creds.apiBase,
        apiKey: creds.apiKey,
        authMode: "api_key",
        providerProtocol: creds.providerProtocol,
        models: [
          {
            id: MODEL_ENTRY_ID,
            model: creds.model,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ]),
    modelProviderGroupsMigrationVersion: 3,
    lastUsedModelEntryId: MODEL_ENTRY_ID,
    lastUsedRuntimeMode: "agent",
    lastUsedReasoningLevelByProvider: JSON.stringify({ deepseek: "auto" }),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

/** One test per selected scenario run, built before the suite is. */
const TEST_CASES = selectedScenarios.flatMap((id) => {
  const spec = SCENARIOS[id] as ScenarioSpec | undefined;
  const runs = id === "1" || id === "7" ? scenarioOneRepeat : 1;
  return Array.from({ length: spec ? runs : 1 }, (_, index) => ({
    id,
    run: index + 1,
    spec,
    name: !spec
      ? `scenario ${id}: unknown`
      : runs > 1
        ? `scenario ${id}, run ${index + 1} of ${runs}: ${spec.title}`
        : `scenario ${id}: ${spec.title}`,
  }));
});

describe("live: instruction-driven digest scenarios", function () {
  // A full-length turn, then up to about 70 s for the run to settle and its
  // ledger end to arrive, then the setup (seeding a paper set when the
  // scenario needs the other one) and the reads.
  this.timeout(1_100_000);
  // The runner passes --abort-on-fail (mocha bail), and a suite takes its
  // parent's bail. Each scenario is its own test, so one failure must not
  // stop the scenarios after it.
  this.bail(false);

  const state: {
    /** Skips every scenario: no report directory, or no model. */
    skipReason: string;
    /** Skips scenarios 1-6 and 1h: folder F is missing or invalid. */
    folderSkipReason: string;
    heldoutSkipReason: string;
    librarySkipReason: string;
    creds: LiveAgentCredentials | null;
    folderFiles: FixtureFile[];
    heldoutFiles: FixtureFile[];
    libraryFiles: FixtureFile[];
    /** Which paper set the library holds now; the two never coexist. */
    seeded: "folders" | "library" | null;
    folder: SeededSet | null;
    heldout: SeededSet | null;
    library: SeededSet | null;
    collectionIds: number[];
    itemIds: number[];
    restorePrefs: (() => void) | null;
    usedConversationKeys: number[];
  } = {
    skipReason: "",
    folderSkipReason: "",
    heldoutSkipReason: "",
    librarySkipReason: "",
    creds: null,
    folderFiles: [],
    heldoutFiles: [],
    libraryFiles: [],
    seeded: null,
    folder: null,
    heldout: null,
    library: null,
    collectionIds: [],
    itemIds: [],
    restorePrefs: null,
    usedConversationKeys: [],
  };

  before(async function () {
    if (!reportDir) {
      state.skipReason = "LLM_FOR_ZOTERO_PERF_REPORT_DIR is not set";
      return;
    }
    await IOUtils.makeDirectory(reportDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const selected = (ids: string[]) =>
      selectedScenarios.some((id) => ids.includes(id));

    // Folder F, for scenarios 1-6 and 1h.
    if (!selected(["1", "2", "3", "4", "5", "6", "1h"])) {
      state.folderSkipReason = "no folder scenario was selected";
    } else if (!papersDir) {
      state.folderSkipReason = "LLM_FOR_ZOTERO_DIGEST_PAPERS_DIR is not set";
    } else {
      const read = await readFixtureDir(papersDir);
      const problems = [...read.problems, folderProblem(read.files)].filter(
        Boolean,
      );
      if (problems.length)
        state.folderSkipReason = `folder F fixtures: ${problems.join("; ")}`;
      else state.folderFiles = read.files;
    }

    // The held-out misfit, for 1h.
    if (!selected(["1h"])) {
      state.heldoutSkipReason = "scenario 1h was not selected";
    } else if (!heldoutDir) {
      state.heldoutSkipReason = "LLM_FOR_ZOTERO_DIGEST_HELDOUT_DIR is not set";
    } else {
      const read = await readFixtureDir(heldoutDir);
      const misfits = read.files.filter((file) => file.role === "C1");
      if (read.problems.length || misfits.length !== 1 || !misfits[0].hasText)
        state.heldoutSkipReason = `held-out fixtures: ${[
          ...read.problems,
          misfits.length !== 1
            ? `${misfits.length} papers with role C1, expected 1`
            : "",
          misfits.length === 1 && !misfits[0].hasText
            ? "the C1 paper must have text"
            : "",
        ]
          .filter(Boolean)
          .join("; ")}`;
      else state.heldoutFiles = misfits;
    }

    // The whole-library set, for 7.
    if (!selected(["7"])) {
      state.librarySkipReason = "scenario 7 was not selected";
    } else if (!libraryDir) {
      state.librarySkipReason = "LLM_FOR_ZOTERO_DIGEST_LIBRARY_DIR is not set";
    } else {
      const read = await readFixtureDir(libraryDir);
      const problems = [...read.problems, libraryProblem(read.files)].filter(
        Boolean,
      );
      if (problems.length)
        state.librarySkipReason = `library fixtures: ${problems.join("; ")}`;
      else state.libraryFiles = read.files;
    }

    state.creds = await resolveLiveAgentCredentials({ requestedModel });
    if (!state.creds)
      state.skipReason = `model ${requestedModel} is not configured in the live profile`;
    const reasons = [
      state.skipReason,
      selected(["1", "2", "3", "4", "5", "6", "1h"])
        ? state.folderSkipReason
        : "",
      selected(["1h"]) ? state.heldoutSkipReason : "",
      selected(["7"]) ? state.librarySkipReason : "",
    ].filter(Boolean);
    if (reasons.length)
      await write("digest-scenarios-skipped.txt", reasons.join("\n"));
    if (state.skipReason) return;
    await (Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi).reset();
    state.restorePrefs = applyPrefs(livePrefs(state.creds!));
  });

  after(async function () {
    state.restorePrefs?.();
    if (!state.itemIds.length && !state.collectionIds.length) return;
    const api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
    await api.reset().catch(() => undefined);
    await eraseSeeded(state.itemIds, state.collectionIds);
  });

  async function eraseSeeded(itemIds: number[], collectionIds: number[]) {
    if (itemIds.length)
      await Zotero.Items.erase(itemIds).catch(() => undefined);
    for (const id of collectionIds)
      await Zotero.Collections.get(id)
        ?.eraseTx()
        .catch(() => undefined);
  }

  /**
   * Makes the library hold the paper set a scenario needs: the folders (F
   * and the held-out one) or the 16 library papers, never both, as both
   * sets share papers. The new set is saved before the old one is erased,
   * so no new item takes an erased item's id.
   */
  async function ensureSeeded(set: "folders" | "library"): Promise<void> {
    if (state.seeded === set) return;
    const libraryID = Number(Zotero.Libraries.userLibraryID);
    const oldItemIds = state.itemIds;
    const oldCollectionIds = state.collectionIds;
    state.itemIds = [];
    state.collectionIds = [];
    state.folder = null;
    state.heldout = null;
    state.library = null;
    if (set === "library") {
      const papers: SeededPaper[] = [];
      for (const file of state.libraryFiles) {
        const paper = await seedPaper(file, libraryID, []);
        state.itemIds.push(paper.itemId);
        papers.push(paper);
      }
      state.library = { ref: null, libraryID, papers };
    } else {
      const folder = await createCollection(libraryID, FOLDER_NAME);
      state.collectionIds.push(folder.id);
      const heldout = state.heldoutFiles.length
        ? await createCollection(libraryID, HELDOUT_FOLDER_NAME)
        : null;
      if (heldout) state.collectionIds.push(heldout.id);
      const folderPapers: SeededPaper[] = [];
      const heldoutPapers: SeededPaper[] = [];
      for (const file of state.folderFiles) {
        // The held-out folder is folder F with its misfit swapped.
        const inHeldout = Boolean(heldout) && file.role !== "C1";
        const paper = await seedPaper(
          file,
          libraryID,
          inHeldout && heldout ? [folder.id, heldout.id] : [folder.id],
        );
        state.itemIds.push(paper.itemId);
        folderPapers.push(paper);
        if (inHeldout) heldoutPapers.push(paper);
      }
      if (heldout) {
        for (const file of state.heldoutFiles) {
          const paper = await seedPaper(file, libraryID, [heldout.id]);
          state.itemIds.push(paper.itemId);
          heldoutPapers.push(paper);
        }
      }
      state.folder = {
        ref: { collectionId: folder.id, name: folder.name, libraryID },
        libraryID,
        papers: folderPapers,
      };
      state.heldout = heldout
        ? {
            ref: { collectionId: heldout.id, name: heldout.name, libraryID },
            libraryID,
            papers: heldoutPapers,
          }
        : null;
    }
    await eraseSeeded(oldItemIds, oldCollectionIds);
    state.seeded = set;
  }

  async function runScenario(
    id: string,
    run: number,
    spec: ScenarioSpec,
  ): Promise<void> {
    const api = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
    await api.reset();
    const wholeLibrary = spec.collection === "library";
    await ensureSeeded(wholeLibrary ? "library" : "folders");
    const seededSet =
      spec.collection === "library"
        ? state.library
        : spec.collection === "heldout"
          ? state.heldout
          : state.folder;
    assert.isOk(seededSet, `the ${spec.collection} papers were seeded`);
    const fixture = seededSet!;
    if (wholeLibrary) {
      // The whole library is exactly the seeded papers.
      const ids = new Set(fixture.papers.map((paper) => paper.itemId));
      const others = (
        (await Zotero.Items.getAll(fixture.libraryID, true, false)) as any[]
      ).filter((item) => item.isRegularItem?.() && !ids.has(Number(item.id)));
      assert.deepEqual(
        others.map(
          (item) => `item:${item.id} "${clip(item.getField?.("title"), 50)}"`,
        ),
        [],
        "the library holds only the scenario's papers",
      );
    }

    // A new Library chat conversation in Agent mode on the live model, from
    // a paper the scenario does not look for.
    const host =
      fixture.papers.find((paper) => paper.role === "P") || fixture.papers[0];
    const panel = await api.renderPanelForItem(host.itemId);
    let diag = await api.getDiagnostics(panel.panelId);
    if (diag.conversationKind !== "global") {
      diag = await api.togglePanelConversationMode(panel.panelId);
    }
    assert.equal(diag.conversationKind, "global", "panel is a Library chat");
    await api.startNewPanelConversation(panel.panelId, {
      allowReusedDraft: true,
    });
    await api.selectPanelModelEntry(panel.panelId, MODEL_ENTRY_ID);
    diag = await api.getDiagnostics(panel.panelId);
    // The built-in runtime is Agent whenever the Agent feature is on.
    assert.equal(diag.runtimeMode, "agent", "Agent mode is on");
    assert.equal(diag.conversationKind, "global", "still a Library chat");
    const conversationKey = Number(
      diag.conversationKey || diag.panelConversationKey,
    );
    assert.isAbove(conversationKey, 0, "the conversation has a key");
    assert.notInclude(
      state.usedConversationKeys,
      conversationKey,
      "each scenario runs in a new conversation",
    );
    const history = await api.getConversationHistoryTexts(conversationKey);
    assert.equal(
      history.memory.length + history.stored.length,
      0,
      "the new conversation is empty",
    );
    state.usedConversationKeys.push(conversationKey);

    // The folder is the composer context, and its chip is shown; for the
    // whole library the composer holds nothing.
    const folderRef = fixture.ref;
    await api.setTaskProgressComposerContexts({
      panelId: panel.panelId,
      ...(folderRef ? { collectionContexts: [folderRef] } : {}),
    });
    const contexts = await api.readTaskProgressComposerContexts({
      panelId: panel.panelId,
    });
    const warnings: string[] = [];
    if (folderRef) {
      assert.isTrue(
        contexts.collections.some(
          (entry) => entry.collectionId === folderRef.collectionId,
        ),
        `the folder is attached: ${JSON.stringify(contexts)}`,
      );
      assert.isTrue(
        contexts.chipLabels.some((chip) => chip.includes(folderRef.name)),
        `the folder chip is shown: ${JSON.stringify(contexts.chipLabels)}`,
      );
      if (contexts.paperItemIds.length)
        warnings.push(
          `paper chips beside the folder: ${contexts.paperItemIds.join(", ")}`,
        );
    } else {
      assert.deepEqual(
        contexts,
        { paperItemIds: [], collections: [], chipLabels: [] },
        "the composer context is empty",
      );
    }
    const beforeSend = await api.getDiagnostics(panel.panelId);
    assert.equal(
      Number(beforeSend.conversationKey || beforeSend.panelConversationKey),
      conversationKey,
      "the conversation did not change before sending",
    );

    // The turn. No scenario asks for a write, so any approval the run asks
    // for is an unrequested write proposal: deny it at once and record it,
    // instead of waiting for the turn timeout with nobody to approve.
    const startedAt = Date.now();
    let answerText = "";
    let turnError: string | null = null;
    const deniedApprovals: string[] = [];
    let watching = true;
    const watcher = (async () => {
      const seen = new Set<string>();
      while (watching) {
        await Zotero.Promise.delay(APPROVAL_POLL_MS);
        if (!watching) break;
        const rows = (await Zotero.DB.queryAsync(
          "SELECT e.payload_json AS payload FROM llm_for_zotero_agent_run_events e JOIN llm_for_zotero_agent_runs r ON r.run_id = e.run_id WHERE r.conversation_key = ? AND r.created_at >= ? AND e.event_type = 'confirmation_required'",
          [String(conversationKey), startedAt],
        )) as Array<{ payload: string }> | undefined;
        for (const row of rows || []) {
          let event: {
            requestId?: string;
            action?: { toolName?: string; title?: string };
          } = {};
          try {
            event = JSON.parse(String(row.payload));
          } catch {
            continue;
          }
          if (!event.requestId || seen.has(event.requestId)) continue;
          seen.add(event.requestId);
          deniedApprovals.push(
            `${event.action?.toolName || "a tool"}: ${event.action?.title || "an action"}`,
          );
          try {
            Zotero.LLMForZotero.api.agent.resolveConfirmation(
              event.requestId,
              false,
            );
          } catch (error) {
            warnings.push(`could not deny ${event.requestId}: ${error}`);
          }
        }
      }
    })();
    try {
      const turn = await api.sendLiveChatTurn(
        panel.panelId,
        spec.prompt,
        TURN_TIMEOUT_MS,
      );
      answerText = turn.answerText || "";
    } catch (error) {
      turnError = String((error as Error)?.stack || error);
    } finally {
      watching = false;
      await watcher;
    }
    const wallMs = Date.now() - startedAt;
    const sent = api.getLastSend();
    const rowView = await readTaskProgressRow(panel.panelId);

    // The harness can throw after the run already completed (a late wrapper
    // or DOM check): keep that as a warning and read the answer from the
    // conversation instead of failing the scenario.
    if (turnError) {
      const run = await settledRun(conversationKey);
      if (run?.status === "completed") {
        warnings.push(
          `sendLiveChatTurn threw after the run completed: ${turnError}`,
        );
        const texts = await api.getConversationHistoryTexts(conversationKey);
        const lastAssistant = (
          entries: Array<{ role: string; text: string }>,
        ) =>
          [...entries].reverse().find((entry) => entry.role === "assistant")
            ?.text || "";
        answerText = lastAssistant(texts.memory) || lastAssistant(texts.stored);
        turnError = null;
      }
    }

    const data = await gatherScenarioData({
      collection: fixture,
      conversationKey,
      answerText,
      warnings,
      row: rowView,
    });
    const violations: string[] = [];
    const check: Check = (ok, message) => {
      if (!ok) violations.push(message);
    };
    // Every scenario: the turn ran in Agent mode over the folder (or over
    // the whole library with nothing attached) and its run completed; then
    // the scenario's own checks.
    check(!turnError, `the turn failed: ${turnError}`);
    check(
      !deniedApprovals.length,
      `the run asked for approval of an unrequested write (denied): ${deniedApprovals.join("; ")}`,
    );
    check(data.runId, "no agent run was recorded for the conversation");
    check(
      data.runStatus === "completed",
      `the run's status is ${data.runStatus}`,
    );
    if (folderRef)
      check(
        (sent?.selectedCollectionContexts || []).some(
          (entry) => entry.collectionId === folderRef.collectionId,
        ),
        "the sent turn did not carry the folder",
      );
    else {
      const attached = [
        ...(sent?.selectedCollectionContexts || []).map(
          (entry) => `folder ${entry.collectionId}`,
        ),
        ...(sent?.selectedTagContexts || []).map(
          (entry) => `tag ${entry.name}`,
        ),
        ...[
          ...(sent?.paperContexts || []),
          ...(sent?.fullTextPaperContexts || []),
          ...(sent?.pdfPaperContexts || []),
        ].map((entry) => `paper ${entry.itemId}`),
      ];
      check(
        !attached.length,
        `the sent turn carried context: ${attached.join(", ")}`,
      );
    }
    check(
      sent?.runtimeMode === "agent",
      `the turn was sent in ${sent?.runtimeMode} mode`,
    );
    spec.checks(data, check);

    const byItem = new Map(
      fixture.papers.map((paper) => [paper.itemId, paper]),
    );
    const label = (target: string) => {
      const itemId = itemIdOfTarget(target);
      const paper = byItem.get(itemId);
      if (paper) return `${paper.name} (${paper.role})`;
      const title = itemId
        ? String(Zotero.Items.get(itemId)?.getField?.("title") || "")
        : "";
      return title ? `${target} "${clip(title, 50)}"` : target;
    };
    const report = {
      scenario: id,
      run,
      title: spec.title,
      prompt: spec.prompt,
      model: state.creds?.model,
      collection: {
        id: folderRef?.collectionId ?? null,
        name: folderRef?.name ?? "whole library",
        papers: fixture.papers,
      },
      conversationKey,
      wallMs,
      turnError,
      ...scenarioReport(data, label),
      warnings,
      violations,
    };
    await write(`${id}-${run}.json`, report);
    await write(`${id}-${run}.answer.md`, answerText || turnError || "");
    assert.deepEqual(violations, [], violations.join("\n"));
  }

  for (const testCase of TEST_CASES) {
    const { id, run, spec, name } = testCase;

    it(name, async function () {
      if (!spec) {
        assert.fail(
          `unknown scenario id "${id}"; known: ${Object.keys(SCENARIOS).join(", ")}`,
        );
      }
      if (
        state.skipReason ||
        (spec.collection === "library"
          ? state.librarySkipReason
          : state.folderSkipReason ||
            (spec.collection === "heldout" && state.heldoutSkipReason))
      ) {
        this.skip();
        return;
      }
      await runScenario(id, run, spec);
    });
  }
});
