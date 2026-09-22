import type { AgentActionSummaryResultCard } from "../../../agent/types";
import { createDocumentCardLayout } from "../documentCard";
import { bindActionSummaryDisclosureScroll } from "./actionSummaryDisclosureScroll";
import type { ActionCardEntry } from "./actionCardModel";
import {
  navigationTargetOf,
  renderObjectChip,
  renderProcessChips,
  renderSkipRow,
  renderTargetList,
  renderVerb,
  renderVerbWord,
} from "./actionCardChips";
import {
  attachActionCardNavigation,
  canNavigate,
  createZoteroNavigationHost,
  type NavigationHost,
} from "./actionCardNavigation";

// The projection that builds the card lives in `actionCardModel`; this module
// draws what it produced. Callers keep importing the builder from here until
// the panel is rewired to the model directly.
export { buildAgentActionSummaryCard } from "./actionCardModel";

let nextActionListId = 0;
const INLINE_ACTION_LIMIT = 4;

/**
 * How the card is drawn beyond its rows.
 *
 * `mode` is the surface it is drawn for: the turn's own card, or the note the
 * same rows are reused for when the note is all the turn did. `header`
 * overrides the card's title and pill for that other surface, and
 * `renderDetail` gives a row that carries a detail the body it opens.
 */
export type ActionCardRenderOptions = {
  mode?: "action" | "note";
  header?: {
    title: string;
    status: string;
    statusKind: string;
    extraClass?: string;
  };
  renderDetail?: (
    doc: Document,
    entry: ActionCardEntry,
    status: HTMLElement,
  ) => HTMLElement | null;
  /** Where a clicked chip takes the reader; the running Zotero by default. */
  navigation?: NavigationHost;
};

/**
 * What the pill says about the turn as a whole.
 *
 * A turn is only "completed" when every row landed everything it named and
 * proved it. A target the run refused, an effect that landed only part of what
 * it asked for, or an effect no read-back confirmed, makes it partial: the
 * reader is told the turn did less than it claims.
 */
function cardStatus(
  card: AgentActionSummaryResultCard,
): "completed" | "partial" {
  const partial = card.entries.some(
    (entry) =>
      entry.rejected.length ||
      entry.partial ||
      entry.verification === "unverified",
  );
  return partial ? "partial" : "completed";
}

/**
 * One row: the items it covered, what happened to them, and its verdict.
 *
 * The objects come first because they are the row's subject — "these two
 * papers" — and each effect follows as its glyph and the object it acted on.
 * A row whose receipts refused a target states that refusal on its own line
 * underneath, so the verdict beside the effects is never read as covering it.
 */
function renderRowLine(
  doc: Document,
  entry: ActionCardEntry,
  hasDetail: boolean,
): HTMLElement {
  const row = doc.createElement("div");
  row.className = "llm-agent-action-summary-item";
  if (entry.targets.length)
    row.appendChild(renderTargetList(doc, entry.targets));
  const effects = doc.createElement("div");
  effects.className = "llm-agent-action-effects";
  for (const effect of entry.effects) {
    const node = doc.createElement("span");
    node.className = "llm-agent-action-effect";
    node.dataset.receiptId = effect.receiptId;
    // The operation's word belongs to the effect, not to its glyph: an
    // operation drawn without one — a note write, a file write — must still
    // say what it was to a reader who points at it.
    node.setAttribute("title", effect.label);
    const nameless = !effect.objects.length;
    const verb = renderVerb(doc, effect.verb, effect.label, nameless);
    if (verb) node.appendChild(verb);
    for (const object of effect.objects)
      node.appendChild(renderObjectChip(doc, object));
    // An effect that named no object would otherwise be a glyph pointing at
    // nothing, or nothing at all; its word is shown in their place.
    if (nameless && !verb)
      node.appendChild(renderVerbWord(doc, effect.label, true));
    effects.appendChild(node);
  }
  row.appendChild(effects);
  if (entry.badges.length)
    row.appendChild(renderProcessChips(doc, entry.badges));
  if (hasDetail) {
    const marker = doc.createElement("span");
    marker.className = "llm-agent-action-row-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = "›";
    row.appendChild(marker);
  }
  if (entry.rejected.length)
    row.appendChild(renderSkipRow(doc, entry.rejected, entry.rejectedReason));
  return row;
}

/** The run's effects, closing the conversation turn after its answer. */
export function renderActionSummaryCard(
  doc: Document,
  card: AgentActionSummaryResultCard,
  options: ActionCardRenderOptions = {},
): HTMLElement {
  const container = doc.createElement("section");
  container.className = `llm-plan-container llm-agent-action-summary-card${
    options.header?.extraClass ? ` ${options.header.extraClass}` : ""
  }`;
  container.dataset.mode = options.mode || "action";
  const { header, title, status, actions } = createDocumentCardLayout(
    doc,
    options.header || {
      title: "What this turn did",
      status: `${card.actionCount} action${card.actionCount === 1 ? "" : "s"}`,
      statusKind: cardStatus(card),
    },
  );
  if (!options.header) {
    const icon = doc.createElement("span");
    icon.className = "llm-agent-action-summary-icon";
    icon.setAttribute("aria-hidden", "true");
    title.insertBefore(icon, title.firstChild);
  }
  container.appendChild(header);
  const list = doc.createElement("ul");
  list.className = "llm-agent-action-summary-list";
  if (options.mode !== "note" && card.entries.length > INLINE_ACTION_LIMIT) {
    list.id = `llm-action-summary-list-${++nextActionListId}`;
    const toggle = doc.createElement("button");
    toggle.className = "llm-plan-action llm-agent-action-summary-toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-controls", list.id);
    const setExpanded = (expanded: boolean) => {
      list.hidden = !expanded;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.textContent = expanded ? "Hide actions" : "Show actions";
    };
    setExpanded(false);
    bindActionSummaryDisclosureScroll(toggle);
    toggle.addEventListener("click", () => setExpanded(list.hidden));
    actions.appendChild(toggle);
  }
  for (const entry of card.entries) {
    const item = doc.createElement("li");
    const renderDetail = entry.detail ? options.renderDetail : undefined;
    const commands = entry.effects.flatMap((effect) =>
      effect.command ? [effect.command] : [],
    );
    if (!renderDetail && !commands.length) {
      item.appendChild(renderRowLine(doc, entry, false));
      list.appendChild(item);
      continue;
    }
    // A row with a body is a disclosure: its line is the summary the reader
    // clicks, and the body opens under it.
    const details = doc.createElement("details") as HTMLDetailsElement;
    details.className = "llm-agent-action-row";
    const summary = doc.createElement("summary");
    summary.appendChild(renderRowLine(doc, entry, true));
    bindActionSummaryDisclosureScroll(summary);
    const body = doc.createElement("div");
    body.className = "llm-agent-process-stage-body llm-agent-action-row-body";
    details.append(summary, body);
    const buildBody = (detailStatus: HTMLElement) => {
      for (const command of commands) {
        const pre = doc.createElement("pre");
        pre.className =
          "llm-agent-process-detail-value-code llm-agent-action-command";
        const code = doc.createElement("code");
        code.textContent = command;
        pre.appendChild(code);
        body.appendChild(pre);
      }
      const detail = renderDetail?.(doc, entry, detailStatus);
      if (detail) body.appendChild(detail);
    };
    if (options.mode === "note") {
      // The note surface shows the body straight away, because the note is
      // what the reader came for, and its outcome goes to the card's own pill.
      details.open = true;
      buildBody(status);
    } else {
      // A folded row builds its body the first time it is opened. The note
      // body reads the note and its journal back from disk, and a card of rows
      // must not start those reads for every row on every render. Its outcome
      // has no card pill to go to, so the row is given one of its own.
      const rowStatus = doc.createElement("span");
      rowStatus.className = "llm-plan-status";
      body.appendChild(rowStatus);
      let built = false;
      details.addEventListener("toggle", () => {
        if (built || !details.open) return;
        built = true;
        buildBody(rowStatus);
      });
    }
    item.appendChild(details);
    list.appendChild(item);
  }
  container.appendChild(list);
  // A chip is only a link where the reader can actually be taken: a tag with
  // no tag selector on screen, or an object this window cannot reach, is left
  // as the plain chip it is rather than one that would click for nothing.
  const navigation = options.navigation || createZoteroNavigationHost();
  const links = Array.from(
    container.querySelectorAll(".llm-agent-action-link"),
  ) as HTMLElement[];
  for (const link of links) {
    const target = navigationTargetOf(link);
    if (target && canNavigate(target, navigation)) continue;
    link.classList.remove("llm-agent-action-link");
    link.removeAttribute("role");
    link.removeAttribute("tabindex");
    // The chip no longer claims a destination, so nothing downstream reads one
    // off it either.
    delete link.dataset.llmNav;
    link.querySelector(".llm-citation-icon")?.remove();
  }
  attachActionCardNavigation(container, status, navigation);
  if (card.answerMaterial) {
    const source = doc.createElement("div");
    source.className = "llm-agent-action-summary-source";
    source.textContent = `Answer written from “${card.answerMaterial}”`;
    container.appendChild(source);
  }
  return container;
}
