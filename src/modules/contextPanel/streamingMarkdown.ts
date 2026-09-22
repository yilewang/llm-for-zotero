import { withChatContentScrollGuard } from "./chatScrollSnapshots";
import { marked } from "marked";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import { createCoalescedFrameScheduler } from "./setupHandlers/controllers/uiSchedulingController";

/** Stable Markdown blocks share the normal renderer; only the unfinished tail is reparsed. */
const streams = new WeakMap<
  HTMLElement,
  {
    source: string | undefined;
    committed: string;
    tail: HTMLElement;
    pending: string;
    scheduler: ReturnType<typeof createCoalescedFrameScheduler>;
  }
>();

export function renderStreamingMarkdownInto(
  target: HTMLElement,
  source: string,
  doc: Document,
  onResize: () => void,
): void {
  let state = streams.get(target);
  if (!state || !source.startsWith(state.source ?? "")) {
    state?.scheduler.cancel();
    const tail = doc.createElement("div");
    const next = {
      source: undefined as string | undefined,
      committed: "",
      tail,
      pending: "",
      scheduler: null! as ReturnType<typeof createCoalescedFrameScheduler>,
    };
    next.scheduler = createCoalescedFrameScheduler({
      getWindow: () => doc.defaultView,
      run: () => {
        if (!target.isConnected || streams.get(target) !== next) return;
        // Prepare off-DOM so a budget yield never exposes committed blocks
        // alongside the previous tail, or clears a restarted stream early.
        const now = () => doc.defaultView?.performance.now() ?? Date.now();
        const started = now();
        let committed = next.committed;
        const blocks: HTMLElement[] = [];
        const tokens = marked.lexer(next.pending.slice(committed.length));
        // Retain the last two tokens: blank lines can still extend a list/table.
        const stable = tokens.slice(0, -2);
        for (const token of stable) {
          if (now() - started >= 8 && blocks.length) {
            next.scheduler.schedule();
            break;
          }
          const block = doc.createElement("div");
          block.style.display = "contents";
          renderRenderedMarkdownInto(block, token.raw, doc, {
            onAsyncContentRendered: onResize,
          });
          blocks.push(block);
          committed += token.raw;
        }
        const tail = doc.createElement("div");
        renderRenderedMarkdownInto(
          tail,
          next.pending.slice(committed.length),
          doc,
          {
            onAsyncContentRendered: onResize,
            deferEnrichment: true,
          },
        );
        withChatContentScrollGuard(target, () => {
          if (next.tail.parentElement === target) {
            next.tail.replaceWith(...blocks, tail);
          } else {
            target.replaceChildren(...blocks, tail);
          }
          next.committed = committed;
          next.tail = tail;
          onResize();
        });
      },
    });
    streams.set(target, next);
    state = next;
  }
  if (state.source === source) return;
  state.source = source;
  state.pending = source;
  state.scheduler.schedule();
}

export function disposeStreamingMarkdown(target: HTMLElement): void {
  streams.get(target)?.scheduler.cancel();
  streams.delete(target);
}
