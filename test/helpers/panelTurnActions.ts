/**
 * Panel actions a user takes on a turn, driven through the panel's own DOM:
 * send from the composer, re-send the latest turn (Retry, or Edit and Send),
 * and switch the paper chip to the PDF file. Shared by the workflow tests
 * and the live tests, which differ only in who answers the turn.
 */

declare const Zotero: any;

/**
 * The workflow API's reset captures panel sends before the model call; the
 * actions here are real sends, so they let them through first.
 */
function letSendsThrough(): void {
  Zotero.LLMForZotero.api.workflowTest.passPanelSendsThrough();
}

function panelElement(panelId: string): HTMLElement {
  const docs = [
    Zotero.getMainWindow?.()?.document,
    (globalThis as { document?: Document }).document,
  ].filter(Boolean) as Document[];
  for (const doc of docs) {
    const element = doc.querySelector(
      `[data-workflow-panel-id="${panelId}"]`,
    ) as HTMLElement | null;
    if (element) return element;
  }
  throw new Error(`Panel ${panelId} is not in the document`);
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Zotero.Promise.delay(intervalMs);
    value = await read();
  }
  return value;
}

export type Answer = { timestamp: number; text: string };

function chatBox(panelId: string): HTMLElement {
  const box = panelElement(panelId).querySelector(
    "#llm-chat-box",
  ) as HTMLElement | null;
  if (!box) throw new Error(`Panel ${panelId} has no chat box`);
  return box;
}

function lastWrapper(panelId: string, role: "user" | "assistant") {
  const wrappers = Array.from(
    chatBox(panelId).querySelectorAll(`.llm-message-wrapper.${role}`),
  ) as HTMLElement[];
  return wrappers[wrappers.length - 1] || null;
}

/** Whether the panel is running a turn: its Stop button shows. */
function panelBusy(panelId: string): boolean {
  const stop = panelElement(panelId).querySelector(
    "#llm-cancel",
  ) as HTMLElement | null;
  return Boolean(stop && stop.style.display !== "none");
}

/**
 * The latest answer once its turn has ended (the panel is idle and the
 * answer no longer streams); null while the turn runs. The text is the
 * answer as the chat holds it, without the model label, activity or
 * thinking the panel draws around it.
 */
export async function readFinishedAnswer(
  panelId: string,
): Promise<Answer | null> {
  const wrapper = lastWrapper(panelId, "assistant");
  if (!wrapper || panelBusy(panelId)) return null;
  if (
    wrapper.querySelector(".llm-bubble.streaming") ||
    wrapper.querySelector(".llm-typing")
  )
    return null;
  const api = Zotero.LLMForZotero.api.workflowTest;
  const key = Number((await api.getDiagnostics(panelId)).conversationKey);
  const history = await api.getConversationHistoryTexts(key);
  const answers = (history.memory as Array<{ role: string; text: string }>)
    .filter((message) => message.role === "assistant")
    .map((message) => message.text.trim());
  const text = answers[answers.length - 1] || "";
  if (!text) return null;
  return { timestamp: Number(wrapper.dataset.messageTimestamp || 0), text };
}

async function waitForAnswerAfter(
  panelId: string,
  previousTimestamp: number,
  timeoutMs: number,
): Promise<Answer> {
  const statusText = () =>
    (
      panelElement(panelId).querySelector("#llm-status")?.textContent || ""
    ).trim();
  // A turn that failed says so in the status line; stop waiting then.
  const failed = () =>
    !panelBusy(panelId) && /failed|could not|error/i.test(statusText());
  const answer = await waitFor(
    () => readFinishedAnswer(panelId),
    (value) =>
      Boolean(value && value.timestamp !== previousTimestamp) || failed(),
    timeoutMs,
    250,
  );
  if (!answer || answer.timestamp === previousTimestamp) {
    throw new Error(
      `No new answer within ${timeoutMs}ms; status "${statusText()}"`,
    );
  }
  // Let the turn-end refresh settle before the next action.
  await Zotero.Promise.delay(500);
  return (await readFinishedAnswer(panelId)) || answer;
}

/**
 * Re-sends the latest turn as a user would: Retry with the model that
 * answered when the answer has a Retry button, otherwise Edit on the latest
 * question and Send. Resolves with the new answer and the path taken.
 */
export async function resendLatestTurn(
  panelId: string,
  question: string,
  timeoutMs: number,
): Promise<Answer & { path: "retry" | "edit" }> {
  const before = await readFinishedAnswer(panelId);
  if (!before) throw new Error("There is no finished answer to re-send");
  const body = panelElement(panelId);
  const retryButton = lastWrapper(panelId, "assistant")?.querySelector(
    ".llm-retry-latest",
  ) as HTMLElement | null;
  if (retryButton) {
    retryButton.click();
    const menu = await waitFor(
      async () =>
        body.querySelector("#llm-retry-model-menu") as HTMLElement | null,
      (element) =>
        Boolean(element?.querySelector(".llm-model-option:not([disabled])")),
      5_000,
      50,
    );
    const option = (menu?.querySelector(
      ".llm-model-option.llm-menu-option-selected:not([disabled])",
    ) ||
      menu?.querySelector(
        ".llm-model-option:not([disabled])",
      )) as HTMLElement | null;
    if (!option) throw new Error("The retry menu offers no model");
    option.click();
    return {
      ...(await waitForAnswerAfter(panelId, before.timestamp, timeoutMs)),
      path: "retry",
    };
  }
  const editButton = lastWrapper(panelId, "user")?.querySelector(
    ".llm-message-action-edit",
  ) as HTMLElement | null;
  if (!editButton || editButton.hidden) {
    throw new Error(
      "The latest answer has neither Retry nor an editable question",
    );
  }
  editButton.click();
  const input = await waitFor(
    async () =>
      body.querySelector(
        ".llm-inline-edit-wrapper #llm-input",
      ) as HTMLTextAreaElement | null,
    Boolean,
    5_000,
    50,
  );
  if (!input) throw new Error("The inline edit did not open");
  input.value = question;
  const eventCtor = body.ownerDocument.defaultView?.Event ?? Event;
  input.dispatchEvent(new eventCtor("input", { bubbles: true }));
  const send = body.querySelector(
    ".llm-inline-edit-wrapper #llm-send",
  ) as HTMLButtonElement | null;
  if (!send) throw new Error("The inline edit has no Send button");
  letSendsThrough();
  send.click();
  return {
    ...(await waitForAnswerAfter(panelId, before.timestamp, timeoutMs)),
    path: "edit",
  };
}

/** Switches the panel's paper chip to the "PDF file" source. */
export async function choosePdfFileSource(panelId: string): Promise<void> {
  const body = panelElement(panelId);
  const chip = await waitFor(
    async () =>
      body.querySelector(
        "#llm-paper-context-preview .llm-paper-context-chip",
      ) as HTMLElement | null,
    Boolean,
    10_000,
    100,
  );
  if (!chip) throw new Error("The panel shows no paper chip");
  chip.click();
  const row = await waitFor(
    async () =>
      body.ownerDocument.querySelector(
        ".llm-paper-chip-menu .llm-paper-chip-menu-row.llm-paper-context-chip-pdf",
      ) as HTMLElement | null,
    Boolean,
    5_000,
    50,
  );
  if (!row) throw new Error("The paper chip menu offers no PDF file source");
  row.click();
  const switched = await waitFor(
    async () =>
      body.querySelector(
        "#llm-paper-context-preview .llm-paper-context-chip",
      ) as HTMLElement | null,
    (element) => element?.dataset.contentSource === "pdf",
    5_000,
    50,
  );
  if (switched?.dataset.contentSource !== "pdf") {
    throw new Error("The paper chip did not switch to the PDF file");
  }
}

export async function sendTurn(
  panelId: string,
  question: string,
  timeoutMs: number,
): Promise<Answer> {
  const before = await readFinishedAnswer(panelId);
  const body = panelElement(panelId);
  const input = body.querySelector("#llm-input") as HTMLTextAreaElement | null;
  const send = body.querySelector("#llm-send") as HTMLButtonElement | null;
  if (!input || !send) throw new Error("The composer is not rendered");
  input.value = question;
  const eventCtor = body.ownerDocument.defaultView?.Event ?? Event;
  input.dispatchEvent(new eventCtor("input", { bubbles: true }));
  letSendsThrough();
  send.click();
  return waitForAnswerAfter(panelId, before?.timestamp ?? -1, timeoutMs);
}
