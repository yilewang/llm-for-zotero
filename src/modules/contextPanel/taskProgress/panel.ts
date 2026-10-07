/**
 * Task progress in a mounted chat panel: binds the row and drawer that
 * `buildUI` placed, keeps each panel's view pointed at the conversation it
 * shows, and resolves the turn's scope listing from the library index.
 *
 * Also owns the request-lifecycle safety net: every request start marks the
 * conversation's run working, and a request that ends while its run is still
 * live settles it (completed, failed or cancelled) from what the turn left,
 * so the row never spins after its request is gone. Every request that ends
 * names its question (number and words) for the drawer's history.
 *
 * And the Task progress button (`toggleButton.ts`): a click shows or
 * hides the row for the conversation the panel shows. The choice belongs to
 * that panel and that conversation, in memory only: a new run in the
 * conversation leaves it as it is, and the panel showing another
 * conversation drops it, back to the automatic rule.
 */
import {
  listTaskPaperScope,
  type TaskPaperScopeListing,
} from "../../../agent/context/taskPaperScopeListing";
import { libraryIndexService } from "../../../services/libraryIndexService";
import {
  navigateChatToMessage,
  reconcileChatScroll,
} from "../chatScrollSnapshots";
import {
  chatHistory,
  getCancelledRequestId,
  getPendingRequestId,
  initializedConversationComposeContextKeys,
  isRequestPending,
  selectedCollectionContextCache,
  selectedPaperContextCache,
  selectedTagContextCache,
  subscribeRequestActivity,
} from "../state";
import type { Message } from "../types";
import { ensureTaskProgressHydrated } from "./history";
import { resolveMineruHint } from "./mineruHint";
import {
  beginTaskRun,
  completeTaskRun,
  endTaskRun,
  getTaskProgress,
  noteTaskQuestion,
  setTaskScope,
  subscribeTaskProgress,
  taskReadInDepth,
  taskTurnIndexFor,
} from "./store";
import { applyTaskProgressToggleState } from "./toggleButton";
import {
  mountTaskProgressView,
  type TaskProgressView,
  type TaskProgressViewInput,
} from "./view";
import {
  resolveTaskProgressTurnScope,
  shouldShowTaskProgress,
  type TaskProgressTurnContexts,
  type TaskProgressUserChoice,
} from "./visibility";

type MountedPanel = {
  view: TaskProgressView;
  /** The row the view is bound to; a rebuilt panel has a new one. */
  row: HTMLElement;
  conversationKey: number | null;
  /** The row can show in the conversation and mode shown (`toggleApplies`). */
  toggleApplies: boolean;
};

const panels = new Map<Element, MountedPanel>();

/**
 * The user's choice per panel body, for one conversation. Keyed by the body,
 * not the mounted view, so a panel rebuilt for the same conversation keeps
 * it; a closed window's body is collected with its entry.
 */
const userChoices = new WeakMap<
  Element,
  { conversationKey: number; choice: TaskProgressUserChoice }
>();

/** The Task progress button, per panel body it drives. */
const toggleButtons = new WeakMap<Element, HTMLButtonElement>();

/** The choice for the conversation shown; another one drops it. */
function userChoiceFor(
  body: Element,
  conversationKey: number,
): TaskProgressUserChoice | undefined {
  const stored = userChoices.get(body);
  if (!stored) return undefined;
  if (stored.conversationKey === conversationKey) return stored.choice;
  userChoices.delete(body);
  return undefined;
}

/** Whether the row can show at all: a conversation, not WebChat or a note. */
function toggleApplies(input: TaskProgressViewInput): boolean {
  const { conversationKind, isWebChat, isNoteSession } = input.visibility;
  return (
    Boolean(input.conversationKey) &&
    (conversationKind === "global" || conversationKind === "paper") &&
    !isWebChat &&
    !isNoteSession
  );
}

/**
 * What the context bar holds for a conversation: the papers, folders and tags
 * the next question will carry. Once the composer is set up for the
 * conversation this is the Task progress scope, before and after sending;
 * until then the latest question's contexts stand in.
 */
function composerContexts(
  conversationKey: number,
): TaskProgressTurnContexts | null {
  if (!initializedConversationComposeContextKeys.has(conversationKey)) {
    return null;
  }
  return {
    paperContexts: selectedPaperContextCache.get(conversationKey) || [],
    selectedCollectionContexts:
      selectedCollectionContextCache.get(conversationKey) || [],
    selectedTagContexts: selectedTagContextCache.get(conversationKey) || [],
  };
}

function latestUserMessage(conversationKey: number): Message | undefined {
  const history = chatHistory.get(conversationKey) || [];
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role === "user") return history[index];
  }
  return undefined;
}

/**
 * The question a request asked, once the request ended: the latest question
 * in the history, its number and its words. A send begins its request before
 * its question is added, so only now does the history hold it.
 */
function noteRequestQuestion(conversationKey: number): void {
  const history = chatHistory.get(conversationKey) || [];
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role !== "user" || message.compactMarker) continue;
    noteTaskQuestion(conversationKey, {
      turnIndex: taskTurnIndexFor(history, message),
      text: message.text,
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// Scope listing
// ---------------------------------------------------------------------------

const scopeLoads = new Map<string, Promise<void>>();
/** The index snapshot each listing was computed from. */
const listingSources = new WeakMap<TaskPaperScopeListing, object>();

/**
 * Resolve the scope's listing, and resolve it again whenever the library
 * index moved on since (a paper added to the folder, a tag applied): the
 * listing is recomputed from the attached contexts, never patched.
 */
function ensureScopeListing(
  conversationKey: number,
  signature: string,
  libraryID: number,
): void {
  const record = getTaskProgress(conversationKey);
  const scope = record?.scope;
  if (!scope || scope.signature !== signature || !libraryID) return;
  if (
    scope.listing &&
    listingSources.get(scope.listing) ===
      libraryIndexService.peekSnapshot(libraryID)
  ) {
    return;
  }
  const loadKey = `${conversationKey}\u0000${signature}`;
  if (scopeLoads.has(loadKey)) return;
  const load = (async () => {
    // Waits for pending item changes, so a paper added a moment ago is listed.
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const current = getTaskProgress(conversationKey)?.scope;
    if (!current || current.signature !== signature) return;
    if (current.listing && listingSources.get(current.listing) === snapshot) {
      return;
    }
    const listing: TaskPaperScopeListing = listTaskPaperScope(
      snapshot,
      current.contexts,
    );
    listingSources.set(listing, snapshot);
    setTaskScope(conversationKey, { ...current, listing });
  })()
    .catch(() => undefined)
    .finally(() => {
      scopeLoads.delete(loadKey);
    });
  scopeLoads.set(loadKey, load);
}

// ---------------------------------------------------------------------------
// Request lifecycle safety net
// ---------------------------------------------------------------------------

const requestStarts = new Map<number, number>();
let lifecycleInstalled = false;

function settleFromHistory(conversationKey: number, requestId: number): void {
  const record = getTaskProgress(conversationKey);
  if (!record) return;
  if (
    record.runState !== "working" &&
    record.runState !== "answering" &&
    record.runState !== "waiting"
  )
    return;
  if (requestId && getCancelledRequestId(conversationKey) >= requestId) {
    endTaskRun(conversationKey, "cancelled");
    return;
  }
  const history = chatHistory.get(conversationKey) || [];
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "assistant") {
    endTaskRun(conversationKey, "failed");
    return;
  }
  if (latest.text === "[Cancelled]") {
    endTaskRun(conversationKey, "cancelled");
    return;
  }
  if (latest.interrupted) {
    endTaskRun(conversationKey, "interrupted");
    return;
  }
  if (/^Error:/.test(latest.text || "")) {
    endTaskRun(conversationKey, "failed");
    return;
  }
  // Plain chat lists the scope only; citations mark papers only for a run
  // that recorded its reads.
  completeTaskRun(conversationKey, {
    runId: record.runId,
    quoteCitations:
      latest.runMode === "agent" ? latest.quoteCitations : undefined,
  });
}

/** Idempotent; the first mounted panel installs it (tests call it directly). */
export function installTaskProgressRequestLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  // An action, a Codex plan or a run's outcomes make the row apply
  // mid-conversation (a one-paper chat, or a library chat with nothing
  // added, included): its panels sync once so the scope lists.
  const stepsSeen = new Set<number>();
  subscribeTaskProgress((conversationKey) => {
    const record = getTaskProgress(conversationKey);
    if (!record) {
      stepsSeen.delete(conversationKey);
      return;
    }
    if (!record.planSeen || stepsSeen.has(conversationKey)) return;
    stepsSeen.add(conversationKey);
    syncTaskProgressPanelsForConversation(conversationKey);
  });
  subscribeRequestActivity((conversationKey) => {
    if (isRequestPending(conversationKey)) {
      requestStarts.set(conversationKey, getPendingRequestId(conversationKey));
      beginTaskRun(conversationKey, {
        turnIndex: taskTurnIndexFor(chatHistory.get(conversationKey)),
      });
    } else {
      const requestId = requestStarts.get(conversationKey) || 0;
      requestStarts.delete(conversationKey);
      noteRequestQuestion(conversationKey);
      settleFromHistory(conversationKey, requestId);
    }
    syncTaskProgressPanelsForConversation(conversationKey);
  });
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function resolvePanelInput(body: Element): TaskProgressViewInput | null {
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  if (!panelRoot) return null;
  const conversationKey = Math.floor(Number(panelRoot.dataset.itemId || 0));
  const kind = panelRoot.dataset.conversationKind;
  const conversationKind: "global" | "paper" | "" =
    kind === "global" || kind === "paper" ? kind : "";
  const libraryID = Math.floor(Number(panelRoot.dataset.libraryId || 0));
  const basePaperItemId = Math.floor(
    Number(panelRoot.dataset.basePaperItemId || 0),
  );
  const isWebChat = panelRoot.dataset.webchatMode === "true";
  const isNoteSession = Boolean(panelRoot.dataset.noteKind);
  const system = panelRoot.dataset.conversationSystem || "";
  const recordsReads =
    panelRoot.dataset.runtimeMode === "agent" ||
    system === "codex" ||
    system === "claude_code";
  if (!(conversationKey > 0)) {
    return {
      conversationKey: null,
      recordsReads,
      composerReady: true,
      visibility: {
        conversationKind: "",
        isWebChat,
        isNoteSession,
        collectionCount: 0,
        tagCount: 0,
        paperCount: 0,
      },
    };
  }
  // A conversation shown again rebuilds its record from what it persisted,
  // then its panels sync once more (the row may now apply).
  if (!isWebChat && !isNoteSession) {
    ensureTaskProgressHydrated(conversationKey, libraryID || undefined, () =>
      syncTaskProgressPanelsForConversation(conversationKey),
    );
  }
  const scope = resolveTaskProgressTurnScope({
    message:
      composerContexts(conversationKey) || latestUserMessage(conversationKey),
    conversationKind,
    libraryID,
    basePaperItemId,
  });
  const userChoice = userChoiceFor(body, conversationKey);
  const visibility = {
    conversationKind,
    isWebChat,
    isNoteSession,
    collectionCount: scope.collectionCount,
    tagCount: scope.tagCount,
    paperCount: scope.paperCount,
    ...(userChoice ? { userChoice } : {}),
  };
  const record = getTaskProgress(conversationKey);
  if (
    libraryID > 0 &&
    shouldShowTaskProgress({
      ...visibility,
      planSeen: Boolean(record?.planSeen),
      readInDepth: taskReadInDepth(record),
    })
  ) {
    const nothingAdded =
      !scope.paperCount && !scope.collectionCount && !scope.tagCount;
    const listed =
      record?.scope?.signature === scope.signature &&
      Boolean(record.scope.listing);
    setTaskScope(conversationKey, {
      signature: scope.signature,
      libraryID,
      contexts: scope.contexts,
      label: scope.label,
      // Nothing added to the context bar: no papers are listed (the agent
      // may still find some; those join the list as it reads them).
      ...(nothingAdded && !listed
        ? {
            listing: {
              libraryID,
              wholeLibrary: true,
              entries: [],
              totalItems: 0,
              listedItems: 0,
              truncated: false,
            },
          }
        : {}),
    });
    if (!nothingAdded) {
      ensureScopeListing(conversationKey, scope.signature, libraryID);
    }
  }
  return {
    conversationKey,
    recordsReads,
    // Until the context bar is set up for the conversation, the latest
    // question's contexts stand in: the row takes that change at once.
    composerReady:
      initializedConversationComposeContextKeys.has(conversationKey),
    visibility,
    ...(conversationKind === "paper" && basePaperItemId > 0
      ? { basePaperItemId }
      : {}),
  };
}

/** The longest of a computed `transition-duration` + `-delay` list, in ms. */
function transitionMs(style: CSSStyleDeclaration | null | undefined): number {
  const parse = (value: string | undefined) =>
    String(value || "")
      .split(",")
      .map((part) => {
        const text = part.trim();
        const number = parseFloat(text);
        if (!Number.isFinite(number)) return 0;
        return text.endsWith("ms") ? number : number * 1000;
      });
  const durations = parse(style?.transitionDuration);
  const delays = parse(style?.transitionDelay);
  let longest = 0;
  durations.forEach((duration, index) => {
    longest = Math.max(longest, duration + (delays[index] || 0));
  });
  return longest;
}

/** Bind the row and drawer `buildUI` placed in this panel. Idempotent. */
export function mountTaskProgressPanel(body: Element): TaskProgressView | null {
  installTaskProgressRequestLifecycle();
  for (const other of Array.from(panels.keys())) {
    if (other !== body && isGone(other)) disposeTaskProgressPanel(other);
  }
  const existing = panels.get(body);
  const row = body.querySelector(
    "#llm-task-progress",
  ) as HTMLButtonElement | null;
  const drawer = body.querySelector(
    "#llm-task-progress-drawer",
  ) as HTMLElement | null;
  const shell = body.querySelector("#llm-chat-shell") as HTMLElement | null;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLElement | null;
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  if (!row || !drawer || !shell || !chatBox || !panelRoot) return null;
  const curtain = row.closest(
    ".llm-task-progress-curtain",
  ) as HTMLElement | null;
  if (existing?.row === row) return existing.view;
  if (existing) {
    existing.view.dispose();
    panels.delete(body);
  }
  const win = body.ownerDocument?.defaultView;
  const mounted: MountedPanel = {
    view: null as never,
    row,
    conversationKey: null,
    toggleApplies: false,
  };
  mounted.view = mountTaskProgressView({
    doc: body.ownerDocument as Document,
    row,
    drawer,
    shell,
    chatBox,
    keyTarget: panelRoot,
    deps: {
      setTimeout: (callback, ms) =>
        (win || globalThis).setTimeout(callback, ms),
      clearTimeout: (handle) =>
        (win || globalThis).clearTimeout(handle as number),
      now: () => win?.performance?.now?.() ?? Date.now(),
      resolveMineru: resolveMineruHint,
      // The row came or went without a sync (a run's steps, a paper read in
      // depth): the button follows.
      onVisibilityChange: () => paintTaskProgressToggle(body),
      navigateToCitation: (card) => {
        const key = mounted.conversationKey;
        const navigated =
          key &&
          navigateChatToMessage({
            conversationKey: key,
            chatBox: chatBox as HTMLDivElement,
            targetElement: card,
            behavior: "auto",
            viewportOffsetTop: Math.max(0, chatBox.clientHeight / 3),
          });
        if (!navigated) card.scrollIntoView?.({ block: "center" });
      },
      layout: win
        ? {
            motionMs: () => transitionMs(win.getComputedStyle(drawer)),
            curtainMs: () =>
              curtain ? transitionMs(win.getComputedStyle(curtain)) : 0,
            chatStripPx: () =>
              parseFloat(win.getComputedStyle(chatBox)?.minHeight || "") || 0,
            observeResize: (target, onResize) => {
              const Observer = (win as any).ResizeObserver as
                | typeof ResizeObserver
                | undefined;
              if (!Observer) return () => undefined;
              const observer = new Observer(() => onResize());
              observer.observe(target);
              return () => observer.disconnect();
            },
            // Runs in the resize callback, after layout and before paint, so
            // a chat at the bottom stays there on every frame of the motion
            // and a chat being read keeps its anchor (the scroll owner's own
            // observer would correct one frame later).
            onChatResized: () => {
              const key = mounted.conversationKey;
              if (key) reconcileChatScroll(key, chatBox as HTMLDivElement);
            },
          }
        : undefined,
    },
  });
  panels.set(body, mounted);
  return mounted.view;
}

/** Re-point a panel's view at the conversation and mode it shows now. */
export function syncTaskProgressPanel(body: Element): void {
  const view = mountTaskProgressPanel(body);
  const mounted = panels.get(body);
  if (!view || !mounted) return;
  const input = resolvePanelInput(body);
  if (!input) return;
  mounted.conversationKey = input.conversationKey;
  mounted.toggleApplies = toggleApplies(input);
  view.setInput(input);
  paintTaskProgressToggle(body);
}

/**
 * The button's click: hide the row if it shows (by either rule), show it
 * otherwise, for the conversation the panel shows. The row moves as for any
 * change made in the conversation on screen.
 */
export function toggleTaskProgressPanel(body: Element): void {
  const mounted = panels.get(body);
  const conversationKey = mounted?.conversationKey;
  if (!mounted || !conversationKey || !mounted.toggleApplies) return;
  userChoices.set(body, {
    conversationKey,
    choice: mounted.view.isVisible() ? "hidden" : "shown",
  });
  syncTaskProgressPanel(body);
}

/**
 * Let a Task progress button (the standalone title bar's or the sidebar
 * header's) drive this panel body's row, and keep it pressed while the row
 * shows. Returns the unbinding, for the panel's close (before its teardown).
 */
export function bindTaskProgressToggle(
  body: Element,
  button: HTMLButtonElement,
): () => void {
  const onClick = (event: Event) => {
    event.preventDefault?.();
    toggleTaskProgressPanel(body);
  };
  button.addEventListener("click", onClick);
  toggleButtons.set(body, button);
  paintTaskProgressToggle(body);
  return () => {
    button.removeEventListener("click", onClick);
    if (toggleButtons.get(body) === button) toggleButtons.delete(body);
  };
}

function paintTaskProgressToggle(body: Element): void {
  const button = toggleButtons.get(body);
  // A closed window's button is never seen again.
  if (!button || isGone(body)) return;
  const mounted = panels.get(body);
  const applies = Boolean(mounted?.toggleApplies);
  applyTaskProgressToggleState(button, {
    applies,
    shown: applies && Boolean(mounted?.view.isVisible()),
  });
}

/**
 * A panel that left its document, or whose window closed. A closed window's
 * elements still report `isConnected` (to the dead document), so the window
 * is checked too.
 */
function isGone(body: Element): boolean {
  const view = body.ownerDocument?.defaultView;
  return !body.isConnected || !view || view.closed;
}

export function syncTaskProgressPanelsForConversation(
  conversationKey: number,
): void {
  for (const [body, mounted] of Array.from(panels)) {
    if (isGone(body)) {
      disposeTaskProgressPanel(body);
      continue;
    }
    if (mounted.conversationKey === conversationKey)
      syncTaskProgressPanel(body);
  }
}

export function getTaskProgressPanelView(
  body: Element,
): TaskProgressView | null {
  return panels.get(body)?.view || null;
}

/**
 * Re-sync every mounted panel and repaint it now (workflow harness): the
 * scope listing is re-resolved if the library index moved on.
 */
export function flushTaskProgressPanels(): void {
  for (const [body, mounted] of Array.from(panels)) {
    if (isGone(body)) {
      disposeTaskProgressPanel(body);
      continue;
    }
    syncTaskProgressPanel(body);
    mounted.view.flush();
  }
}

/** Called by the panel's own teardown, so a closed panel stops syncing. */
export function disposeTaskProgressPanel(body: Element): void {
  const mounted = panels.get(body);
  if (!mounted) return;
  mounted.view.dispose();
  panels.delete(body);
  // No panel, nothing to show or hide.
  paintTaskProgressToggle(body);
}

/** Mounted panels and the conversations they show (workflow harness). */
export function listMountedTaskProgressPanelsForTests(): Array<{
  conversationKey: number | null;
  gone: boolean;
  documentURI: string;
}> {
  return Array.from(panels, ([body, mounted]) => ({
    conversationKey: mounted.conversationKey,
    gone: isGone(body),
    documentURI: body.ownerDocument?.documentURI || "",
  }));
}
