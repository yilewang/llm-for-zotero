/**
 * One conversation shown in two chat panels (the sidebar and a window, or
 * two windows): a question sent from one panel's own composer starts a held
 * answer, so the test decides when the answer streams and ends while it
 * watches the other panel mirror it.
 */
import { assert } from "chai";
import type { HeldChatProvider, HeldStream } from "./heldChatProvider";

declare const Zotero: any;

function textOf(node: Element | null | undefined): string {
  return (node?.textContent || "").replace(/\s+/gu, " ").trim();
}

/** The text of the newest assistant bubble under a panel's `#llm-main`. */
export function lastAssistantBubbleText(root: Element | null): string {
  const bubbles = Array.from(
    root?.querySelectorAll("#llm-chat-box .llm-bubble.assistant") || [],
  );
  return textOf(bubbles[bubbles.length - 1] as Element | undefined);
}

/** Types `text` into a panel's composer and clicks its Send button. */
export function typeAndSend(body: HTMLElement, text: string): void {
  const win = body.ownerDocument.defaultView as any;
  const input = body.querySelector("#llm-input") as HTMLTextAreaElement;
  const send = body.querySelector("#llm-send") as HTMLButtonElement;
  assert.isOk(input, "the composer has an input");
  assert.isOk(send, "the composer has a Send button");
  input.value = text;
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  send.click();
}

/**
 * Sends `question` from the panel `senderBody` returns, waits for its held
 * provider request, pushes `firstChunk`, and returns once the sending panel
 * shows that chunk. The caller has already put the same conversation in the
 * other panel (or does so next) and finishes the returned stream.
 */
export async function startSharedConversationStream(options: {
  provider: HeldChatProvider;
  senderBody: () => HTMLElement | null;
  question: string;
  firstChunk?: string;
  timeoutMs?: number;
}): Promise<HeldStream> {
  const firstChunk = options.firstChunk ?? "MIRROR-PART-ONE ";
  const marker = firstChunk.trim();
  const body = options.senderBody();
  assert.isOk(body, "the sending panel is open");
  typeAndSend(body!, options.question);
  const stream = await options.provider.waitForStream(options.question);
  stream.push(firstChunk);
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const senderRoot = () =>
    (options.senderBody()?.querySelector("#llm-main") as Element | null) ||
    null;
  while (Date.now() < deadline) {
    if (lastAssistantBubbleText(senderRoot()).includes(marker)) return stream;
    await Zotero.Promise.delay(50);
  }
  if (lastAssistantBubbleText(senderRoot()).includes(marker)) return stream;
  assert.fail(
    `the sending panel shows the partial answer "${marker}": ${JSON.stringify(
      lastAssistantBubbleText(senderRoot()),
    )}`,
  );
}
