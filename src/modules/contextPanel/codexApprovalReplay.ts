import { resolveCodexNativeApprovalWithOptionalReviewCard } from "./codexNative/turnCallbacks";
import { requireCurrentPanelOwnership } from "./panelHostOwnership";

const ZOTERO_SERVER = "llm_for_zotero_profile_abc123";

/**
 * The payload Codex 0.164 sends for a Zotero MCP tool approval (captured
 * 2026-10-31; only the server name and the ids differ): a library_update
 * that proposes one tag on a fixture item.
 */
function zoteroWriteApproval(itemId: number, tag: string) {
  return {
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-capture",
      turnId: "turn-capture",
      serverName: ZOTERO_SERVER,
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_description: "Add a tag to a probe item. Writes data.",
        tool_params: { kind: "tags", itemIds: [itemId], add: [tag] },
        tool_params_display: [{ name: "tag", value: tag, display_name: "tag" }],
      },
      message: `Allow the ${ZOTERO_SERVER} MCP server to run tool "library_update"?`,
      requestedSchema: { type: "object", properties: {} },
    },
    zoteroMcpServerName: ZOTERO_SERVER,
  } as never;
}

export type CodexApprovalCaseResult = {
  response: unknown;
  statuses: Array<{ text: string; kind: string }>;
  /** Inline review cards left in the chat box when the call returned. */
  cardsAfter: number;
  /** Cards seen while the call was pending (0 when none was rendered). */
  cardsWhilePending: number;
};

/**
 * Run the real Codex native approval bridge for a Zotero write under the
 * production ownership check and the real inline card, in three situations
 * where it must answer with Codex's decline: the card UI is missing, the
 * panel already belongs to another chat, and the panel changes owner while
 * the card is open. `switchToOtherPanel` moves the panel to another paper.
 */
export async function exerciseCodexApprovalFailClosed(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    itemId: number;
    tag: string;
    switchToOtherPanel: () => Promise<void>;
  },
): Promise<{
  unavailable: CodexApprovalCaseResult;
  staleWhileOpen: CodexApprovalCaseResult & {
    cardWasRendered: boolean;
    oldCardStillConnected: boolean;
    settledOnItsOwn: boolean;
  };
  alreadyStale: CodexApprovalCaseResult;
}> {
  const { body, item } = panel;
  const request = zoteroWriteApproval(input.itemId, input.tag);
  const chat = () => body.querySelector<HTMLElement>("#llm-chat-box");
  const cardCount = () =>
    chat()?.querySelectorAll(".llm-action-inline-card").length ?? 0;
  const run = async (
    isCurrent: () => boolean,
    statuses: Array<{ text: string; kind: string }>,
  ) =>
    resolveCodexNativeApprovalWithOptionalReviewCard({
      body,
      request,
      setStatusSafely: (text, kind) => statuses.push({ text, kind }),
      isCurrent,
    });
  const current = () =>
    requireCurrentPanelOwnership(body, item, "agent-confirmation");

  // (a) The chat box is gone, so the real card cannot be shown.
  const unavailableStatuses: Array<{ text: string; kind: string }> = [];
  const chatBox = chat()!;
  const parent = chatBox.parentNode!;
  const next = chatBox.nextSibling;
  chatBox.remove();
  let unavailable: CodexApprovalCaseResult;
  try {
    const response = await run(current, unavailableStatuses);
    unavailable = {
      response,
      statuses: unavailableStatuses,
      cardsAfter: body.querySelectorAll(".llm-action-inline-card").length,
      cardsWhilePending: 0,
    };
  } finally {
    parent.insertBefore(chatBox, next);
  }

  // (c) The card is open; the panel switches to another paper; the user
  // clicks Approve on the old card.
  const openStatuses: Array<{ text: string; kind: string }> = [];
  const pending = run(current, openStatuses);
  let cardsWhilePending = 0;
  for (let i = 0; i < 40 && !cardsWhilePending; i++) {
    await Zotero.Promise.delay(25);
    cardsWhilePending = cardCount();
  }
  const oldCard = chat()?.querySelector<HTMLElement>(".llm-action-inline-card");
  await input.switchToOtherPanel();
  const oldCardStillConnected = Boolean(oldCard?.isConnected);
  const approve = oldCard?.querySelector<HTMLButtonElement>(
    '[data-action-id="approve"], .llm-plan-approve',
  );
  // Does the call settle by itself once the panel switched, before any click?
  const settledOnItsOwn = await Promise.race([
    pending.then(() => true),
    Zotero.Promise.delay(300).then(() => false),
  ]);
  // The switch detaches the old card, so this click is the late answer of a
  // user who pressed Approve just as the panel changed owner.
  approve?.click();
  const staleResponse = await Promise.race([
    pending,
    Zotero.Promise.delay(3000).then(() => "__timeout__"),
  ]);
  const staleWhileOpen = {
    response: staleResponse,
    statuses: openStatuses,
    cardsAfter: cardCount(),
    cardsWhilePending,
    cardWasRendered: Boolean(oldCard) && Boolean(approve),
    oldCardStillConnected,
    settledOnItsOwn,
  };

  // (b) The panel already belongs to the other paper.
  const staleStatuses: Array<{ text: string; kind: string }> = [];
  const staleResponse2 = await run(current, staleStatuses);
  const alreadyStale = {
    response: staleResponse2,
    statuses: staleStatuses,
    cardsAfter: cardCount(),
    cardsWhilePending: 0,
  };
  return { unavailable, staleWhileOpen, alreadyStale };
}
