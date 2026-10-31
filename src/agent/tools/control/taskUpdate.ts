import type {
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { fail, ok, validateObject } from "../shared";
import { ToolInputRejection } from "../execution/failure";
import { ACTION_CAPABILITIES } from "../../contracts/operationCatalog";
import type { AgentActionCapability } from "../../contracts/types";
import {
  assertCheckpointOwner,
  ordinaryExecutionTaskId,
} from "../../execution/checkpoint";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
  ExecutionTaskStatus,
  OutcomeEffect,
} from "../../execution/types";
import type { TaskPaperScopeSet } from "../../context/taskPaperScopeListing";
import {
  runDigestParts,
  type DigestJobHostDeps,
  type DigestRunResult,
} from "../../digests/digestJobHost";
import { withoutDigestQuoteCitations } from "../../digests/paperDigestWorker";
import {
  READ_SCOPE_JSON_SCHEMA,
  READ_SCOPE_OVERRIDES_JSON_SCHEMA,
  parseReadScope,
  type ReadScope,
} from "../../digests/readScope";
import {
  capabilityChanges,
  declarationChanges,
  declareOutcomes,
  excludeOutcomeTargets,
  isOutcomeTargetId,
  markOutcomes,
  readScopeChanges,
  redeclarable,
  replaceable,
  type OutcomeDeclaration,
  type OutcomeExclusionRefusal,
  type OutcomeModelMark,
} from "../../loop/outcomes";
import { isExplicitContinueCommand } from "../../continuation/continueCommand";
import { skillGuidance } from "../guidance";
import {
  exclusionPaperDecisions,
  type PaperDecisionLookup,
} from "./recordPaperDecisions";

type ExpectedEffect = "read" | "artifact" | "mutation" | "reasoning" | "digest";

/** A part of the request the model declares for the host to track. */
type TaskDeclaration = {
  taskId: string;
  description?: string;
  expectedEffect?: ExpectedEffect;
  expectedCapability?: string;
  targetIds?: string[];
  /** The part covers every paper of the turn's scope. */
  scope?: boolean;
  /** A new part only: the taskId of the pending part it replaces. */
  replaces?: string;
  /** Why it replaces that part; required with `replaces`. */
  reason?: string;
  /** A digest part only: what of each paper it reads. */
  read?: ReadScope;
  /** A digest part only: papers read for a scope of their own. */
  overrides?: Array<{ target: string; read: ReadScope }>;
};

/** A declared part that cannot be done, and why. */
type TaskException = { taskId: string; reason: string };

/** Papers an artifact or reasoning part leaves out, and why. */
type TaskExclusion = { taskId: string; targetIds: string[]; reason: string };

type ExceptionStatus = OutcomeModelMark["status"];

const EXCEPTION_STATUSES: readonly ExceptionStatus[] = [
  "skipped",
  "blocked",
  "cancelled",
];

type TaskUpdateInput = {
  tasks: TaskDeclaration[];
  excluded: TaskExclusion[];
} & Record<ExceptionStatus, TaskException[]>;

const EXPECTED_EFFECTS: readonly ExpectedEffect[] = [
  "read",
  "artifact",
  "mutation",
  "reasoning",
  "digest",
];

const DECLARATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "description", "expectedEffect"],
  properties: {
    taskId: { type: "string" },
    description: { type: "string" },
    expectedEffect: { type: "string", enum: [...EXPECTED_EFFECTS] },
    expectedCapability: { type: "string" },
    targetIds: { type: "array", items: { type: "string" } },
    scope: { type: "boolean" },
    replaces: { type: "string" },
    reason: { type: "string" },
    read: {
      ...READ_SCOPE_JSON_SCHEMA,
      description:
        "Digest only: what of each paper to read, as the user asked; default full, 'abstract' needs no model, pages [{from,to}].",
    },
    overrides: READ_SCOPE_OVERRIDES_JSON_SCHEMA,
  },
} as const;

const EXCEPTION_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "reason"],
    properties: {
      taskId: { type: "string" },
      reason: { type: "string" },
    },
  },
} as const;

const EXCLUSION_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "targetIds", "reason"],
    properties: {
      taskId: { type: "string" },
      targetIds: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
  },
} as const;

const EXPECTED_EFFECT_REQUIRED =
  "Give each new task an expectedEffect: read, artifact, mutation, reasoning, or digest (one host-made result per paper).";
const DIGEST_NEEDS_PAPERS =
  "A digest part names the papers it digests: targetIds, or scope:true for the attached papers.";
/** The most papers one digest part may name. */
export const DIGEST_MAX_PAPERS_PER_PART = 200;
function digestTooLarge(count: number): string {
  return `A digest part over ${count} papers is too large (at most ${DIGEST_MAX_PAPERS_PER_PART}). Narrow the scope to a collection, a tag, or explicit targetIds, or ask the user to confirm the whole set and then declare it as several digest parts of at most ${DIGEST_MAX_PAPERS_PER_PART} papers each.`;
}
/** The note for targetIds that name no Zotero item. */
function notIdsNote(values: readonly string[]): string {
  return `targetIds take Zotero ids (12 or item:12), and these are not ids: ${values
    .map((value) => JSON.stringify(value))
    .join(
      ", ",
    )}. Find the papers' ids with library_search, or use scope:true for the attached papers.`;
}
/** An effect as the model names it. */
function effectName(effect: OutcomeEffect): string {
  return effect === "answer" ? "reasoning" : effect;
}
/** The note for a new effect on a part that already holds evidence. */
function effectFixedNote(
  local: string,
  prior: ExecutionCheckpointTask,
  requested: OutcomeEffect,
): string {
  const was = effectName(prior.effect || "answer");
  const now = effectName(requested);
  const replace = replaceable(prior)
    ? ` If it replaces this part, add replaces: "${local}" and the reason.`
    : "";
  return `Task ${local} already has progress as a ${was} part, so it cannot become a ${now} part. Declare the ${now} part under a new taskId, such as "${local}-${now}".${replace}`;
}
/**
 * The note for a change to a part that no longer changes in place: one with
 * progress is replaced, one that holds writes or is settled is not.
 */
function fixedPartNote(local: string, task: ExecutionCheckpointTask): string {
  if (task.status !== "pending")
    return `Task ${local} is ${task.status}, so it cannot change. Declare the new work as a part under a new taskId.`;
  if (!replaceable(task))
    return `Task ${local} holds writes, so it stays as it is: further writes on its own papers complete it. Use a new taskId, without replaces, only for papers it does not name.`;
  return `Task ${local} already has progress, so its description and papers cannot change. Declare the changed part under a new taskId with replaces: "${local}" and the reason; the old part keeps what it did.`;
}
/** The note for `replaces` on a part that cannot be replaced. */
function notReplaceableNote(
  local: string,
  task: ExecutionCheckpointTask,
): string {
  return task.status !== "pending"
    ? `Task ${local} is ${task.status}, so there is nothing to replace. Declare the new part without replaces.`
    : `Task ${local} holds writes, so it cannot be replaced: writes stay as they were made, and further writes on its own papers complete it. Use a new taskId, without replaces, only for papers it does not name.`;
}
/** The note for declaring again a part another part replaced. */
function replacedNote(local: string, successor: string): string {
  return `Task ${local} was replaced by ${successor}, so it takes no further work. Declare ${successor} instead, or a new part.`;
}
function replacesNeedsNewIdNote(local: string): string {
  return `replaces declares a new part, and ${local} is already a task. Give the new part a new taskId, such as "${local}-2".`;
}
function replacesUnknownNote(named: string): string {
  return `replaces names no task of this run: ${named}. Name the taskId of the pending part the new one replaces.`;
}
/** The note for exclusions the ledger refused. */
function exclusionRefusedNote(
  refusals: readonly OutcomeExclusionRefusal[],
  local: (taskId: string) => string,
): string {
  return refusals
    .map((refusal) => {
      const id = local(refusal.taskId);
      if (refusal.kind === "effect")
        return `Task ${id} is a ${effectName(refusal.effect)} part, which covers every paper it names: excluded applies only to artifact and reasoning parts. If the part cannot be done, list it under skipped or blocked with the reason.`;
      if (refusal.kind === "status")
        return `Task ${id} is ${refusal.status}, so it has no papers left to exclude.`;
      const named = [
        ...(refusal.notTargets.length
          ? [`${refusal.notTargets.join(", ")} (not one of its papers)`]
          : []),
        ...(refusal.done.length
          ? [`${refusal.done.join(", ")} (already covered)`]
          : []),
      ];
      return `Task ${id} cannot exclude ${named.join("; ")}: excluded takes only the part's own papers that are not done yet.`;
    })
    .join(" ");
}
const HOST_MARKS_DONE =
  "Nothing changed: the host marks parts done from the tools' results, so progress needs no task_update call. Continue the work, or answer when it is done.";
/** The note for skips refused because nothing was delivered for their parts. */
function skipRefusedNote(ids: readonly string[]): string {
  const list = ids.join(", ");
  return `Skip refused for ${list}: nothing was delivered for ${ids.length === 1 ? "it" : "them"} in this run (no document, note, or read evidence is bound to it). Produce it with the tools, or, if it truly cannot be done, list it under blocked with the concrete obstacle.`;
}
const READ_NEEDS_DIGEST =
  "read and overrides say what a digest part reads of each paper: use them only with expectedEffect:'digest'.";
/** The note for overrides naming papers outside the part. */
function overridesOutsideNote(targets: readonly string[]): string {
  return `overrides names papers the part does not: ${targets.join(", ")}. Name only the part's own papers, or add them to its targetIds.`;
}
/** Overrides for papers the part names only. */
function checkOverrides(
  overrides: readonly { target: string }[] | undefined,
  targets: readonly string[] | undefined,
): void {
  if (!overrides?.length) return;
  const held = new Set(
    (targets || []).map((id) => (/^[1-9]\d*$/.test(id) ? `item:${id}` : id)),
  );
  const outside = overrides
    .map((entry) => entry.target)
    .filter((target) => !held.has(target));
  if (outside.length)
    throw new ToolInputRejection(overridesOutsideNote(outside));
}
const NO_SCOPE_PAPERS =
  "This turn states no paper scope to cover; name the part's papers in targetIds.";
/**
 * The note for scope:true on a part that is not a write when nothing is
 * attached: the agent chooses the papers, so it searches before it names them.
 */
function wholeLibraryScopeNote(local: string, count: number): string {
  return `Nothing is attached, so scope:true on task ${local} would cover the whole library (${count} ${count === 1 ? "paper" : "papers"}). Search with library_retrieve first, choose from its results the papers that bear on the question, and declare the part with their targetIds. List every paper's id with library_search only when the user explicitly asked for every paper in the library.`;
}
const NO_STATUS =
  "task_update takes no status: the host marks parts done from the tools' results. Declare parts in tasks, and list one that cannot be done under skipped, blocked or cancelled with the reason.";

/**
 * One part as the model reads it back: its id, status and counts. The ledger
 * itself, with the papers a part froze, stays with the host.
 */
type TaskUpdatePart = {
  taskId: string;
  status: ExecutionTaskStatus;
  /** Targets done, of the targets it names. */
  done?: number;
  total?: number;
  /** Targets not done, with up to three of the host's reasons. */
  exceptions?: number;
  reasons?: string[];
  /** Targets the model left out of the part, with its reasons. */
  excluded?: number;
  /** Why it was skipped, blocked or cancelled, or why a write failed. */
  reason?: string;
  scope?: true;
};

const NAMED_EXCEPTION_REASONS = 3;

function answerPart(
  checkpoint: ExecutionCheckpoint,
  task: ExecutionCheckpointTask,
): TaskUpdatePart {
  const prefix = `${checkpoint.executionId}:task:`;
  const exceptions = task.exceptions || [];
  const excepted = exceptions.reduce(
    (count, entry) => count + entry.targets.length,
    0,
  );
  const excluded = (task.excludedTargets || []).reduce(
    (count, entry) => count + entry.targets.length,
    0,
  );
  return {
    taskId: task.taskId.startsWith(prefix)
      ? task.taskId.slice(prefix.length)
      : task.taskId,
    status: task.status,
    ...(task.targets?.length
      ? { done: task.doneTargets?.length || 0, total: task.targets.length }
      : {}),
    ...(excepted
      ? {
          exceptions: excepted,
          reasons: [...new Set(exceptions.map((entry) => entry.reason))].slice(
            0,
            NAMED_EXCEPTION_REASONS,
          ),
        }
      : {}),
    ...(excluded ? { excluded } : {}),
    ...(task.reason ? { reason: task.reason } : {}),
    ...(task.scope ? { scope: true as const } : {}),
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function parseDeclaration(
  raw: unknown,
  label: string,
): AgentToolInputValidation<TaskDeclaration> {
  if (!validateObject<Record<string, unknown>>(raw)) {
    return fail(`${label} must be an object`);
  }
  if (raw.status !== undefined) return fail(NO_STATUS);
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  if (!taskId) return fail(`${label} needs a taskId`);
  if (
    raw.expectedEffect !== undefined &&
    !EXPECTED_EFFECTS.includes(raw.expectedEffect as ExpectedEffect)
  ) {
    return fail(`${label}.expectedEffect is invalid`);
  }
  if (raw.scope !== undefined && typeof raw.scope !== "boolean") {
    return fail(`${label}.scope must be true or false`);
  }
  if (raw.replaces !== undefined && !optionalText(raw.replaces)) {
    return fail(`${label}.replaces must be the taskId of the part it replaces`);
  }
  const replaces = optionalText(raw.replaces);
  const reason = optionalText(raw.reason);
  if (replaces && !reason) {
    return fail(
      `${label} needs a reason with replaces: why it replaces that part`,
    );
  }
  let read: ReadScope | undefined;
  if (raw.read !== undefined) {
    const parsed = parseReadScope(raw.read, `${label}.read`);
    if (!parsed.ok) return fail(parsed.error);
    read = parsed.scope;
  }
  let overrides: Array<{ target: string; read: ReadScope }> | undefined;
  if (raw.overrides !== undefined) {
    if (!Array.isArray(raw.overrides) || !raw.overrides.length)
      return fail(`${label}.overrides must be a non-empty array`);
    overrides = [];
    for (const [index, entry] of raw.overrides.entries()) {
      const where = `${label}.overrides[${index}]`;
      const record = validateObject<Record<string, unknown>>(entry)
        ? entry
        : null;
      const match = /^(?:item:)?([1-9]\d*)$/.exec(
        String(record?.itemId ?? "").trim(),
      );
      if (!record || !match)
        return fail(`${where} needs an itemId (12 or item:12) and a read`);
      const parsed = parseReadScope(record.read, `${where}.read`);
      if (!parsed.ok) return fail(parsed.error);
      const target = `item:${match[1]}`;
      if (overrides.some((known) => known.target === target))
        return fail(`${where} names ${target} twice`);
      overrides.push({ target, read: parsed.scope });
    }
  }
  return ok({
    taskId,
    description: optionalText(raw.description),
    expectedEffect: raw.expectedEffect as ExpectedEffect | undefined,
    expectedCapability: optionalText(raw.expectedCapability),
    targetIds: Array.isArray(raw.targetIds)
      ? raw.targetIds.map(String).filter(Boolean)
      : undefined,
    ...(raw.scope === true ? { scope: true } : {}),
    // A reason without replaces explains nothing the host keeps.
    ...(replaces ? { replaces, reason } : {}),
    ...(read ? { read } : {}),
    ...(overrides ? { overrides } : {}),
  });
}

function parseExclusion(
  raw: unknown,
  label: string,
): AgentToolInputValidation<TaskExclusion> {
  if (!validateObject<Record<string, unknown>>(raw)) {
    return fail(`${label} must be an object`);
  }
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  if (!taskId) return fail(`${label} needs a taskId`);
  const targetIds = Array.isArray(raw.targetIds)
    ? raw.targetIds.map((value) => String(value).trim()).filter(Boolean)
    : [];
  if (!targetIds.length) {
    return fail(`${label} needs targetIds: the papers the part leaves out`);
  }
  const reason = optionalText(raw.reason);
  if (!reason) {
    return fail(`${label} needs a reason: why the part leaves them out`);
  }
  return ok({ taskId, targetIds, reason });
}

function parseException(
  raw: unknown,
  label: string,
): AgentToolInputValidation<TaskException> {
  if (!validateObject<Record<string, unknown>>(raw)) {
    return fail(`${label} must be an object`);
  }
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  if (!taskId) return fail(`${label} needs a taskId`);
  return ok({ taskId, reason: optionalText(raw.reason) || "" });
}

function parseList<T>(
  value: unknown,
  label: string,
  parse: (raw: unknown, label: string) => AgentToolInputValidation<T>,
): AgentToolInputValidation<T[]> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value) || !value.length) {
    return fail(`${label} must be a non-empty array`);
  }
  const parsed: T[] = [];
  for (const [index, raw] of value.entries()) {
    const entry = parse(raw, `${label}[${index}]`);
    if (!entry.ok) return entry;
    parsed.push(entry.value);
  }
  return ok(parsed);
}

export function validateTaskUpdateInput(
  args: unknown,
): AgentToolInputValidation<TaskUpdateInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("task_update expects an object");
  }
  const tasks = parseList(args.tasks, "task_update.tasks", parseDeclaration);
  if (!tasks.ok) return tasks;
  const excluded = parseList(
    args.excluded,
    "task_update.excluded",
    parseExclusion,
  );
  if (!excluded.ok) return excluded;
  const input: TaskUpdateInput = {
    tasks: tasks.value,
    excluded: excluded.value,
    skipped: [],
    blocked: [],
    cancelled: [],
  };
  for (const status of EXCEPTION_STATUSES) {
    const exceptions = parseList(
      args[status],
      `task_update.${status}`,
      parseException,
    );
    if (!exceptions.ok) return exceptions;
    input[status] = exceptions.value;
  }
  if (
    !input.tasks.length &&
    !input.excluded.length &&
    EXCEPTION_STATUSES.every((status) => !input[status].length)
  ) {
    return fail(
      "task_update needs tasks to declare, parts listed under skipped, blocked or cancelled, or papers listed under excluded",
    );
  }
  return ok(input);
}

function actionCapability(
  value: string | undefined,
): AgentActionCapability | undefined {
  return value && ACTION_CAPABILITIES.has(value as AgentActionCapability)
    ? (value as AgentActionCapability)
    : undefined;
}

/**
 * The targets a new part declares: its targetIds, or, with `scope`, every
 * paper of the turn's scope as the host resolved it, frozen now in scope
 * order. A later change to the scope never reaches a part declared before.
 * A part that names targetIds and also sets `scope` tracks the papers it
 * named: they say exactly what is meant, so `scope` is ignored rather than
 * the call refused.
 *
 * With nothing attached the scope is the whole library, and the agent
 * chooses the papers a part works on: only a write part, `effect` being the
 * effect the part takes, may cover the whole library with `scope`.
 */
function declaredTargets(
  request: TaskDeclaration,
  scopePapers: TaskPaperScopeSet | undefined,
  effect: OutcomeEffect,
): { targets?: string[]; scope?: true } {
  if (!request.scope || request.targetIds?.length) {
    return { targets: request.targetIds };
  }
  if (!scopePapers?.itemIds.length) {
    throw new ToolInputRejection(NO_SCOPE_PAPERS);
  }
  if (scopePapers.wholeLibrary && effect !== "mutation") {
    throw new ToolInputRejection(
      wholeLibraryScopeNote(request.taskId, scopePapers.itemIds.length),
    );
  }
  return {
    targets: scopePapers.itemIds.map((itemId) => `item:${itemId}`),
    scope: true,
  };
}

/**
 * A digest part the host is asked to run, and the papers to digest now;
 * `retried` are those the part holds as failed, with the reason it holds.
 */
export type DigestPartRun = {
  taskId: string;
  targets: string[];
  retried?: Array<{ target: string; reason: string }>;
};

/**
 * The papers a repeated digest declaration asks for: its targetIds, as the
 * part's own targets in the part's own order, or, without targetIds, every
 * paper the part has not done (a resume after Stop, or a retry of failures).
 */
function digestRetryTargets(
  task: ExecutionCheckpointTask,
  targetIds: readonly string[] | undefined,
): string[] {
  const targets = task.targets || [];
  if (targetIds?.length) {
    const named = new Set(
      targetIds.map((id) => (/^[1-9]\d*$/.test(id) ? `item:${id}` : id)),
    );
    return targets.filter((target) => named.has(target));
  }
  const done = new Set(task.doneTargets || []);
  return targets.filter((target) => !done.has(target));
}

/** The host effect a model's expectedEffect names. */
function outcomeEffect(
  expected: ExpectedEffect | undefined,
): OutcomeEffect | undefined {
  return expected === "reasoning" ? "answer" : expected;
}

/**
 * The effect a part takes: a write capability makes it a mutation
 * (`declareOutcomes`), whatever effect it claims.
 */
function takenEffect(
  effect: OutcomeEffect,
  capability: AgentActionCapability | undefined,
): OutcomeEffect {
  return capability && capability !== "zotero.read" ? "mutation" : effect;
}

/** The most characters of the user's request a digest part keeps. */
const DIGEST_QUESTION_CHARACTERS = 2_000;
const SHORTENED = " [shortened]";

/**
 * The user's request a digest part declared now serves: the turn's text,
 * trimmed, and cut to 2,000 characters ending with "[shortened]". A continue
 * command asks for no new work, so the part serves the request the ledger's
 * newest part saved (the last in the ledger that has one), or none when no
 * part saved one.
 */
function digestQuestion(
  checkpoint: ExecutionCheckpoint,
  userText: string | undefined,
): string | undefined {
  const text = (userText || "").trim();
  if (!text) return undefined;
  if (isExplicitContinueCommand(text)) {
    return [...checkpoint.tasks].reverse().find((task) => task.question)
      ?.question;
  }
  if (text.length <= DIGEST_QUESTION_CHARACTERS) return text;
  return `${text.slice(0, DIGEST_QUESTION_CHARACTERS - SHORTENED.length).trimEnd()}${SHORTENED}`;
}

/** A digest part names some papers, and no more than one part digests. */
function checkDigestPapers(
  effect: OutcomeEffect | undefined,
  effectiveEffect: OutcomeEffect | undefined,
  targets: readonly string[] | undefined,
): void {
  if (effect === "digest" && !targets?.length)
    throw new ToolInputRejection(DIGEST_NEEDS_PAPERS);
  if (
    effectiveEffect === "digest" &&
    (targets?.length || 0) > DIGEST_MAX_PAPERS_PER_PART
  )
    throw new ToolInputRejection(digestTooLarge(targets!.length));
}

/**
 * One ordinary call: its declarations become declared parts, then its
 * skipped, blocked or cancelled parts are marked with their reasons, then
 * the papers it excludes are recorded on their parts.
 *
 * A part declared again as it is changes nothing, and `ignored` says so,
 * except for a digest part: declaring one, or repeating it, asks the host to
 * run it, and `digestParts` lists those runs with their papers. A digest part
 * repeated as it is runs over the papers its targetIds name, or every paper
 * it has not done: its targetIds and scope select papers, never change them.
 *
 * A part declared again with a change (a new description, expectedEffect,
 * expectedCapability, or other papers) is changed in place while it holds no
 * progress: it keeps its id, place and creation time, takes the change, and
 * freezes its targets again when the repeat gives targetIds or scope (a
 * scope it already froze stays as frozen, unless the repeat changes the
 * part otherwise). `changed` lists those parts; a digest part changed runs
 * again. A part with progress is not changed: the model declares a new part
 * that names it in `replaces`, with the reason, and `replaced` lists those.
 * A new effect for a part with progress keeps its own note. With nothing
 * attached, only a write part freezes the scope (`declaredTargets`); a
 * repeat that freezes nothing again is unaffected. A malformed or refused
 * call is an input rejection, and changes nothing.
 *
 * A digest part declared, changed or declared as a replacement saves the
 * user's request as its `question` (`digestQuestion`); a repeat keeps the
 * one it has.
 */
export function applyOrdinaryTaskUpdates(
  checkpoint: ExecutionCheckpoint,
  input: TaskUpdateInput,
  now: number,
  scopePapers: TaskPaperScopeSet | undefined,
  userText?: string,
): {
  checkpoint: ExecutionCheckpoint;
  ignored: boolean;
  refused: string[];
  digestParts: DigestPartRun[];
  changed: string[];
  replaced: Array<{ taskId: string; replaces: string }>;
} {
  try {
    const existing = new Map(
      checkpoint.tasks.map((task) => [task.taskId, task]),
    );
    const prefix = `${checkpoint.executionId}:task:`;
    const local = (taskId: string) =>
      taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId;
    const qualified = (id: string) =>
      ordinaryExecutionTaskId(checkpoint.executionId, id);
    const onlyOnce = (seen: Set<string>, taskId: string) => {
      if (seen.has(taskId)) {
        throw new Error(`Task ${taskId} may appear only once in one update`);
      }
      seen.add(taskId);
    };
    const marks: OutcomeModelMark[] = [];
    const marked = new Set<string>();
    for (const status of EXCEPTION_STATUSES) {
      for (const exception of input[status]) {
        const taskId = qualified(exception.taskId);
        onlyOnce(marked, taskId);
        marks.push({ taskId, status, reason: exception.reason });
      }
    }
    const question = digestQuestion(checkpoint, userText);
    const declarations: OutcomeDeclaration[] = [];
    const declared = new Set<string>();
    let ignored = false;
    // Digest parts this call asks to run: new or changed ones with every
    // paper, repeated ones with the papers the repeat names
    // (`digestRetryTargets`).
    const digestRuns: Array<{ taskId: string; targetIds?: string[] }> = [];
    // Parts this call changes in place, and the old parts it replaces by the
    // new parts' ids.
    const changed = new Set<string>();
    const replacing = new Map<string, string>();
    for (const request of input.tasks) {
      const taskId = qualified(request.taskId);
      onlyOnce(declared, taskId);
      const prior = existing.get(taskId);
      // A replaced part is history: its successor carries the work on.
      if (prior?.supersededBy)
        throw new ToolInputRejection(
          replacedNote(request.taskId, local(prior.supersededBy)),
        );
      const requestedEffect = outcomeEffect(request.expectedEffect);
      // The effect the part would take: a write capability makes it a
      // mutation (`declareOutcomes`), so repeating such a declaration word
      // for word is a repeat, not a new effect.
      const capability = actionCapability(request.expectedCapability);
      const effectiveEffect =
        requestedEffect && takenEffect(requestedEffect, capability);
      const newEffect =
        prior !== undefined &&
        effectiveEffect !== undefined &&
        effectiveEffect !== (prior.effect || "answer");
      if (newEffect && !redeclarable(prior)) {
        throw new ToolInputRejection(
          effectFixedNote(request.taskId, prior, effectiveEffect),
        );
      }
      // Papers are named by id; a write part may also name what is not in
      // the library yet ("new collection"), which tracks its capability.
      if (
        request.targetIds?.length &&
        (effectiveEffect || prior?.effect) !== "mutation"
      ) {
        const notIds = request.targetIds.filter(
          (value) => !isOutcomeTargetId(value),
        );
        if (notIds.length) throw new ToolInputRejection(notIdsNote(notIds));
      }
      if (request.replaces !== undefined) {
        if (prior)
          throw new ToolInputRejection(replacesNeedsNewIdNote(request.taskId));
        const old = qualified(request.replaces);
        const replaced = existing.get(old);
        if (!replaced)
          throw new ToolInputRejection(replacesUnknownNote(request.replaces));
        if (replacing.has(old))
          throw new Error(`Task ${old} may appear only once in one update`);
        if (!replaceable(replaced))
          throw new ToolInputRejection(
            notReplaceableNote(local(old), replaced),
          );
        replacing.set(old, taskId);
      }
      const asksScope =
        request.read !== undefined || request.overrides !== undefined;
      if (
        asksScope &&
        (effectiveEffect || prior?.effect || "answer") !== "digest"
      )
        throw new ToolInputRejection(READ_NEEDS_DIGEST);
      const scopeFields = {
        ...(request.read ? { readScope: request.read } : {}),
        ...(request.overrides ? { readOverrides: request.overrides } : {}),
      };
      if (!prior) {
        const effect = requestedEffect;
        if (!effect) throw new ToolInputRejection(EXPECTED_EFFECT_REQUIRED);
        const { targets, scope } = declaredTargets(
          request,
          scopePapers,
          takenEffect(effect, capability),
        );
        checkDigestPapers(effect, effectiveEffect, targets);
        checkOverrides(request.overrides, targets);
        if (effect === "digest") digestRuns.push({ taskId });
        declarations.push({
          taskId,
          description: request.description || "",
          effect,
          capability,
          targets,
          ...(scope ? { scope } : {}),
          ...(question ? { question } : {}),
          ...scopeFields,
          ...(request.replaces !== undefined
            ? { replaces: request.replaces, reason: request.reason }
            : {}),
        });
        continue;
      }
      const priorEffect = prior.effect || "answer";
      const newDescription =
        request.description !== undefined &&
        request.description !== prior.description;
      const newCapability =
        capability !== undefined && capabilityChanges(prior, capability);
      const reframes =
        newEffect ||
        newDescription ||
        newCapability ||
        readScopeChanges(prior, {
          readScope: request.read,
          readOverrides: request.overrides,
        });
      if (priorEffect === "digest" && !reframes) {
        digestRuns.push({ taskId, targetIds: request.targetIds });
        continue;
      }
      const effect = newEffect ? requestedEffect! : priorEffect;
      const declaredCapability = newEffect
        ? capability
        : capability || prior.capability;
      const { targets, scope } =
        request.targetIds?.length ||
        (request.scope && (reframes || !prior.scope))
          ? declaredTargets(
              request,
              scopePapers,
              takenEffect(effect, declaredCapability),
            )
          : {
              targets: prior.targets ? [...prior.targets] : undefined,
              scope: prior.scope,
            };
      const declaration: OutcomeDeclaration = {
        taskId,
        description: request.description || prior.description,
        effect,
        capability: declaredCapability,
        targets,
        ...(scope ? { scope } : {}),
        ...(question ? { question } : {}),
        ...scopeFields,
      };
      if (!declarationChanges(prior, declaration)) {
        if (!marked.has(taskId)) ignored = true;
        continue;
      }
      if (!redeclarable(prior))
        throw new ToolInputRejection(fixedPartNote(request.taskId, prior));
      checkDigestPapers(
        effect,
        newEffect ? effectiveEffect : priorEffect,
        targets,
      );
      checkOverrides(request.overrides ?? prior.readOverrides, targets);
      if (effect === "digest") digestRuns.push({ taskId });
      changed.add(taskId);
      declarations.push(declaration);
    }
    // A part this call replaces is neither declared nor marked again in it.
    for (const old of replacing.keys()) {
      if (declared.has(old) || marked.has(old))
        throw new Error(`Task ${old} may appear only once in one update`);
    }
    const applied = markOutcomes(
      declareOutcomes(checkpoint, declarations, now),
      marks,
      now,
    );
    const excluded = excludeOutcomeTargets(
      applied.checkpoint,
      input.excluded.map((exclusion) => {
        const notIds = exclusion.targetIds.filter(
          (value) => !isOutcomeTargetId(value),
        );
        if (notIds.length) throw new ToolInputRejection(notIdsNote(notIds));
        return {
          taskId: exclusion.taskId,
          targets: exclusion.targetIds,
          reason: exclusion.reason,
        };
      }),
      now,
    );
    if (excluded.refused.length)
      throw new ToolInputRejection(
        exclusionRefusedNote(excluded.refused, local),
      );
    const tasks = new Map(
      excluded.checkpoint.tasks.map((task) => [task.taskId, task]),
    );
    const digestParts = digestRuns.flatMap(({ taskId, targetIds }) => {
      const task = tasks.get(taskId);
      // A part the same call marks, or one a write capability made a
      // mutation, runs no digest.
      if (task?.effect !== "digest" || marked.has(taskId)) return [];
      const targets = digestRetryTargets(task, targetIds);
      if (!targets.length) return [];
      const retried = targets.flatMap((target) => {
        const held = task.exceptions?.find((entry) =>
          entry.targets.includes(target),
        );
        return held ? [{ target, reason: held.reason }] : [];
      });
      return [{ taskId, targets, ...(retried.length ? { retried } : {}) }];
    });
    return {
      checkpoint: excluded.checkpoint,
      digestParts,
      changed: [...changed].map(local),
      replaced: [...replacing].map(([old, taskId]) => ({
        taskId: local(taskId),
        replaces: local(old),
      })),
      // A call whose exclusions moved the ledger did something, whatever it
      // repeated beside them.
      ignored:
        (ignored || applied.ignored.length > 0) &&
        excluded.checkpoint === applied.checkpoint,
      refused: applied.refused.map(({ taskId }) => local(taskId)),
    };
  } catch (error) {
    if (error instanceof ToolInputRejection) throw error;
    throw new ToolInputRejection(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * The skills' part, digest, and retry rules. They live here, not in the skill
 * bodies, because task_update is the in-plugin Agent's own tool: an external
 * runtime (Codex reading SKILL.md, Claude Code through load_skill) never sees
 * it, so a body that named it would send that runtime to a tool it lacks
 * (#541). Each item reaches the plugin's Agent only with its skill active.
 * The rule for when a review takes a digest or a read part lives in
 * task_update's description, because it holds with or without the skill.
 */
export const LITERATURE_REVIEW_PARTS_GUIDANCE = skillGuidance(
  "literature-review",
  [
    "Literature review parts: when task_update is available, these parts hand the papers to the host in place of the skill's first read.",
    "Declare the parts with `task_update` before reading; with nothing attached, after `library_retrieve` has chosen the papers.",
    "When the user asked for something per paper (summaries, each paper's method, a table with a row per paper), declare a digest part, and do not also declare a read part over the same papers.",
    "Declare a review's digest part as `{ taskId:'papers', description:'For the review question \"<question>\": summarize each paper and judge how it bears on the question', expectedEffect:'digest', scope:true }` (or explicit `targetIds`); when the user limited what to read, add that `read`, e.g. `read:{ source:'abstract' }` or `read:{ source:'sections', sections:['abstract','results'] }`.",
    "Then declare the review (`expectedEffect:'artifact'`) unless the user asked for a chat answer, and, only when the user asked to save it, the note (`expectedEffect:'mutation'`, `expectedCapability:'zotero.notes'`).",
    "The host marks each part done from the tools' results.",
    "Pass the `taskId` of the review part to `submit_document`.",
    "List each paper you leave out of an answer without a document under `excluded` in `task_update`, with a one-sentence reason.",
  ].join(" "),
);

export const LITERATURE_REVIEW_DIGEST_GUIDANCE = skillGuidance(
  "literature-review",
  [
    "Literature review digest results: each result the host returns for a digest part has the answer to the part's description, a relevance line when the description names a question, facets, verified quotes with section labels, gaps, a text line that says whether it read the whole text, and a handle to the digest record.",
    "Read a digested paper again only with `paper_read({ mode:'targeted', query:'...' })`: to verify a decisive cross-paper claim, test an apparent contradiction, or close a gap its result names that the review needs; never re-read it in overview mode, or in full mode unless the user asks for its whole text.",
    'A paper that failed with "No readable text" has no text to read: name it as not read, and do not retry it, read it with `paper_read`, or look for it outside the library.',
    "If the host reports other digest failures, declare the part again once with `targetIds` of those papers only.",
    "Then a paper whose digest failed twice may be read with an overview `paper_read` instead; name it as not read only if that read fails too.",
    "If the part is still open after a Stop and the user says continue, call `task_update` again with the same `taskId` and no description to finish the remaining papers.",
    "In the 'Paper summaries' section, write each paper's paragraph from that paper's digest.",
    "In Scope and limitations, name each paper whose digest failed and the reason the host gave.",
  ].join(" "),
);

export const COMPARE_PAPERS_DIGEST_GUIDANCE = skillGuidance(
  "compare-papers",
  [
    "Compare papers: when task_update is available, compare through a digest part instead of reading the papers with `paper_read`, unless the user asked for full reads.",
    "For three or more papers, declare a digest part first (`task_update` with `expectedEffect:'digest'` over the papers) whose description names the comparison dimensions, for example \"For each paper, report: question, species or system, method, main finding\".",
    "When the user limited what to read, give the part that `read`, e.g. `read:{ source:'abstract' }`.",
    "Each result returns facets with those labels; they become the comparison's rows.",
    "Read further only for a dimension the results leave open.",
  ].join(" "),
);

export const REORGANIZE_LIBRARY_PARTS_GUIDANCE = skillGuidance(
  "reorganize-library",
  [
    "Sort papers into folders or tags: declare the changes with `task_update` as one part: `expectedEffect:'mutation'`, `expectedCapability:'zotero.collections'` for folders or `'zotero.tags'` for tags, and `scope:true` when the turn's paper scope is exactly the papers to sort, or their `targetIds` otherwise.",
    "Declare no read part for the survey: metadata and abstracts never complete a part that reads papers.",
  ].join(" "),
);

export type TaskUpdateToolDeps = {
  /**
   * The host that runs a declared digest part. Without it a digest part is
   * declared and tracked, and nothing digests it.
   */
  digests?: DigestJobHostDeps;
  /**
   * Item lookups for the papers `excluded` names, so each is also recorded
   * as the agent's exclude decision (record_paper_decisions' path). Without
   * it the exclusions only move the parts.
   */
  papers?: PaperDecisionLookup;
};

type TaskUpdateResult = {
  parts: TaskUpdatePart[];
  /** Parts this call changed in place. */
  changed?: string[];
  /** New parts this call declared in place of others, by local taskId. */
  replaced?: Array<{ taskId: string; replaces: string }>;
  note?: string;
} & DigestRunResult;

export function createTaskUpdateTool(
  deps: TaskUpdateToolDeps = {},
): AgentToolDefinition<TaskUpdateInput, TaskUpdateResult> {
  return {
    spec: {
      name: "task_update",
      description:
        "Declare a compound request's parts for the host to track: expectedCapability such as zotero.notes for a write; targetIds, or scope:true for the whole Paper scope; expectedEffect 'digest' asks the host to answer the part's description for each named paper and return the results. A digest reads each paper's whole text unless its read names a source; when the user limits what to read (abstracts, sections, pages, notes), set read to that, e.g. {source:'abstract'}. The host marks parts done; list one that cannot be done under skipped or blocked, with the reason. List papers a review or answer leaves out under excluded, with the reason. To change a part that has progress, declare a new part with replaces and a reason. A literature review or synthesis of more than four papers declares a digest part, not a reasoning or read part: scope:true for the attached papers, or targetIds for papers you chose. The host analyzes each paper inside that call, so do not read those papers with paper_read first; write from the results it returns. A literature review of four papers or fewer declares a read part over their targetIds, unless the user asked for something per paper.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tasks: { type: "array", minItems: 1, items: DECLARATION_SCHEMA },
          skipped: EXCEPTION_SCHEMA,
          blocked: EXCEPTION_SCHEMA,
          cancelled: EXCEPTION_SCHEMA,
          excluded: EXCLUSION_SCHEMA,
        },
      },
      executionClass: "control",
      workCategory: "planning",
    },
    /**
     * Its calls declare the parts the host tracks, and Task progress already
     * shows the reader those parts, so a row for each call would report the
     * trace's own plumbing.
     */
    presentation: { hiddenInTrace: true },
    guidance: [
      LITERATURE_REVIEW_PARTS_GUIDANCE,
      LITERATURE_REVIEW_DIGEST_GUIDANCE,
      COMPARE_PAPERS_DIGEST_GUIDANCE,
      REORGANIZE_LIBRARY_PARTS_GUIDANCE,
    ],
    isAvailable: (request) =>
      request.executionContext?.permissionOwner === "original_agent",
    // The model cites a digest quote by the id beside it; the citation
    // records stay with the host.
    modelContent: (result) => withoutDigestQuoteCitations(result),
    validate: validateTaskUpdateInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This host-owned control updates only task progress in the active workflow.",
      }),
    execute: async (input, context) => {
      const execution = context.request.executionContext;
      if (execution?.permissionOwner !== "original_agent") {
        throw new Error(
          "task_update requires an ordinary Original Agent execution",
        );
      }
      if (!context.runId || !context.updateExecutionCheckpoint) {
        throw new Error(
          "Ordinary task progress requires durable run checkpoint persistence",
        );
      }
      let ignored = false;
      let refused: string[] = [];
      let digestParts: DigestPartRun[] = [];
      let changed: string[] = [];
      let replaced: Array<{ taskId: string; replaces: string }> = [];
      let checkpoint = await context.updateExecutionCheckpoint((current) => {
        assertCheckpointOwner(current, execution);
        const applied = applyOrdinaryTaskUpdates(
          current,
          input,
          Date.now(),
          context.request.turnScopePapers,
          context.request.userText,
        );
        ignored = applied.ignored;
        refused = applied.refused;
        digestParts = applied.digestParts;
        changed = applied.changed;
        replaced = applied.replaced;
        return applied.checkpoint;
      });
      let digests: DigestRunResult = {};
      if (digestParts.length && deps.digests) {
        const prefix = `${checkpoint.executionId}:task:`;
        digests = await runDigestParts({
          parts: digestParts,
          context,
          deps: deps.digests,
          localTaskId: (taskId) =>
            taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId,
        });
        // The ledger as the papers' outcomes left it.
        checkpoint = await context.updateExecutionCheckpoint(
          (current) => current,
        );
      }
      const parts = checkpoint.tasks.map((task) =>
        answerPart(checkpoint, task),
      );
      const reported = {
        parts,
        ...(changed.length ? { changed } : {}),
        ...(replaced.length ? { replaced } : {}),
      };
      // A refused skip is the note the model must act on; it outranks the
      // reminder that progress needs no call.
      const content: TaskUpdateResult = refused.length
        ? { ...reported, note: skipRefusedNote(refused), ...digests }
        : ignored
          ? { ...reported, note: HOST_MARKS_DONE, ...digests }
          : { ...reported, ...digests };
      // The papers the parts leave out are the agent's exclude decisions,
      // recorded once, as record_paper_decisions records them.
      const paperDecisions = exclusionPaperDecisions(
        input.excluded,
        context.request.libraryID,
        deps.papers,
      );
      return paperDecisions.length ? { content, paperDecisions } : content;
    },
  };
}
