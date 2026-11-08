/**
 * The Steps block of the Task progress drawer, a checklist: a built-in
 * action's steps and summary, the plan Codex keeps with its own checklist
 * tool, or a run's outcome ledger (each outcome with its pill and reason,
 * the papers it left out or the part that replaced it, a "not done" row for
 * the targets it left undone, and how the run ended).
 *
 * This is the one place step progress renders (the floating capsule, the
 * in-chat action "Working" card and the Codex checklist trace row it
 * replaces are gone). Updates patch the previous block in place,
 * matching task rows by id, so an open `<details>` row and the nodes a
 * reader is looking at survive every ledger update.
 */
import type { OutcomeException } from "../../../agent/execution/types";
import { OUTCOME_REASONS } from "../../../agent/loop/outcomes";
import { formatPaperDisplayLabel } from "../../../shared/paperDisplayLabels";
import { t } from "../../../utils/i18n";
import type { TaskProgressChecklist, TaskProgressStep } from "./store";

/** The badge symbol a plan or checklist step shows for its status. */
export const PLAN_STATUS_SYMBOLS: Record<string, string> = {
  pending: "",
  in_progress: "",
  waiting_for_user: "!",
  interrupted: "↻",
  completed: "✓",
  blocked: "!",
  failed: "×",
  skipped: "–",
  cancelled: "×",
};

/** The pill a task row shows for its status (English; rendered through t()). */
const PLAN_STATUS_PILLS: Record<string, string> = {
  completed: "Done",
  failed: "Failed",
  blocked: "Blocked",
  waiting_for_user: "Needs input",
  interrupted: "Interrupted",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

/** Reasons the host writes into a ledger; everything else is the model's or a receipt's own words. */
const HOST_REASONS: ReadonlySet<string> = new Set(
  Object.values(OUTCOME_REASONS),
);

/** An outcome's reason in the reader's language when the host wrote it. */
function outcomeReasonText(reason: string): string {
  return HOST_REASONS.has(reason) ? t(reason) : reason;
}

/**
 * A paper's "(creator, year)" label, read from Zotero; null for an id that
 * names no regular item, which then shows as written.
 */
export function resolveTaskPaperLabel(itemId: number): string | null {
  try {
    const item = Zotero.Items.get(itemId);
    if (!item || !item.isRegularItem()) return null;
    const field = (name: string) =>
      String(item.getField(name as never) || "").trim();
    return formatPaperDisplayLabel({
      title: field("title") || item.getDisplayTitle(),
      firstCreator: field("firstCreator"),
      year: field("date").match(/\b\d{4}\b/)?.[0],
    });
  } catch {
    // A library that cannot be read leaves the target as written.
    return null;
  }
}

/** Only presentation nodes are patched here; interactive controls keep their own listeners. */
function patchPresentation(target: HTMLElement, source: HTMLElement): void {
  for (const attr of Array.from(target.attributes)) {
    if (attr.name !== "open" && !source.hasAttribute(attr.name))
      target.removeAttribute(attr.name);
  }
  for (const attr of Array.from(source.attributes)) {
    if (attr.name !== "open" && target.getAttribute(attr.name) !== attr.value)
      target.setAttribute(attr.name, attr.value);
  }
  let cursor = target.firstChild;
  for (const next of Array.from(source.childNodes)) {
    if (!next) continue;
    const taskId = (next as HTMLElement).dataset?.taskId;
    if (taskId) {
      const match = Array.from(target.children).find(
        (child) => (child as HTMLElement).dataset.taskId === taskId,
      );
      if (match && match !== cursor) target.insertBefore(match, cursor);
      if (match) cursor = match;
      else {
        target.insertBefore(next, cursor);
        continue;
      }
    }
    if (
      cursor &&
      cursor.nodeType === next.nodeType &&
      cursor.nodeName === next.nodeName
    ) {
      if (cursor.nodeType === 3) {
        if (cursor.nodeValue !== next.nodeValue)
          cursor.nodeValue = next.nodeValue;
      } else patchPresentation(cursor as HTMLElement, next as HTMLElement);
      cursor = cursor.nextSibling;
    } else target.insertBefore(next, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    target.removeChild(cursor);
    cursor = next;
  }
}

/**
 * The header look of an outcome ledger's ending. A blocked ledger waits on
 * the user, so it takes the amber waiting look, not the red a blocked plan
 * shows.
 */
function outcomesHeaderStatus(
  end: TaskProgressChecklist["end"],
): string | undefined {
  return end === "blocked" ? "waiting_for_user" : end;
}

function checklistStatusLabel(checklist: TaskProgressChecklist): string {
  if (checklist.source === "outcomes") {
    switch (checklist.end) {
      case "completed":
        return t("Completed");
      case "completed_with_exceptions":
        return t("Completed with exceptions");
      case "blocked":
        return t("Needs your decision");
      case "interrupted":
        return t("Interrupted");
      case "failed":
        return t("Failed");
      case "cancelled":
        return t("Cancelled");
    }
    return t("In progress");
  }
  switch (checklist.outcome) {
    case "completed":
      return t("Completed");
    case "failed":
      return t("Failed");
    case "cancelled":
      return t("Cancelled");
  }
  return t("In progress");
}

/** Targets a not-done row names for one reason before it counts the rest. */
const NOT_DONE_NAMED_TARGETS = 5;

export type ChecklistRenderOptions = {
  /** A paper's "(creator, year)" label; a target it cannot name shows as written. */
  resolvePaperLabel?: (itemId: number) => string | null;
  /** Inside a card already headed "Steps": the head names only the action. */
  inStepsCard?: boolean;
};

/** How a not-done row names one target: a paper by its label, else as written. */
function targetLabel(
  target: string,
  resolvePaperLabel: ChecklistRenderOptions["resolvePaperLabel"],
): string {
  const item = /^item:(\d+)(?:#\d+)?$/.exec(target);
  if (!item || !resolvePaperLabel) return target;
  return resolvePaperLabel(Number(item[1])) || target;
}

/**
 * One reason and the targets it covers: "Reason: (Lee, 2020), item:99", the
 * first `NOT_DONE_NAMED_TARGETS` named and the rest counted.
 */
function targetsText(
  entry: OutcomeException,
  options: ChecklistRenderOptions,
): string {
  const reason = outcomeReasonText(entry.reason);
  if (!entry.targets.length) return reason;
  const named = entry.targets
    .slice(0, NOT_DONE_NAMED_TARGETS)
    .map((target) => targetLabel(target, options.resolvePaperLabel))
    .join(", ");
  const rest = entry.targets.length - NOT_DONE_NAMED_TARGETS;
  return rest > 0
    ? `${reason}: ${named} ${t("and {count} more").replace("{count}", `${rest}`)}`
    : `${reason}: ${named}`;
}

/** A translated "…: {reason}" with the reason as written, "$" included. */
function withReason(template: string, reason: string): string {
  return t(template).replace("{reason}", () => reason);
}

/**
 * An outcome's reason line: why it ended as it did ("Replaced: <reason>"
 * for a part another replaced), then each reason it left papers out for
 * ("Excluded: <reason>: <papers>"). Empty when it has none.
 */
function outcomeDetailText(
  step: TaskProgressStep,
  options: ChecklistRenderOptions,
): string {
  const parts: string[] = [];
  if (step.detail) {
    const reason = outcomeReasonText(step.detail);
    parts.push(
      step.outcome?.replaced
        ? withReason("Replaced: {reason}", reason)
        : reason,
    );
  }
  for (const entry of step.outcome?.excluded || []) {
    parts.push(withReason("Excluded: {reason}", targetsText(entry, options)));
  }
  return parts.join(" · ");
}

/**
 * A step row: badge, label, and, for an outcome, its reason and pill. A read,
 * a digest or a write over several targets counts them as evidence ticks
 * them, "Read each paper in Drift · 48 of 48", "Summarize each selected
 * paper · 7 of 12"; a part the answer completes ticks none. A part another
 * replaced reads "Replaced", not "Cancelled".
 */
function buildChecklistRow(
  doc: Document,
  step: TaskProgressStep,
  index: number,
  outcomes: boolean,
  options: ChecklistRenderOptions,
): HTMLElement {
  const row = doc.createElement("div");
  row.dataset.taskId = `step-${index + 1}`;
  row.className = `llm-plan-task llm-plan-task-${step.status}`;
  row.setAttribute("role", "listitem");
  const line = doc.createElement("div");
  line.className = "llm-plan-task-line";
  const badge = doc.createElement("span");
  badge.className = `llm-plan-task-badge llm-plan-task-badge-${step.status}`;
  badge.setAttribute("aria-hidden", "true");
  badge.textContent =
    PLAN_STATUS_SYMBOLS[step.status] ||
    (step.status === "in_progress" ? "" : `${index + 1}`);
  const content = doc.createElement("span");
  content.className = "llm-plan-task-content";
  const label = doc.createElement("span");
  label.className = "llm-plan-task-label";
  const outcome = step.outcome;
  const targets =
    outcome?.read || outcome?.write || outcome?.digest ? outcome.targets : 0;
  label.textContent =
    targets > 1
      ? `${step.label} · ${t("{done} of {total}")
          .replace("{done}", `${outcome!.doneTargets}`)
          .replace("{total}", `${targets}`)}`
      : step.label;
  content.appendChild(label);
  const detail = outcomes ? outcomeDetailText(step, options) : "";
  if (detail) {
    const reason = doc.createElement("span");
    reason.className = "llm-plan-task-original";
    reason.textContent = detail;
    content.appendChild(reason);
  }
  line.append(badge, content);
  if (outcomes) {
    const pill = doc.createElement("span");
    pill.className = `llm-plan-task-pill llm-plan-task-pill-${step.status}`;
    const pillText = step.outcome?.replaced
      ? "Replaced"
      : PLAN_STATUS_PILLS[step.status];
    pill.textContent = pillText ? t(pillText) : "";
    if (!pill.textContent) pill.hidden = true;
    line.appendChild(pill);
  }
  row.appendChild(line);
  return row;
}

/**
 * The row under an outcome that left targets undone: how many, and each
 * reason with the targets it covers.
 */
function buildNotDoneRow(
  doc: Document,
  step: TaskProgressStep,
  index: number,
  options: ChecklistRenderOptions,
): HTMLElement {
  const exceptions = step.outcome?.exceptions || [];
  const undone = new Set(exceptions.flatMap((entry) => entry.targets));
  const row = doc.createElement("div");
  row.dataset.taskId = `step-${index + 1}-not-done`;
  row.className = "llm-plan-task llm-plan-task-waiting_for_user";
  row.setAttribute("role", "listitem");
  const line = doc.createElement("div");
  line.className = "llm-plan-task-line";
  const badge = doc.createElement("span");
  badge.className = "llm-plan-task-badge llm-plan-task-badge-waiting_for_user";
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = PLAN_STATUS_SYMBOLS.waiting_for_user;
  const content = doc.createElement("span");
  content.className = "llm-plan-task-content";
  const label = doc.createElement("span");
  label.className = "llm-plan-task-label";
  label.textContent = t("{count} not done").replace(
    "{count}",
    `${undone.size}`,
  );
  const detail = doc.createElement("span");
  detail.className = "llm-plan-task-original";
  detail.textContent = exceptions
    .map((entry) => targetsText(entry, options))
    .join(" · ");
  content.append(label, detail);
  line.append(badge, content);
  row.appendChild(line);
  return row;
}

function buildChecklistContent(
  doc: Document,
  checklist: TaskProgressChecklist,
  options: ChecklistRenderOptions = {},
): HTMLElement {
  const outcomes = checklist.source === "outcomes";
  const content = doc.createElement("div");
  content.className = "llm-task-progress-steps-body";
  content.setAttribute("data-llm-checklist-run-id", checklist.runId);
  content.setAttribute("data-llm-checklist-source", checklist.source);
  const header = doc.createElement("div");
  header.className = "llm-plan-header";
  const heading = doc.createElement("div");
  heading.className = "llm-plan-heading";
  if (!options.inStepsCard || checklist.title) {
    const title = doc.createElement("h4");
    title.className = "llm-task-progress-steps-title";
    title.textContent = options.inStepsCard
      ? checklist.title
      : checklist.title
        ? `${t("Steps")} · ${checklist.title}`
        : t("Steps");
    heading.appendChild(title);
  }
  const status = doc.createElement("span");
  status.className = "llm-plan-status";
  status.textContent = checklistStatusLabel(checklist);
  status.dataset.status =
    (outcomes ? outcomesHeaderStatus(checklist.end) : checklist.outcome) ||
    "running";
  header.append(heading, status);
  const children: HTMLElement[] = [header];
  if (checklist.total > 0) {
    const progress = doc.createElement("div");
    progress.className = "llm-plan-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", t("Required task completion"));
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", `${checklist.total}`);
    progress.setAttribute("aria-valuenow", `${checklist.done}`);
    const track = doc.createElement("span");
    track.className = "llm-plan-progress-track";
    track.setAttribute("aria-hidden", "true");
    const fill = doc.createElement("span");
    fill.className = "llm-plan-progress-fill";
    fill.style.width = `${Math.round((checklist.done / checklist.total) * 100)}%`;
    track.appendChild(fill);
    progress.appendChild(track);
    children.push(progress);
  }
  const tasks = doc.createElement("div");
  tasks.className = "llm-plan-task-list";
  tasks.setAttribute("role", "list");
  checklist.steps.forEach((step, index) => {
    if (!step.label) return;
    tasks.appendChild(buildChecklistRow(doc, step, index, outcomes, options));
    if (outcomes && step.outcome?.exceptions.length) {
      tasks.appendChild(buildNotDoneRow(doc, step, index, options));
    }
  });
  children.push(tasks);
  if (outcomes && checklist.end === "interrupted") {
    const resume = doc.createElement("p");
    resume.className = "llm-plan-research-progress";
    resume.textContent = t("Say “continue” to resume.");
    children.push(resume);
  }
  if (checklist.summary) {
    const summary = doc.createElement("div");
    summary.className = "llm-plan-research-progress";
    summary.textContent = checklist.summary;
    children.push(summary);
  }
  if (checklist.detail) {
    const detail = doc.createElement("p");
    detail.className =
      checklist.outcome === "failed"
        ? "llm-plan-task-failure"
        : "llm-plan-research-progress";
    detail.textContent = checklist.detail;
    children.push(detail);
  }
  content.append(...children);
  return content;
}

/**
 * Render a checklist's Steps block into `host`, patching the block already
 * there when it shows the same run's steps.
 */
export function renderChecklistSteps(
  doc: Document,
  host: HTMLElement,
  checklist: TaskProgressChecklist,
  options: ChecklistRenderOptions = {},
): void {
  const next = buildChecklistContent(doc, checklist, options);
  const previous = host.firstChild as HTMLElement | null;
  if (
    previous &&
    previous.getAttribute?.("data-llm-checklist-run-id") === checklist.runId
  ) {
    patchPresentation(previous, next);
    return;
  }
  host.replaceChildren(next);
}
