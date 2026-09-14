import { marked } from "marked";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import { createCoalescedFrameScheduler } from "./setupHandlers/controllers/uiSchedulingController";

/** Stable Markdown blocks share the normal renderer; only the unfinished tail is reparsed. */
const streams = new WeakMap<
  HTMLElement,
  {
    source: string;
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
  if (!state || !source.startsWith(state.source)) {
    state?.scheduler.cancel();
    target.replaceChildren();
    const tail = doc.createElement("div");
    target.appendChild(tail);
    const next = {
      source: "",
      committed: "",
      tail,
      pending: "",
      scheduler: null! as ReturnType<typeof createCoalescedFrameScheduler>,
    };
    next.scheduler = createCoalescedFrameScheduler({
      getWindow: () => doc.defaultView,
      run: () => {
        if (!target.isConnected || streams.get(target) !== next) return;
        // The plugin sandbox has no global performance object. Use the
        // clock belonging to the window whose frame we are rendering.
        const now = () => doc.defaultView?.performance.now() ?? Date.now();
        const started = now();
        const remainder = next.pending.slice(next.committed.length);
        const tokens = marked.lexer(remainder);
        // Retain the last two tokens: blank lines can still extend a list/table.
        const stable = tokens.slice(0, -2);
        for (const token of stable) {
          if (now() - started >= 8) {
            next.scheduler.schedule();
            return;
          }
          const block = doc.createElement("div");
          block.style.display = "contents";
          renderRenderedMarkdownInto(block, token.raw, doc, {
            onAsyncContentRendered: onResize,
          });
          target.insertBefore(block, next.tail);
          next.committed += token.raw;
        }
        renderRenderedMarkdownInto(
          next.tail,
          next.pending.slice(next.committed.length),
          doc,
          { onAsyncContentRendered: onResize, deferEnrichment: true },
        );
        onResize();
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
