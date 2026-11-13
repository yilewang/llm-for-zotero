export type Status =
  | "PASS"
  | "FAIL"
  | "BLOCKED"
  | "BLOCKED_BY_DEPENDENCY"
  | "REVIEW_REQUIRED"
  | "SKIPPED_BY_SELECTION";
export type Mode = "safe" | "auto" | "yolo";
export type ConfirmationExpectation = "none" | "approval" | "cancel" | "review";
export type StepOutcome = { status?: Status; detail?: string };
export type StepResult = {
  id: string;
  status: Status;
  detail: string;
  startedAt: string;
  durationMs: number;
};
export type BehaviorStep = {
  id: string;
  dependsOn: string[];
  run: () => Promise<StepOutcome | void>;
};

export function assertExact(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  const received = JSON.stringify(actual);
  const wanted = JSON.stringify(expected);
  const preview = (value: string | undefined) =>
    value && value.length > 1200
      ? `${value.slice(0, 1200)}… (see native snapshots for full state)`
      : value;
  if (received !== wanted) {
    throw new Error(
      `${label}: expected ${preview(wanted)}, got ${preview(received)}`,
    );
  }
}

export function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

export function failedTurnError(
  error: unknown,
  observedErrors: readonly string[],
): Error {
  return new Error(
    [
      ...observedErrors,
      error instanceof Error ? error.message : String(error),
    ].join("; "),
  );
}

export function confirmationDecision(
  _mode: Mode,
  expected: ConfirmationExpectation,
  kind: string,
  effectful = kind === "approval",
) {
  if (expected === "review" && kind === "review" && !effectful)
    return { approve: false };
  if (effectful && expected === "approval") return { approve: true };
  if (effectful && expected === "cancel") return { approve: false };
  return { approve: false, failure: "Unexpected confirmation" };
}

/**
 * A journey's own answer to a confirmation card: the button it presses and
 * the field values it sends, in the shape the real card resolves with
 * (`AgentConfirmationResolution`). `effect` marks an answer that approves a
 * Zotero change, so Safe mode counts it as an approval. Without `approved:
 * false` the answer approves.
 */
export type CardAnswer = {
  actionId?: string;
  approved?: boolean;
  data?: Record<string, unknown>;
  effect?: boolean;
};

/**
 * The ticked papers of a paper selection card: the field that lists them and
 * the ids of its rows that are checked, as the card submits them. A row is
 * ticked unless the card builder set `checked: false`; the rows of every mode
 * view count once.
 */
export function tickedPaperRows(action: Pick<AgentPendingAction, "fields">): {
  fieldId: string;
  rowIds: string[];
} {
  const field = action.fields.find(
    (entry) => entry.type === "paper_result_list",
  );
  check(field?.type === "paper_result_list", "The card lists no papers");
  const rows = [
    ...field.rows,
    ...(field.modes || []).flatMap((mode) => mode.rows),
  ];
  const ticked = rows
    .filter((row) => row.checked !== false)
    .map((row) => row.id);
  return { fieldId: field.id, rowIds: [...new Set(ticked)] };
}

/**
 * Answers a paper selection card with one of its buttons and its ticked
 * papers, as the card does when the user presses that button. The button must
 * be one the card declares, and at least one paper must be ticked (the card
 * disables a button with no paper ticked).
 */
export function paperCardAnswer(
  action: Pick<AgentPendingAction, "fields" | "actions" | "toolName">,
  actionId: string,
): CardAnswer {
  check(
    action.actions?.some((entry) => entry.id === actionId),
    `The ${action.toolName} card has no ${actionId} button; it has ${(action.actions || []).map((entry) => entry.id).join(", ") || "none"}`,
  );
  const { fieldId, rowIds } = tickedPaperRows(action);
  check(rowIds.length, `The ${action.toolName} card has no ticked paper`);
  return { actionId, data: { [fieldId]: rowIds } };
}

export function appendTurnHistory(
  history: ChatMessage[],
  prompt: string,
  answer: string,
): ChatMessage[] {
  return [
    ...history,
    { role: "user", content: prompt },
    { role: "assistant", content: answer },
  ];
}

export function assertApprovalProposal(
  action: Pick<AgentPendingAction, "toolName" | "title" | "fields">,
  proposal: unknown,
  activeItemId?: number,
  activeItemTitle?: string,
) {
  const args = proposal as Record<string, unknown> | undefined;
  const fieldValue = (id: string) => {
    const field = action.fields.find((entry) => entry.id === id);
    return field && "value" in field ? field.value : undefined;
  };
  if (action.toolName === "note_write") {
    check(
      args?.mode === "create" && args.target === "item",
      "Unexpected note operation",
    );
    check(
      activeItemId && args.targetItemId === activeItemId,
      "Note approval target differs from the requested paper",
    );
    const content = fieldValue("content");
    check(
      content && content === args.content,
      "Note review differs from the proposed final content",
    );
    return;
  }
  if (action.toolName === "file_io") {
    check(args?.action === "write", "Unexpected file operation");
    check(
      typeof args.filePath === "string" &&
        args.filePath &&
        fieldValue("path") === args.filePath,
      "File approval target differs from the proposed path",
    );
    check(
      typeof args.content === "string" &&
        fieldValue("preview") === args.content,
      "File review differs from the proposed content",
    );
    return;
  }
  if (action.toolName === "library_update" && args?.kind === "metadata") {
    check(
      activeItemId &&
        args.itemId === activeItemId &&
        activeItemTitle &&
        action.title === `Update metadata for ${activeItemTitle}`,
      "Metadata approval target differs from the requested paper",
    );
    check(
      args.metadata &&
        typeof args.metadata === "object" &&
        !Array.isArray(args.metadata),
      "Metadata approval has no proposed fields",
    );
    const proposed = Object.entries(args.metadata).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const displayed = action.fields
      .flatMap((field) =>
        field.type === "review_table"
          ? field.rows.map((row) => [row.key, row.after])
          : [],
      )
      .sort(([a], [b]) => a.localeCompare(b));
    check(proposed.length, "Metadata approval has no proposed fields");
    assertExact(displayed, proposed, "Metadata review fields");
    return;
  }
  check(fieldValue("targets"), "Approval card has no exact targets");
}

export async function runSteps(
  steps: BehaviorStep[],
  checkpoint: (rows: StepResult[]) => Promise<void> = async () => {},
) {
  const results: StepResult[] = [];
  for (const step of steps) {
    const started = Date.now();
    const blocked = step.dependsOn.filter(
      (id) =>
        !results.some(
          (r) => r.id === id && ["PASS", "REVIEW_REQUIRED"].includes(r.status),
        ),
    );
    let outcome: StepOutcome = {};
    if (blocked.length) {
      outcome = {
        status: "BLOCKED_BY_DEPENDENCY",
        detail: `Unsuccessful prerequisite(s): ${blocked.join(", ")}`,
      };
    } else {
      try {
        outcome = (await step.run()) || {};
      } catch (error) {
        outcome = {
          status: "FAIL",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    results.push({
      id: step.id,
      status: outcome.status || "PASS",
      detail: outcome.detail || "All machine assertions passed",
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    });
    await checkpoint([...results]);
  }
  return results;
}

export function reportExitCode(rows: Pick<StepResult, "status">[]): number {
  return rows.some((row) =>
    ["FAIL", "BLOCKED", "BLOCKED_BY_DEPENDENCY"].includes(row.status),
  )
    ? 1
    : 0;
}

export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string") {
    let text = value
      .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:api[_-]?key|token|secret)=)[^&#\s]+/gi, "$1[REDACTED]");
    for (const secret of secrets.filter(Boolean))
      text = text.split(secret).join("[REDACTED]");
    return text;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(api[_-]?key|authorization|password|accessToken|refreshToken|bearerToken)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redact(entry, secrets),
      ]),
    );
  return value;
}
import type { ChatMessage } from "../src/utils/llmClient";
import type { AgentPendingAction } from "../src/agent/types";
