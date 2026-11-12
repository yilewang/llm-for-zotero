import { appLogger } from "../../core/logging";
import { resolveActiveLibraryID } from "../../utils/zoteroLibraryScope";
import {
  resolveActiveNoteSession,
  resolveConversationBaseItem,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
  resolvePreferredConversationSystem,
} from "./portalScope";
import { COMPOSER_BOUND_KEYS } from "./composerKeyBindings";
import { getConversationKey } from "./conversationIdentity";
import type { ConversationSystem } from "../../shared/types";
import {
  parseSelectionSurface,
  type SelectionSurface,
  type TornSurface,
} from "./conversationSelection";

export type PanelHostSurface = "reader" | "library" | "standalone" | "side";

export type PanelHostBinding = {
  surface: PanelHostSurface;
  tabType: string;
  tabID: string;
  libraryID: number;
  rawItemID: number;
  basePaperItemID: number;
  noteID: number;
  noteParentItemID: number;
  /** The selection surface the panel reads and writes (conversationSelection.ts). */
  selectionSurface: SelectionSurface;
  generation: number;
};

export type ConversationScopeIdentity = {
  system: ConversationSystem;
  conversationKey: number;
  kind: "paper" | "global" | "note";
  libraryID: number;
  paperItemID: number;
  noteID: number;
  noteParentItemID: number;
  explicitGlobalMode: boolean;
};

export type PanelOwnershipVerdict =
  | "match"
  | "stale-candidate"
  | "host-mismatch"
  | "unresolved";

export type PanelOperationLease = {
  body: Element;
  hostGeneration: number;
  hostIdentity: string;
  selectedTabID: string;
  wasSelected: boolean;
};

const hostBindings = new WeakMap<Element, PanelHostBinding>();
const loggedVerdicts = new WeakMap<Element, Set<string>>();

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeTabID(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? `${value}`.trim()
    : "";
}

function getSelectedTabID(): string {
  try {
    return normalizeTabID(
      (Zotero as unknown as { Tabs?: { selectedID?: unknown } }).Tabs
        ?.selectedID,
    );
  } catch (_error) {
    return "";
  }
}

function getReaderTabID(body: Element): string {
  const owner = body.closest?.("[data-tab-id]") as Element | null;
  return normalizeTabID(owner?.getAttribute("data-tab-id"));
}

function getRawBasePaperItemID(item: Zotero.Item | null | undefined): number {
  if (!item) return 0;
  try {
    if ((item as any).isNote?.()) {
      return normalizePositiveInt(item.parentID);
    }
    if (item.isAttachment?.()) {
      return (
        normalizePositiveInt(item.parentID) || normalizePositiveInt(item.id)
      );
    }
  } catch (_error) {
    return 0;
  }
  return normalizePositiveInt(resolveConversationBaseItem(item)?.id);
}

function buildHostIdentity(binding: PanelHostBinding): string {
  return [
    binding.surface,
    binding.tabType,
    binding.tabID,
    binding.libraryID,
    binding.rawItemID,
    binding.basePaperItemID,
    binding.noteID,
    binding.noteParentItemID,
    binding.selectionSurface,
  ].join("|");
}

function buildLifecycleBinding(
  body: Element,
  item: Zotero.Item | null | undefined,
  tabType: unknown,
): Omit<PanelHostBinding, "generation"> {
  const normalizedTabType = `${tabType || ""}`;
  const tabID = getReaderTabID(body);
  const isReader =
    normalizedTabType.toLowerCase().includes("reader") || Boolean(tabID);
  const note = resolveActiveNoteSession(item);
  return {
    surface: isReader ? "reader" : "library",
    tabType: normalizedTabType,
    tabID,
    libraryID:
      normalizePositiveInt(item?.libraryID) ||
      (!isReader && !item ? normalizePositiveInt(resolveActiveLibraryID()) : 0),
    rawItemID: normalizePositiveInt(item?.id),
    basePaperItemID: getRawBasePaperItemID(item),
    noteID: normalizePositiveInt(note?.noteId),
    noteParentItemID: normalizePositiveInt(note?.parentItemId),
    selectionSurface: "embedded",
  };
}

function commitHostBinding(
  body: Element,
  next: Omit<PanelHostBinding, "generation">,
): PanelHostBinding {
  const previous = hostBindings.get(body);
  const unchanged =
    previous &&
    buildHostIdentity(previous) ===
      buildHostIdentity({ ...next, generation: previous.generation });
  if (unchanged) return previous;
  const binding: PanelHostBinding = {
    ...next,
    generation: (previous?.generation || 0) + 1,
  };
  hostBindings.set(body, binding);
  loggedVerdicts.delete(body);
  return binding;
}

/** The only production writer for embedded pane ownership. */
export function bindEmbeddedPanelHost(
  body: Element,
  item: Zotero.Item | null | undefined,
  tabType: unknown,
): PanelHostBinding {
  return commitHostBinding(body, buildLifecycleBinding(body, item, tabType));
}

/**
 * The standalone mount controller deliberately owns its changing target. A
 * torn-off window binds the same way under its own selection surface.
 */
export function bindStandalonePanelHost(
  body: Element,
  item: Zotero.Item | null | undefined,
  selectionSurface: "standalone" | TornSurface = "standalone",
): PanelHostBinding {
  const note = resolveActiveNoteSession(item);
  return commitHostBinding(body, {
    surface: "standalone",
    tabType: "standalone",
    tabID: "",
    libraryID: normalizePositiveInt(item?.libraryID),
    rawItemID: normalizePositiveInt(item?.id),
    basePaperItemID: getRawBasePaperItemID(item),
    noteID: normalizePositiveInt(note?.noteId),
    noteParentItemID: normalizePositiveInt(note?.parentItemId),
    selectionSurface,
  });
}

/**
 * The standalone window's temporary side chat. Like the window's own panel,
 * its mount controller owns its changing target, so any scope belongs to it.
 */
export function bindSidePanelHost(
  body: Element,
  item: Zotero.Item | null | undefined,
): PanelHostBinding {
  return commitHostBinding(body, {
    surface: "side",
    tabType: "side",
    tabID: "",
    libraryID: normalizePositiveInt(item?.libraryID),
    rawItemID: normalizePositiveInt(item?.id),
    basePaperItemID: getRawBasePaperItemID(item),
    noteID: 0,
    noteParentItemID: 0,
    selectionSurface: "side",
  });
}

/**
 * The one way a panel body declares itself the window's side chat. It sets
 * `data-side-panel` (and `data-standalone`, so it looks like the window's
 * panel) on the body and on its `#llm-main` root when that exists, and, given
 * the mounted item, binds the side host. A side body:
 * - resolves to the "side" selection surface (no slot, no pref writes);
 * - passes panel ownership like the window's panel;
 * - does not restore a paper conversation on mount;
 * - never registers as a Zotero "Add as context" target.
 * Call it before buildUI/setupHandlers, and again with the item once mounted.
 */
export function markSidePanelBody(
  body: Element,
  item?: Zotero.Item | null,
): void {
  const marked = [
    body as HTMLElement,
    body.querySelector?.("#llm-main") as HTMLElement | null,
  ];
  for (const element of marked) {
    if (!element?.dataset) continue;
    element.dataset.standalone = "true";
    element.dataset.sidePanel = "true";
  }
  if (item !== undefined) bindSidePanelHost(body, item);
}

/** Whether a body (or its panel root) was marked by markSidePanelBody. */
export function isSidePanelBody(body: Element | null | undefined): boolean {
  if (!body) return false;
  if ((body as HTMLElement).dataset?.sidePanel === "true") return true;
  if (hostBindings.get(body)?.surface === "side") return true;
  const root = body.querySelector?.("#llm-main") as HTMLElement | null;
  return root?.dataset?.sidePanel === "true";
}

/** Synthetic panels bypass Zotero lifecycle hooks, so tests bind explicitly. */
export function bindTestPanelHost(
  body: Element,
  item: Zotero.Item | null | undefined,
  tabType = "library-test",
): PanelHostBinding {
  return commitHostBinding(body, buildLifecycleBinding(body, item, tabType));
}

export function clearPanelHostBinding(body: Element): void {
  hostBindings.delete(body);
  loggedVerdicts.delete(body);
}

export function getPanelHostBinding(
  body: Element,
): PanelHostBinding | undefined {
  return hostBindings.get(body);
}

/** The surface a body or its panel root declares in `data-selection-surface`. */
function readDeclaredSelectionSurface(body: Element): SelectionSurface | null {
  const root = body.querySelector?.("#llm-main") as HTMLElement | null;
  return (
    parseSelectionSurface((body as HTMLElement).dataset?.selectionSurface) ||
    parseSelectionSurface(root?.dataset?.selectionSurface)
  );
}

/**
 * The selection surface a panel body reads and writes (see
 * conversationSelection.ts): the standalone window's panel is "standalone"; a
 * torn-off window's is its "torn:<id>"; the standalone window's side chat
 * (markSidePanelBody) is "side"; every sidebar panel — library item pane or
 * reader tab — is "embedded". The side marker decides first;
 * then the host binding once it exists; before that, the surface the body or
 * its panel root declares in `data-selection-surface`, and last the window's
 * `data-standalone` mark on its content area and panel root.
 */
export function resolveSelectionSurfaceForBody(
  body: Element | null | undefined,
): SelectionSurface {
  if (!body) return "embedded";
  if (isSidePanelBody(body)) return "side";
  const binding = hostBindings.get(body);
  if (binding) return binding.selectionSurface;
  const declared = readDeclaredSelectionSurface(body);
  if (declared) return declared;
  if ((body as HTMLElement).dataset?.standalone === "true") return "standalone";
  const root = body.querySelector?.("#llm-main") as HTMLElement | null;
  return root?.dataset?.standalone === "true" ? "standalone" : "embedded";
}

function resolveScopeForItem(
  item: Zotero.Item | null | undefined,
  explicitGlobalMode = false,
): ConversationScopeIdentity | null {
  if (!item) return null;
  const note = resolveActiveNoteSession(item);
  const kind = note
    ? "note"
    : resolveDisplayConversationKind(item) === "global"
      ? "global"
      : "paper";
  const basePaper = kind === "paper" ? resolveConversationBaseItem(item) : null;
  const conversationKey = normalizePositiveInt(getConversationKey(item));
  const libraryID = normalizePositiveInt(item.libraryID);
  if (!conversationKey || !libraryID) return null;
  return {
    system: note
      ? resolvePreferredConversationSystem({ item })
      : resolveConversationSystemForItem(item) ||
        resolvePreferredConversationSystem({ item }),
    conversationKey,
    kind,
    libraryID,
    paperItemID: normalizePositiveInt(
      kind === "note" ? note?.parentItemId : basePaper?.id,
    ),
    noteID: normalizePositiveInt(note?.noteId),
    noteParentItemID: normalizePositiveInt(note?.parentItemId),
    explicitGlobalMode,
  };
}

function resolveMountedScope(body: Element): ConversationScopeIdentity | null {
  const root = body.querySelector("#llm-main") as HTMLElement | null;
  if (!root) return null;
  const conversationKey = normalizePositiveInt(root.dataset.itemId);
  const libraryID = normalizePositiveInt(root.dataset.libraryId);
  const noteID = normalizePositiveInt(root.dataset.noteId);
  const noteParentItemID = normalizePositiveInt(root.dataset.noteParentItemId);
  const displayedKind = root.dataset.conversationKind;
  const kind = noteID
    ? "note"
    : displayedKind === "global"
      ? "global"
      : displayedKind === "paper"
        ? "paper"
        : null;
  if (!kind || !conversationKey || !libraryID) return null;
  return {
    system:
      root.dataset.conversationSystem === "claude_code" ||
      root.dataset.conversationSystem === "codex"
        ? root.dataset.conversationSystem
        : "upstream",
    conversationKey,
    kind,
    libraryID,
    paperItemID: normalizePositiveInt(root.dataset.basePaperItemId),
    noteID,
    noteParentItemID,
    explicitGlobalMode: displayedKind === "global",
  };
}

function scopeBelongsToHost(
  binding: PanelHostBinding,
  scope: ConversationScopeIdentity,
): boolean {
  if (binding.surface === "standalone" || binding.surface === "side") {
    return true;
  }
  if (!binding.libraryID || scope.libraryID !== binding.libraryID) return false;
  if (binding.noteID) {
    return (
      scope.kind === "note" &&
      scope.noteID === binding.noteID &&
      scope.noteParentItemID === binding.noteParentItemID
    );
  }
  if (scope.kind === "note") return false;
  if (scope.kind === "global") return scope.explicitGlobalMode;
  return (
    Boolean(binding.basePaperItemID) &&
    scope.paperItemID === binding.basePaperItemID
  );
}

function sameScope(
  left: ConversationScopeIdentity,
  right: ConversationScopeIdentity,
): boolean {
  return (
    left.system === right.system &&
    left.conversationKey === right.conversationKey &&
    left.kind === right.kind &&
    left.libraryID === right.libraryID &&
    left.paperItemID === right.paperItemID &&
    left.noteID === right.noteID &&
    left.noteParentItemID === right.noteParentItemID
  );
}

export function evaluatePanelOwnership(
  body: Element,
  candidateItem?: Zotero.Item | null,
): PanelOwnershipVerdict {
  const root = body.querySelector("#llm-main") as HTMLElement | null;
  const binding = hostBindings.get(body);
  if (!binding) {
    if (root?.dataset.standalone === "true") return "match";
    return "unresolved";
  }
  const mounted = resolveMountedScope(body);
  if (!mounted) {
    // A deliberately empty library panel may navigate to Library chat. It
    // cannot inherit a paper scope or authorize a candidate conversation.
    if (
      binding.surface === "library" &&
      binding.libraryID &&
      !binding.rawItemID &&
      root &&
      !root.dataset.itemId &&
      !root.dataset.conversationKind &&
      normalizePositiveInt(root.dataset.libraryId) === binding.libraryID
    )
      return candidateItem ? "stale-candidate" : "match";
    return "unresolved";
  }
  if (!scopeBelongsToHost(binding, mounted)) return "host-mismatch";
  if (!candidateItem) return "match";
  const candidate = resolveScopeForItem(
    candidateItem,
    resolveDisplayConversationKind(candidateItem) === "global",
  );
  if (!candidate || !scopeBelongsToHost(binding, candidate)) {
    return "stale-candidate";
  }
  return sameScope(mounted, candidate) ? "match" : "stale-candidate";
}

export function capturePanelOperationLease(
  body: Element,
): PanelOperationLease | null {
  const binding = hostBindings.get(body);
  if (!binding) {
    const root = body.querySelector("#llm-main") as HTMLElement | null;
    if (root?.dataset.handlersInitialized) return null;
    return {
      body,
      hostGeneration: 0,
      hostIdentity: "uninitialized",
      selectedTabID: getSelectedTabID(),
      wasSelected: false,
    };
  }
  const selectedTabID = getSelectedTabID();
  return {
    body,
    hostGeneration: binding.generation,
    hostIdentity: buildHostIdentity(binding),
    selectedTabID,
    wasSelected: Boolean(binding.tabID && binding.tabID === selectedTabID),
  };
}

export function isPanelOperationLeaseCurrent(
  lease: PanelOperationLease | null | undefined,
): boolean {
  if (!lease) return false;
  const current = hostBindings.get(lease.body);
  if (lease.hostGeneration === 0 && lease.hostIdentity === "uninitialized") {
    const root = lease.body.querySelector("#llm-main") as HTMLElement | null;
    return !current && !root?.dataset.handlersInitialized;
  }
  if (
    !current ||
    current.generation !== lease.hostGeneration ||
    buildHostIdentity(current) !== lease.hostIdentity
  ) {
    return false;
  }
  if (lease.wasSelected && current.tabID !== getSelectedTabID()) return false;
  return true;
}

function logOwnershipVerdict(
  body: Element,
  operation: string,
  verdict: PanelOwnershipVerdict,
): void {
  const binding = hostBindings.get(body);
  const mounted = resolveMountedScope(body);
  const generation = binding?.generation || 0;
  const key = `${generation}|${operation}|${verdict}`;
  const logged = loggedVerdicts.get(body) || new Set<string>();
  if (logged.has(key)) return;
  logged.add(key);
  loggedVerdicts.set(body, logged);
  try {
    appLogger.debug("LLM: panel ownership blocked", {
      operation,
      surface: binding?.surface || "unknown",
      tabType: binding?.tabType || "",
      tabID: binding?.tabID || "",
      hostLibraryID: binding?.libraryID || 0,
      hostPaperItemID: binding?.basePaperItemID || 0,
      hostNoteID: binding?.noteID || 0,
      mountedLibraryID: mounted?.libraryID || 0,
      mountedPaperItemID: mounted?.paperItemID || 0,
      mountedNoteID: mounted?.noteID || 0,
      conversationKey: mounted?.conversationKey || 0,
      verdict,
    });
  } catch (_error) {
    // Logging must never weaken the ownership fence.
  }
}

export function renderPanelOwnershipBlocked(
  body: Element,
  operation: string,
  verdict: Exclude<PanelOwnershipVerdict, "match" | "stale-candidate">,
): void {
  const root = body.querySelector("#llm-main") as HTMLElement | null;
  if (!root) return;
  logOwnershipVerdict(body, operation, verdict);
  root.dataset.ownershipBlocked = verdict;
  root.setAttribute("inert", "");
  root.setAttribute("aria-busy", "true");
  const chatBox = body.querySelector("#llm-chat-box") as HTMLElement | null;
  if (chatBox) {
    chatBox.replaceChildren();
    const state = body.ownerDocument?.createElement?.("div");
    if (state) {
      state.className = "llm-welcome";
      state.textContent = "Restoring this conversation…";
      chatBox.appendChild(state);
    }
  }
  const previews = body.querySelector(
    "#llm-context-previews",
  ) as HTMLElement | null;
  previews?.replaceChildren();
  for (const selector of [
    "#llm-token-usage",
    "#llm-history-bar",
    "#llm-title-static",
    "#llm-response-menu",
    "#llm-prompt-menu",
    "#llm-export-menu",
  ]) {
    const element = body.querySelector(selector) as HTMLElement | null;
    if (element) element.style.display = "none";
  }
  const status = body.querySelector("#llm-status") as HTMLElement | null;
  if (status) {
    status.textContent = "Restoring conversation…";
    status.className = "llm-status llm-status-sending";
  }
  for (const control of Array.from(
    root.querySelectorAll("button, input, textarea, select"),
  )) {
    (
      control as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
    ).disabled = true;
  }
}

/**
 * The controls that take the reader out of a panel which has lost ownership of
 * its own conversation. Pressing one re-resolves the panel's declared scope from
 * the conversation it is showing and then switches, so the fence must deliver
 * the event instead of destroying it — otherwise the reader has no way out.
 *
 * Both surfaces that render these controls give every button the shared
 * `llm-runtime-system-toggle` class on top of their own
 * (`llm-panel-runtime-system-toggle`, `llm-standalone-runtime-system-toggle`),
 * so the shared class is what this matches. The runtime badge opens a menu
 * (`#llm-runtime-menu`); its options are controls of the same kind.
 */
const OWNERSHIP_FENCE_EXEMPT_SELECTOR =
  "#llm-runtime-mode-toggle, #llm-runtime-menu, .llm-runtime-system-toggle";

function matchesWithin(target: unknown, selector: string): boolean {
  const element = target as {
    closest?: (selector: string) => unknown;
  } | null;
  if (!element || typeof element.closest !== "function") return false;
  try {
    return Boolean(element.closest(selector));
  } catch (_error) {
    return false;
  }
}

/**
 * Key combinations the application owns rather than the panel: Cmd+Q, Ctrl+W
 * and the other menu accelerators. A panel must never be able to stop Zotero
 * from being quit or a window from being closed, wherever focus happens to sit
 * — which is why this holds inside the composer too, and why the keys the
 * composer binds (`COMPOSER_BOUND_KEYS`, declared by the composer itself) are
 * excluded rather than the composer as a whole.
 */
function isApplicationCommandKeyEvent(event: Event): boolean {
  if (event?.type !== "keydown") return false;
  const keyEvent = event as Partial<KeyboardEvent>;
  if (keyEvent.metaKey !== true && keyEvent.ctrlKey !== true) return false;
  return !COMPOSER_BOUND_KEYS.has(`${keyEvent.key || ""}`);
}

/**
 * Events the panel ownership fence must let through even when it refuses the
 * rest of the panel's input. Everything else stays fenced: a panel that is
 * showing someone else's conversation must not act on typing or clicks.
 */
export function isOwnershipFenceExemptEvent(event: Event): boolean {
  if (!event) return false;
  if (matchesWithin(event.target, OWNERSHIP_FENCE_EXEMPT_SELECTOR)) return true;
  return isApplicationCommandKeyEvent(event);
}

/**
 * The panel ownership fence's whole decision, owned here so the fence in
 * `setupHandlers.ts` is a two-line adapter over it and the rule can be tested
 * as the fence actually runs it.
 */
export function shouldOwnershipFenceSwallowEvent(
  body: Element,
  item: Zotero.Item | null | undefined,
  event: Event,
): boolean {
  if (!item || !event) return false;
  if (isOwnershipFenceExemptEvent(event)) return false;
  return !requireCurrentPanelOwnership(body, item, `panel-${event.type}`);
}

export function requireCurrentPanelOwnership(
  body: Element,
  item: Zotero.Item | null | undefined,
  operation: string,
): boolean {
  const verdict = evaluatePanelOwnership(body, item);
  if (verdict === "match") return true;
  const root = body.querySelector("#llm-main") as HTMLElement | null;
  if (verdict === "unresolved" && !root?.dataset.handlersInitialized) {
    const displayedKey = normalizePositiveInt(root?.dataset.itemId);
    const candidateKey = item
      ? normalizePositiveInt(getConversationKey(item))
      : 0;
    return !displayedKey || !candidateKey || displayedKey === candidateKey;
  }
  if (verdict === "host-mismatch" || verdict === "unresolved") {
    renderPanelOwnershipBlocked(body, operation, verdict);
  } else {
    logOwnershipVerdict(body, operation, verdict);
  }
  return false;
}

export function canCommitPanelConversation(
  body: Element,
  targetItem: Zotero.Item | null | undefined,
  operation: string,
  lease?: PanelOperationLease | null,
): boolean {
  const currentVerdict = evaluatePanelOwnership(body);
  const root = body.querySelector("#llm-main") as HTMLElement | null;
  const isUninitialized = !root?.dataset.handlersInitialized;
  if (currentVerdict === "unresolved" && isUninitialized) {
    return !lease || isPanelOperationLeaseCurrent(lease);
  }
  if (currentVerdict !== "match") {
    if (currentVerdict === "host-mismatch" || currentVerdict === "unresolved") {
      renderPanelOwnershipBlocked(body, operation, currentVerdict);
    } else {
      logOwnershipVerdict(body, operation, currentVerdict);
    }
    return false;
  }
  if (lease && !isPanelOperationLeaseCurrent(lease)) {
    logOwnershipVerdict(body, operation, "stale-candidate");
    return false;
  }
  const binding = hostBindings.get(body);
  const target = resolveScopeForItem(
    targetItem,
    resolveDisplayConversationKind(targetItem) === "global",
  );
  if (!binding || !target || !scopeBelongsToHost(binding, target)) {
    logOwnershipVerdict(body, operation, "stale-candidate");
    return false;
  }
  return true;
}

/**
 * Lifecycle-only commit fence. Unlike a normal conversation commit, this may
 * replace an incompatible mounted scope because Zotero has already rebound
 * the panel host. It still requires the exact host generation and a target
 * scope that belongs to that host.
 */
export function canLifecycleCommitPanelConversation(
  body: Element,
  targetItem: Zotero.Item | null | undefined,
  operation: string,
  lease: PanelOperationLease | null | undefined,
): boolean {
  if (!lease || !isPanelOperationLeaseCurrent(lease)) {
    logOwnershipVerdict(body, operation, "stale-candidate");
    return false;
  }
  const binding = hostBindings.get(body);
  if (!binding) {
    logOwnershipVerdict(body, operation, "unresolved");
    return false;
  }
  if (!targetItem) {
    const validEmptyHost =
      !binding.rawItemID &&
      !binding.basePaperItemID &&
      !binding.noteID &&
      (!binding.libraryID || binding.surface === "library");
    if (!validEmptyHost) {
      logOwnershipVerdict(body, operation, "unresolved");
    }
    return validEmptyHost;
  }
  const target = resolveScopeForItem(
    targetItem,
    resolveDisplayConversationKind(targetItem) === "global",
  );
  if (!target || !scopeBelongsToHost(binding, target)) {
    logOwnershipVerdict(body, operation, "stale-candidate");
    return false;
  }
  return true;
}

export function isPanelHostCompatibleWithPaper(
  body: Element,
  paperItem: Zotero.Item | null | undefined,
): boolean {
  const binding = hostBindings.get(body);
  if (!binding) {
    const root = body.querySelector("#llm-main") as HTMLElement | null;
    return Boolean(paperItem) && !root?.dataset.handlersInitialized;
  }
  if (!paperItem) return false;
  if (binding.surface === "standalone" || binding.surface === "side") {
    return true;
  }
  if (binding.noteID) {
    return (
      binding.libraryID === normalizePositiveInt(paperItem.libraryID) &&
      binding.noteID === normalizePositiveInt(paperItem.id)
    );
  }
  return (
    binding.libraryID === normalizePositiveInt(paperItem.libraryID) &&
    binding.basePaperItemID === normalizePositiveInt(paperItem.id)
  );
}

export function getConversationScopeIdentityForTests(
  item: Zotero.Item,
): ConversationScopeIdentity | null {
  return resolveScopeForItem(item);
}
