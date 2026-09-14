import {
  resolveActiveNoteSession,
  resolveConversationBaseItem,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
  resolvePreferredConversationSystem,
} from "./portalScope";
import { getConversationKey } from "./conversationIdentity";
import type { ConversationSystem } from "../../shared/types";

export type PanelHostSurface = "reader" | "library" | "standalone";

export type PanelHostBinding = {
  surface: PanelHostSurface;
  tabType: string;
  tabID: string;
  libraryID: number;
  rawItemID: number;
  basePaperItemID: number;
  noteID: number;
  noteParentItemID: number;
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
    libraryID: normalizePositiveInt(item?.libraryID),
    rawItemID: normalizePositiveInt(item?.id),
    basePaperItemID: getRawBasePaperItemID(item),
    noteID: normalizePositiveInt(note?.noteId),
    noteParentItemID: normalizePositiveInt(note?.parentItemId),
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

/** The standalone mount controller deliberately owns its changing target. */
export function bindStandalonePanelHost(
  body: Element,
  item: Zotero.Item | null | undefined,
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
  });
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
  if (binding.surface === "standalone") return true;
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
  if (!mounted) return "unresolved";
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
    ztoolkit.log("LLM: panel ownership blocked", {
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
    const validEmptyHost = !binding.rawItemID && !binding.libraryID;
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
  if (binding.surface === "standalone") return true;
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
