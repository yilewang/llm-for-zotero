import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import {
  clearAllState,
  consumeWebChatConversationForceNewChat,
  markWebChatConversationForceNewChat,
  resetWebChatConversationSessionState,
} from "../src/modules/contextPanel/state";

const here = dirname(fileURLToPath(import.meta.url));

describe("webchat isolation", function () {
  afterEach(function () {
    clearAllState();
  });

  it("does not let the webchat mode chip switch paper/library modes", function () {
    const source = readFileSync(
      resolve(
        here,
        "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
      ),
      "utf8",
    );
    const handlerStart = source.indexOf("// --- Mode chip handler ---");
    const webchatGuard = source.indexOf(
      "if (!item || isNoteSession() || isWebChatMode()) return;",
      handlerStart,
    );
    const paperSwitch = source.indexOf(
      "void switchPaperConversation();",
      handlerStart,
    );
    const globalSwitch = source.indexOf(
      "void switchGlobalConversation",
      handlerStart,
    );

    assert.isAtLeast(handlerStart, 0);
    assert.isAtLeast(webchatGuard, handlerStart);
    assert.isBelow(webchatGuard, paperSwitch);
    assert.isBelow(webchatGuard, globalSwitch);
  });

  it("marks fresh webchat paper switches as new remote chats without clearing existing history", function () {
    const source = readFileSync(
      resolve(
        here,
        "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
      ),
      "utf8",
    );
    const switchStart = source.indexOf("const switchPaperConversation = async");
    const webchatBranch = source.indexOf("if (isWebChatMode()) {", switchStart);
    const webchatBlockEnd = source.indexOf(
      "} else {\n      await ensureConversationLoaded(item as Zotero.Item);",
      webchatBranch,
    );
    const webchatBlock = source.slice(webchatBranch, webchatBlockEnd);
    const markIsolated = source.indexOf(
      "webChatIsolatedConversationKeys.add(resolvedConversationKey);",
      webchatBranch,
    );
    const sessionGuard = webchatBlock.indexOf("const hadWebChatSession =");
    const guardedHistorySet = webchatBlock.indexOf("if (!hadWebChatSession) {");
    const setHistory = webchatBlock.indexOf(
      "chatHistory.set(resolvedConversationKey, []);",
      guardedHistorySet,
    );
    const freshGuardEnd = webchatBlock.indexOf(
      "}\n      loadedConversationKeys.add(resolvedConversationKey);",
      guardedHistorySet,
    );
    const freshSessionBlock = webchatBlock.slice(
      guardedHistorySet,
      freshGuardEnd,
    );
    const markNewChat = freshSessionBlock.indexOf(
      "markNextWebChatSendAsNewChat();",
    );
    const primeFreshChip = freshSessionBlock.indexOf(
      "primeFreshWebChatPaperChipState();",
    );
    const markLoaded = source.indexOf(
      "loadedConversationKeys.add(resolvedConversationKey);",
      webchatBranch,
    );
    const normalLoad = source.indexOf(
      "await ensureConversationLoaded(item as Zotero.Item);",
      webchatBranch,
    );

    assert.isAtLeast(switchStart, 0);
    assert.isAtLeast(webchatBranch, switchStart);
    assert.isAbove(webchatBlockEnd, webchatBranch);
    assert.isAtLeast(sessionGuard, 0);
    assert.isAtLeast(markIsolated, webchatBranch);
    assert.isAtLeast(guardedHistorySet, sessionGuard);
    assert.isAtLeast(setHistory, guardedHistorySet);
    assert.isAbove(freshGuardEnd, guardedHistorySet);
    assert.isAtLeast(markNewChat, 0);
    assert.isAtLeast(primeFreshChip, markNewChat);
    assert.isAtLeast(markLoaded, markIsolated);
    assert.isAtLeast(normalLoad, markLoaded);
  });

  it("blocks persisted paper history hydration while webchat is active", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const ensureStart = source.indexOf(
      "export async function ensureConversationLoaded",
    );
    const webchatGuard = source.indexOf(
      "isEffectiveWebChatRequest(item)",
      ensureStart,
    );
    const isolateCall = source.indexOf(
      "isolateWebChatConversationKey(",
      webchatGuard,
    );
    const loadedShortcut = source.indexOf(
      "if (loadedConversationKeys.has(conversationKey)) {",
      ensureStart,
    );
    const forkCacheLoad = source.indexOf(
      "await loadConversationForkLinkCache(conversationKey);",
      loadedShortcut,
    );
    const loadedReturn = source.indexOf("return;", forkCacheLoad);
    const storedLoad = source.indexOf(
      "loadStoredConversationByKey",
      ensureStart,
    );
    const lateIsolationCheck = source.indexOf(
      "webChatIsolatedConversationKeys.has(conversationKey)",
      storedLoad,
    );

    assert.isAtLeast(ensureStart, 0);
    assert.isAtLeast(webchatGuard, ensureStart);
    assert.isAtLeast(isolateCall, webchatGuard);
    assert.isBelow(isolateCall, loadedShortcut);
    assert.isBelow(loadedShortcut, forkCacheLoad);
    assert.isBelow(forkCacheLoad, loadedReturn);
    assert.isBelow(loadedShortcut, storedLoad);
    assert.isAtLeast(lateIsolationCheck, storedLoad);
  });

  it("keeps webchat turns out of persistent chat storage", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const flag = source.indexOf(
      'const shouldPersistTurn =\n    effectiveRequestConfig.providerProtocol !== "web_sync";',
    );
    const userPersist = source.indexOf(
      "if (shouldPersistTurn) {\n    void persistConversationMessage(",
      flag,
    );
    const assistantPersist = source.indexOf(
      "if (!shouldPersistTurn) return;",
      flag,
    );
    const webchatPipeline = source.indexOf(
      'if (effectiveRequestConfig.providerProtocol === "web_sync")',
      assistantPersist,
    );

    assert.isAtLeast(flag, 0);
    assert.isAtLeast(userPersist, flag);
    assert.isAtLeast(assistantPersist, userPersist);
    assert.isAtLeast(webchatPipeline, assistantPersist);
  });

  it("enters webchat through paper chat instead of library chat", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const entryStart = source.indexOf(
      'if (entry.authMode === "webchat" && !wasWebChat)',
    );
    const entryBlockEnd = source.indexOf(
      "// Show preloading screen to verify connectivity before enabling webchat",
      entryStart,
    );
    const entryBlock = source.slice(entryStart, entryBlockEnd);
    const paperSwitch = entryBlock.indexOf(
      "await ensureWebChatSessionPaperConversation();",
    );
    const webchatReset = entryBlock.indexOf(
      "resetCurrentWebChatConversation();",
    );

    assert.isAtLeast(entryStart, 0);
    assert.isAbove(entryBlockEnd, entryStart);
    assert.isAtLeast(paperSwitch, 0);
    assert.isAtLeast(webchatReset, 0);
    assert.isBelow(paperSwitch, webchatReset);
    assert.notInclude(entryBlock, "createAndSwitchGlobalConversation");
  });

  it("keeps webchat panel startup idempotent for an existing same-paper session", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const initStart = source.indexOf(
      "const initializeWebChatConversationForCurrentItem = () => {",
    );
    const initEnd = source.indexOf(
      "// Expose webchat intent clearing via hooks",
      initStart,
    );
    const initBlock = source.slice(initStart, initEnd);
    const hasSession = initBlock.indexOf("const hadWebChatSession =");
    const guardedSet = initBlock.indexOf("if (!hadWebChatSession) {");
    const setEmptyHistory = initBlock.indexOf(
      "chatHistory.set(key, []);",
      guardedSet,
    );
    const freshOnly = initBlock.indexOf(
      "if (!hadWebChatSession) {",
      setEmptyHistory,
    );
    const freshNewChat = initBlock.indexOf(
      "markNextWebChatSendAsNewChat();",
      freshOnly,
    );

    assert.isAtLeast(initStart, 0);
    assert.isAbove(initEnd, initStart);
    assert.isAtLeast(hasSession, 0);
    assert.isAtLeast(guardedSet, hasSession);
    assert.isAtLeast(setEmptyHistory, guardedSet);
    assert.isAtLeast(freshOnly, setEmptyHistory);
    assert.isAtLeast(freshNewChat, freshOnly);
  });

  it("skips webchat preload and history warm-up for an existing same-paper session", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );

    const helperStart = source.indexOf(
      "const hasExistingWebChatSessionForCurrentItem = () => {",
    );
    const helperEnd = source.indexOf(
      "// Expose webchat intent clearing via hooks",
      helperStart,
    );
    const helperBlock = source.slice(helperStart, helperEnd);
    assert.isAtLeast(helperStart, 0);
    assert.isAbove(helperEnd, helperStart);
    assert.include(
      helperBlock,
      "webChatIsolatedConversationKeys.has(key) && chatHistory.has(key)",
    );

    const warmupStart = source.indexOf(
      "// [webchat] Pre-fetch history in background",
    );
    const warmupCall = source.indexOf(
      "void warmUpWebChatHistory();",
      warmupStart,
    );
    const warmupGuard = source.lastIndexOf(
      "if (isWebChat && !hasExistingWebChatSessionForCurrentItem()) {",
      warmupCall,
    );
    assert.isAtLeast(warmupStart, 0);
    assert.isAtLeast(warmupCall, warmupStart);
    assert.isAtLeast(warmupGuard, warmupStart);

    const coldStartup = source.indexOf("[webchat] Cold startup");
    const preloadCall = source.indexOf("showWebChatPreloadScreen", coldStartup);
    const preloadGuard = source.indexOf(
      "if (isWebChatMode() && !hasExistingWebChatSessionForCurrentItem()) {",
      coldStartup,
    );
    assert.isAtLeast(coldStartup, 0);
    assert.isAtLeast(preloadGuard, coldStartup);
    assert.isAtLeast(preloadCall, preloadGuard);
  });

  it("keeps explicit webchat reset paths destructive", function () {
    const setupSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const resetStart = setupSource.indexOf(
      "const resetCurrentWebChatConversation = () => {",
    );
    const resetEnd = setupSource.indexOf(
      "const initializeWebChatConversationForCurrentItem = () => {",
      resetStart,
    );
    const resetBlock = setupSource.slice(resetStart, resetEnd);
    assert.isAtLeast(resetStart, 0);
    assert.isAbove(resetEnd, resetStart);
    assert.include(resetBlock, "chatHistory.set(key, []);");
    assert.include(resetBlock, "markNextWebChatSendAsNewChat();");
    assert.include(resetBlock, "clearTransientComposeStateForItem(item.id);");

    const controllerSource = readFileSync(
      resolve(
        here,
        "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
      ),
      "utf8",
    );
    const newButtonStart = controllerSource.indexOf(
      "historyNewBtn.addEventListener",
    );
    const webchatBranch = controllerSource.indexOf(
      "if (isWebChatMode()) {",
      newButtonStart,
    );
    const branchEnd = controllerSource.indexOf(
      "// Reuse an existing blank draft",
      webchatBranch,
    );
    const newChatBlock = controllerSource.slice(webchatBranch, branchEnd);

    assert.isAtLeast(newButtonStart, 0);
    assert.isAtLeast(webchatBranch, newButtonStart);
    assert.isAbove(branchEnd, webchatBranch);
    assert.include(newChatBlock, "markNextWebChatSendAsNewChat();");
    assert.include(newChatBlock, "chatHistory.set(key, []);");
    assert.include(newChatBlock, "clearTransientComposeStateForItem(item.id);");
  });

  it("shares the fresh-chat send flag by conversation key", function () {
    const conversationKey = 4242;

    markWebChatConversationForceNewChat(conversationKey);
    assert.isTrue(consumeWebChatConversationForceNewChat(conversationKey));
    assert.isFalse(consumeWebChatConversationForceNewChat(conversationKey));

    markWebChatConversationForceNewChat(conversationKey);
    resetWebChatConversationSessionState(conversationKey);
    assert.isFalse(consumeWebChatConversationForceNewChat(conversationKey));
  });

  it("does not block PDF attachment after restoring a WebChat", function () {
    const sendFlowSource = readFileSync(
      resolve(
        here,
        "../src/modules/contextPanel/setupHandlers/controllers/sendFlowController.ts",
      ),
      "utf8",
    );
    const historySource = readFileSync(
      resolve(
        here,
        "../src/modules/contextPanel/setupHandlers/controllers/webChatHistoryController.ts",
      ),
      "utf8",
    );

    assert.notInclude(sendFlowSource, "may already contain a different PDF");
    assert.notInclude(sendFlowSource, "differs from the PDF already attached");
    assert.notInclude(historySource, "PdfUploadStateUnknown");
  });

  it("does not restore normal paper history on webchat panel startup", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const restoreStart = source.indexOf(
      "restoreDraftInputForCurrentConversation();",
    );
    const webchatBranch = source.indexOf(
      "if (isWebChatMode()) {",
      restoreStart,
    );
    const paperBranch = source.indexOf(
      "} else if (isPaperMode()) {",
      webchatBranch,
    );
    const webchatBlock = source.slice(webchatBranch, paperBranch);

    assert.isAtLeast(restoreStart, 0);
    assert.isAtLeast(webchatBranch, restoreStart);
    assert.isAbove(paperBranch, webchatBranch);
    assert.include(
      webchatBlock,
      "initializeWebChatConversationForCurrentItem();",
    );
    assert.notInclude(webchatBlock, "switchPaperConversation()");
  });

  it("preserves an unsent webchat draft during panel state refreshes", function () {
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const setterStart = source.indexOf("const setDraftInputForConversation =");
    const persistStart = source.indexOf(
      "const persistDraftInputForCurrentConversation = () => {",
      setterStart,
    );
    const restoreStart = source.indexOf(
      "const restoreDraftInputForCurrentConversation = () => {",
      persistStart,
    );
    const clearStart = source.indexOf(
      "const clearDraftInputState =",
      restoreStart,
    );
    const setterBlock = source.slice(setterStart, persistStart);
    const persistBlock = source.slice(persistStart, restoreStart);
    const restoreBlock = source.slice(restoreStart, clearStart);
    const panelSyncStart = source.indexOf(
      "const syncConversationPanelState = () => {",
    );
    const panelSyncEnd = source.indexOf(
      "activeContextPanelStateSync.set(body, syncConversationPanelState);",
      panelSyncStart,
    );
    const panelSyncBlock = source.slice(panelSyncStart, panelSyncEnd);

    assert.isAtLeast(setterStart, 0);
    assert.isAbove(persistStart, setterStart);
    assert.isAbove(restoreStart, persistStart);
    assert.isAbove(clearStart, restoreStart);
    assert.notInclude(
      persistBlock,
      "if (isWebChatModeActive()) return;",
      "typed WebChat drafts must be cached",
    );
    assert.include(
      setterBlock,
      "webChatDraftInputCache",
      "WebChat drafts must remain isolated from normal paper-chat drafts",
    );
    assert.notInclude(
      restoreBlock,
      'inputBox.value = "";',
      "a background refresh must not erase a WebChat draft",
    );
    assert.include(
      restoreBlock,
      "webChatDraftInputCache",
      "panel refreshes must restore the isolated WebChat draft",
    );
    assert.include(
      panelSyncBlock,
      "restoreDraftInputForCurrentConversation();",
    );
  });

  it("keeps webchat models out of the retry pipeline at every gate", function () {
    const setupSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    const menuStart = setupSource.indexOf("const rebuildRetryModelMenu = ");
    assert.isAtLeast(menuStart, 0);
    const menuEnd = setupSource.indexOf(
      "retryModelMenu.appendChild(option);",
      menuStart,
    );
    const menuBlock = setupSource.slice(menuStart, menuEnd);
    assert.include(
      menuBlock,
      'entry.authMode !== "webchat"',
      "retry model menu must exclude webchat entries",
    );

    const chatSource = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const retryStart = chatSource.indexOf(
      "export async function retryLatestAssistantResponse(",
    );
    assert.isAtLeast(retryStart, 0);
    const retryEnd = chatSource.indexOf(
      "export async function editUserTurnAndRetry(",
      retryStart,
    );
    const retryBlock = chatSource.slice(retryStart, retryEnd);
    const resolvedGuard = retryBlock.indexOf(
      'effectiveRequestConfig.authMode === "webchat" ||',
    );
    const guardRestore = retryBlock.indexOf(
      "restoreRetryUserSnapshot(retryPair.userMessage, userSnapshot);",
      resolvedGuard,
    );
    const streamCall = retryBlock.indexOf("callLLMStream");
    assert.isAtLeast(
      resolvedGuard,
      0,
      "retry must refuse webchat models on the resolved config",
    );
    assert.isAbove(
      guardRestore,
      resolvedGuard,
      "the webchat bail-out must restore the reset turn snapshots",
    );
    assert.isAbove(
      streamCall,
      resolvedGuard,
      "the webchat gate must run before any model request is dispatched",
    );
  });
});
