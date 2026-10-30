import { ExecutionCheckpointFold } from "../src/agent/execution/checkpointEvents";
import { openDeclaredOutcomes } from "../src/agent/loop/outcomes";
import type { AgentEvent } from "../src/agent/types";
import { assertExact, check, type StepOutcome } from "./core";
import type { Turn } from "./driver";
import type { JourneyContext } from "./journeys";
import { snapshot } from "./native";

declare const Zotero: any;

/**
 * More than four papers, so a review of them takes the digest path, with or
 * without the literature-review skill.
 */
export const LITERATURE_REVIEW_DIGEST_PAPER_COUNT = 6;

/** Papers the library step needs in the run's collection for a real review. */
export const LITERATURE_REVIEW_LIBRARY_MIN_PAPERS = 5;

/** A review of more papers than this must declare a digest part. */
export const LITERATURE_REVIEW_READ_LIMIT = 4;

export function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as any) : {};
}

export function calls(events: AgentEvent[], name: string) {
  return events.flatMap((event) =>
    event.type === "tool_call" && event.name === name ? [event] : [],
  );
}

export function results(events: AgentEvent[], name: string) {
  return events.flatMap((event) =>
    event.type === "tool_result" && event.name === name ? [event] : [],
  );
}

type Progress = { label: string; held: boolean }[];

function digestResults(events: AgentEvent[]) {
  return results(events, "task_update").filter(
    (event) =>
      event.ok &&
      ["digests", "digestHandles", "digestFailures", "digestPending"].some(
        (field) => field in record(event.content),
      ),
  );
}

/** The parts the model declared with `expectedEffect`, across every task_update. */
function declaredParts(events: AgentEvent[], effect: string) {
  return calls(events, "task_update").flatMap((event) =>
    (Array.isArray(record(event.args).tasks)
      ? record(event.args).tasks
      : []
    ).filter((task: unknown) => record(task).expectedEffect === effect),
  ) as Record<string, any>[];
}

/** Zotero item ids as plain numbers: `12`, `"12"` and `"item:12"` are one id. */
function itemIdOf(value: unknown): number | undefined {
  const id = Number(String(value ?? "").replace(/^item:/, ""));
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** The distinct papers the parts name in `targetIds`. */
function partTargets(parts: Record<string, any>[]): number[] {
  const ids = parts.flatMap((part) =>
    (Array.isArray(part.targetIds) ? part.targetIds : []).map(itemIdOf),
  );
  return [...new Set(ids.filter((id): id is number => id !== undefined))];
}

/**
 * The distinct papers paper_read touched: the `target.itemId` or
 * `targets[].itemId` of every call whose result succeeded. Any mode counts. A
 * visual target named by attachment id has no itemId and counts for none; a
 * call with neither argument reads the turn scope, which is empty here.
 * Arguments: `paperRead.ts` input schema, `target` and `targets`, each a
 * selector of `itemId` and optional `contextItemId` (`pdfToolUtils.ts`).
 */
export function papersRead(events: AgentEvent[]): number[] {
  const succeeded = new Set(
    results(events, "paper_read")
      .filter((event) => event.ok)
      .map((event) => event.callId),
  );
  const ids = calls(events, "paper_read")
    .filter((event) => succeeded.has(event.callId))
    .flatMap((event) => {
      const args = record(event.args);
      return [
        ...(args.target ? [args.target] : []),
        ...(Array.isArray(args.targets) ? args.targets : []),
      ].map((target) => itemIdOf(record(target).itemId));
    });
  return [...new Set(ids.filter((id): id is number => id !== undefined))];
}

/** The distinct papers (by itemKey) the submit_document calls cite. */
function papersCited(events: AgentEvent[]): string[] {
  const keys = calls(events, "submit_document").flatMap((event) =>
    (Array.isArray(record(event.args).citations)
      ? record(event.args).citations
      : []
    ).map((citation: unknown) => String(record(citation).itemKey ?? "")),
  );
  return [...new Set(keys.filter(Boolean))];
}

/**
 * The delivery stages. A review reaches the user through submit_document with
 * at least one citation, and the call succeeds.
 */
function documentStages(events: AgentEvent[]): Progress {
  return [
    {
      label: "submit_document called with a citation",
      held: calls(events, "submit_document").some(
        (event) => (record(event.args).citations || []).length > 0,
      ),
    },
    {
      label: "submit_document succeeded",
      held: results(events, "submit_document").some((event) => event.ok),
    },
  ];
}

/** Which stages of the digest path the turn reached, in the order they run. */
export function literatureReviewDigestProgress(turn: Turn): Progress {
  const { events } = turn;
  const digests = digestResults(events);
  const finished = digests.some(
    (event) => (record(event.content).digestHandles || []).length > 0,
  );
  const last = record(digests.at(-1)?.content);
  return [
    {
      label: "task_update declared a digest part",
      held: declaredParts(events, "digest").length > 0,
    },
    { label: "a digest finished", held: finished },
    {
      label: "no digest left pending",
      held: finished && !(last.digestPending || []).length,
    },
    ...documentStages(events),
  ];
}

function describeProgress(progress: Progress): string {
  const names = (held: boolean) =>
    progress
      .filter((stage) => stage.held === held)
      .map((stage) => stage.label)
      .join("; ") || "none";
  return `Held: ${names(true)}. Not held: ${names(false)}.`;
}

/** Whether the model loaded the literature-review skill by its id. */
function literatureReviewSkillLoaded(turn: Turn): boolean {
  return calls(turn.events, "load_skill").some(
    (event) => record(event.args).id === "literature-review",
  );
}

/**
 * The parts the last task_update result still shows as open. A part is closed
 * when it is completed, skipped, blocked or cancelled; any other status
 * (pending, in_progress, waiting_for_user, interrupted, failed) is open.
 * Tools and the final answer may close a part after that result.
 */
function partsLeftOpen(turn: Turn): string[] {
  const parts = record(
    results(turn.events, "task_update").at(-1)?.content,
  ).parts;
  return (Array.isArray(parts) ? parts : [])
    .filter(
      (part: unknown) =>
        !["completed", "skipped", "blocked", "cancelled"].includes(
          record(part).status,
        ),
    )
    .map((part: unknown) => String(record(part).taskId));
}

/**
 * The parts still open when the run ended, from the run's own ledger events.
 * The runtime publishes the ledger as `execution_checkpoint` and
 * `execution_checkpoint_delta` events (`checkpointEvents.ts`), and its last
 * publication settles the ledger with the run's end state, turning every
 * pending part into skipped. The ledger just before that settling is what the
 * run left open; `openDeclaredOutcomes` is the host's own test for a part
 * still pending. Without any ledger event the status is unknown.
 */
function partsOpenAtEnd(turn: Turn): string {
  const fold = new ExecutionCheckpointFold();
  let beforeEnd: ReturnType<typeof fold.apply>;
  let final: ReturnType<typeof fold.apply>;
  for (const event of turn.events) {
    const ledger = fold.apply(event);
    if (
      event.type !== "execution_checkpoint" &&
      event.type !== "execution_checkpoint_delta"
    )
      continue;
    final = ledger;
    if (ledger && !ledger.end) beforeEnd = ledger;
  }
  if (!final) return "unknown (the turn carried no execution_checkpoint event)";
  const open = openDeclaredOutcomes(beforeEnd || final).map(
    (task) => task.taskId,
  );
  return `${open.join(", ") || "none"} (run end: ${final.end?.state || "not recorded"})`;
}

/**
 * What the turn reached, for every failure message and the journey's detail:
 * the stages, then the reported-only skill and open parts.
 */
function reportOf(turn: Turn, progress: Progress): string {
  const open = partsLeftOpen(turn);
  return [
    describeProgress(progress),
    `Skill loaded: ${literatureReviewSkillLoaded(turn) ? "yes" : "no"}.`,
    `Parts open at the last task_update: ${open.join(", ") || "none"}.`,
    `Parts open at the end: ${partsOpenAtEnd(turn)}.`,
  ].join(" ");
}

export function literatureReviewReport(turn: Turn): string {
  return reportOf(turn, literatureReviewDigestProgress(turn));
}

/** The agent_context_envelope payload the host emitted at the turn's start. */
function scopeEnvelope(turn: Turn): Record<string, any> {
  const envelope = turn.events.find(
    (event) =>
      event.type === "provider_event" &&
      event.providerType === "agent_context_envelope",
  );
  check(
    envelope,
    "The turn emitted no agent_context_envelope event; the scope cannot be checked",
  );
  return record(envelope && (envelope as any).payload);
}

/**
 * The precondition for the digest path: the turn reached the host as one
 * collection in scope and no selected paper. A selected paper makes the host
 * inline its full text, and the model then writes the review without a digest.
 * The driver already failed the turn if it did not complete.
 */
export function assertDigestPathReached(turn: Turn): void {
  const payload = scopeEnvelope(turn);
  const papers = Number(payload.selectedPaperCount);
  const collections = Number(payload.selectedCollectionCount);
  const counts = `selectedPaperCount ${payload.selectedPaperCount}, selectedCollectionCount ${payload.selectedCollectionCount}`;
  check(
    papers === 0,
    `Host inlined paper text; the digest path is not exercised (${counts}, fullTextPaperCount ${payload.fullTextPaperCount})`,
  );
  check(
    collections === 1,
    `The collection did not reach the host as the turn scope; the digest path is not exercised (${counts})`,
  );
}

/**
 * The precondition for the library step: nothing attached, so the host's turn
 * scope holds no paper, no collection and no tag, and the Agent must find and
 * choose the papers itself.
 */
export function assertLibraryScopeReached(turn: Turn): void {
  const payload = scopeEnvelope(turn);
  const counts = `selectedPaperCount ${payload.selectedPaperCount}, selectedCollectionCount ${payload.selectedCollectionCount}, selectedTagCount ${payload.selectedTagCount}, fullTextPaperCount ${payload.fullTextPaperCount}`;
  check(
    Number(payload.selectedPaperCount) === 0 &&
      Number(payload.selectedCollectionCount) === 0 &&
      Number(payload.selectedTagCount) === 0,
    `Something was attached to the turn; library chat with nothing attached is not exercised (${counts})`,
  );
}

/**
 * The collection review's pass condition: task_update declares a digest part,
 * a digest finishes, none is left pending, and submit_document delivers the
 * review with at least one citation and succeeds. A failure names the stages
 * the turn did reach.
 */
export function assertLiteratureReviewDigest(turn: Turn): void {
  const { events } = turn;
  const report = literatureReviewReport(turn);
  check(
    declaredParts(events, "digest").length > 0,
    `task_update never declared a digest part. ${report}`,
  );
  const finished = digestResults(events);
  check(
    finished.some(
      (event) => (record(event.content).digestHandles || []).length > 0,
    ),
    `No task_update result returned a finished digest. ${report}`,
  );
  const last = record(finished.at(-1)?.content);
  check(
    !(last.digestPending || []).length,
    `Digests left pending: ${(last.digestPending || []).join(", ")}. ${report}`,
  );
  const [cited, succeeded] = documentStages(events);
  check(
    cited.held,
    `submit_document was never called with a citation. ${report}`,
  );
  check(succeeded.held, `submit_document never succeeded. ${report}`);
}

type LibraryBranch = "digest" | "read" | "none";

/**
 * Which way the Agent chose to cover the papers it found: a digest part, or a
 * read part (a short review read paper by paper). A digest part wins when both
 * are declared.
 */
function libraryBranch(events: AgentEvent[]): LibraryBranch {
  if (declaredParts(events, "digest").length) return "digest";
  if (declaredParts(events, "read").length) return "read";
  return "none";
}

/** The papers the branch's parts name, for the report. */
function libraryTargets(events: AgentEvent[]): number[] {
  const branch = libraryBranch(events);
  return branch === "none" ? [] : partTargets(declaredParts(events, branch));
}

/** The stages of the branch the turn took, then the delivery stages. */
export function literatureReviewLibraryProgress(turn: Turn): Progress {
  const { events } = turn;
  const branch = libraryBranch(events);
  if (branch === "none")
    return [
      {
        label: "task_update declared a digest part or a read part",
        held: false,
      },
      ...documentStages(events),
    ];
  const targets = libraryTargets(events);
  if (branch === "digest") {
    const digests = digestResults(events);
    const finished = digests.some(
      (event) => (record(event.content).digestHandles || []).length > 0,
    );
    const last = record(digests.at(-1)?.content);
    return [
      {
        label: "task_update declared a digest part with targetIds",
        held: targets.length > 0,
      },
      { label: "a digest finished", held: finished },
      {
        label: "no digest left pending",
        held: finished && !(last.digestPending || []).length,
      },
      ...documentStages(events),
    ];
  }
  const read = papersRead(events);
  return [
    {
      label: `task_update declared a read part with 1 to ${LITERATURE_REVIEW_READ_LIMIT} targetIds`,
      held:
        targets.length > 0 && targets.length <= LITERATURE_REVIEW_READ_LIMIT,
    },
    {
      label: "paper_read read every declared target",
      held: targets.length > 0 && targets.every((id) => read.includes(id)),
    },
    {
      label: `paper_read read at most ${LITERATURE_REVIEW_READ_LIMIT} papers`,
      held: read.length <= LITERATURE_REVIEW_READ_LIMIT,
    },
    ...documentStages(events),
    {
      label: `the document cites at most ${LITERATURE_REVIEW_READ_LIMIT} papers`,
      held: papersCited(events).length <= LITERATURE_REVIEW_READ_LIMIT,
    },
  ];
}

/** The library step's report: branch, target count, stages, skill, open parts. */
export function literatureReviewLibraryReport(turn: Turn): string {
  const { events } = turn;
  const branch = libraryBranch(events);
  const read =
    branch === "read" ? ` Papers read: ${papersRead(events).length}.` : "";
  return `Branch: ${branch}; targets: ${libraryTargets(events).length}.${read} ${reportOf(turn, literatureReviewLibraryProgress(turn))}`;
}

/**
 * The library review's pass condition. Digest branch: a digest part with
 * targetIds, a finished digest, none pending. Read branch: no digest part, a
 * read part of at most four targetIds, each read, no more than four
 * papers read, and no more than four papers cited. Either branch ends in a cited, successful submit_document.
 */
export function assertLiteratureReviewLibrary(turn: Turn): void {
  const report = literatureReviewLibraryReport(turn);
  const missed = literatureReviewLibraryProgress(turn).find(
    (stage) => !stage.held,
  );
  check(!missed, `Stage not held: ${missed?.label}. ${report}`);
}

/** The regular items of the run's collection that have an attachment. */
function collectionPapers(ctx: JourneyContext): any[] {
  const source = Zotero.Collections.getByLibrary(
    ctx.fixtures.libraryID,
    true,
  ).find((c: any) => c.name === ctx.request.collection);
  return (source?.getChildItems(false) || []).filter(
    (item: any) => item.isRegularItem() && item.getAttachments().length,
  );
}

/**
 * A short review of the run's collection, scoped the way the composer scopes
 * it when a user picks a collection: one collection resource and no selected
 * paper. The step fills the fixture collection `mini-review` with six real
 * papers from `--collection` (Representation_Drift by default). Six exceeds
 * four, so the digest path runs, and bounds the cost.
 */
export async function literatureReviewDigestJourney(
  id: string,
  ctx: JourneyContext,
): Promise<StepOutcome | void> {
  const { fixtures: f, driver } = ctx;
  const papers = collectionPapers(ctx).slice(
    0,
    LITERATURE_REVIEW_DIGEST_PAPER_COUNT,
  );
  if (papers.length < LITERATURE_REVIEW_DIGEST_PAPER_COUNT)
    return {
      status: "BLOCKED",
      detail: `${ctx.request.collection} has ${papers.length} papers with attachments; the review needs ${LITERATURE_REVIEW_DIGEST_PAPER_COUNT}.`,
    };
  const scope = f.collections["mini-review"];
  for (const paper of papers) {
    paper.addToCollection(scope.id);
    await paper.saveTx();
  }
  assertExact(
    (scope.getChildItems(false) || []).length,
    LITERATURE_REVIEW_DIGEST_PAPER_COUNT,
    "Papers in the review collection",
  );
  const before = await snapshot();
  const turn = await driver.turn(
    id,
    `Write a short literature review of the collection "${scope.name}", with citations.`,
    "auto",
    {
      conversationKind: "global",
      selectedCollectionContexts: [
        {
          collectionId: scope.id,
          name: scope.name,
          libraryID: scope.libraryID,
        },
      ],
    },
  );
  assertDigestPathReached(turn);
  assertLiteratureReviewDigest(turn);
  assertExact(await snapshot(), before, "A review must not mutate the library");
  return {
    detail: `Collection scope reached the host. ${literatureReviewReport(turn)}`,
  };
}

/**
 * A short review in library chat with nothing attached: no paper, collection
 * or tag in scope, so the Agent searches the library and chooses the papers.
 * The run's collection only has to hold enough papers for a real review; the
 * step changes nothing in the library.
 */
export async function literatureReviewLibraryJourney(
  id: string,
  ctx: JourneyContext,
): Promise<StepOutcome | void> {
  const papers = collectionPapers(ctx);
  if (papers.length < LITERATURE_REVIEW_LIBRARY_MIN_PAPERS)
    return {
      status: "BLOCKED",
      detail: `${ctx.request.collection} has ${papers.length} papers with attachments; the review needs ${LITERATURE_REVIEW_LIBRARY_MIN_PAPERS}.`,
    };
  const before = await snapshot();
  const turn = await ctx.driver.turn(
    id,
    "Write a short literature review of the papers in my library on representational drift, with citations.",
    "auto",
    { conversationKind: "global" },
  );
  assertLibraryScopeReached(turn);
  assertLiteratureReviewLibrary(turn);
  assertExact(await snapshot(), before, "A review must not mutate the library");
  return {
    detail: `Nothing attached reached the host. ${literatureReviewLibraryReport(turn)}`,
  };
}
