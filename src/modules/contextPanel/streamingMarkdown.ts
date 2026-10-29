import { withChatContentScrollGuard } from "./chatScrollSnapshots";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import { copyFlatContentScope } from "./contentChrome";
import { isLiveDocument } from "./panelLiveness";
import { splitSettledMarkdownBlocks } from "../../utils/markdown";
import { createCoalescedFrameScheduler } from "./setupHandlers/controllers/uiSchedulingController";

/**
 * Each block of a streaming answer renders into its own wrapper, so a
 * wrapper's first and last children are not the answer's. The stylesheet
 * keeps the final answer's spacing on them, and drops the last paragraph's
 * gap only in the block marked as the end.
 */
const STREAMING_BLOCK_CLASS = "llm-streaming-block";
const STREAMING_END_CLASS = "llm-streaming-end";

/** Stable Markdown blocks share the normal renderer; only the unfinished tail is reparsed. */
const streams = new WeakMap<
  HTMLElement,
  {
    source: string | undefined;
    committed: string;
    tail: HTMLElement;
    pending: string;
    /** Top-level elements inside committed blocks, which stay mounted. */
    committedElements: number;
    /** The block holding the answer's last element (see STREAMING_END_CLASS). */
    end: HTMLElement | null;
    /** When each top-level element first appeared, by position. */
    appeared: number[];
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
      committedElements: 0,
      end: null as HTMLElement | null,
      // A restart redraws content the reader already saw; keep it still.
      appeared: state?.appeared ?? [],
      scheduler: null! as ReturnType<typeof createCoalescedFrameScheduler>,
    };
    next.scheduler = createCoalescedFrameScheduler({
      getWindow: () => doc.defaultView,
      run: () => {
        // A closed window's target still reports isConnected; drawing into
        // its document crashes Zotero.
        if (
          !target.isConnected ||
          !isLiveDocument(doc) ||
          streams.get(target) !== next
        )
          return;
        // Prepare off-DOM so a budget yield never exposes committed blocks
        // alongside the previous tail, or clears a restarted stream early.
        const now = () => doc.defaultView?.performance.now() ?? Date.now();
        const started = now();
        let committed = next.committed;
        const blocks: HTMLElement[] = [];
        const stable = splitSettledMarkdownBlocks(
          next.pending.slice(committed.length),
        );
        for (const raw of stable) {
          if (now() - started >= 8 && blocks.length) {
            next.scheduler.schedule();
            break;
          }
          const block = doc.createElement("div");
          block.className = STREAMING_BLOCK_CLASS;
          block.style.display = "contents";
          // The block renders off-DOM, so flat hydrators cannot see the
          // destination's scope. Copy it onto the block first.
          copyFlatContentScope(target, block);
          renderRenderedMarkdownInto(block, raw, doc, {
            onAsyncContentRendered: onResize,
          });
          blocks.push(block);
          committed += raw;
        }
        const tail = doc.createElement("div");
        tail.className = STREAMING_BLOCK_CLASS;
        renderRenderedMarkdownInto(
          tail,
          next.pending.slice(committed.length),
          doc,
          {
            onAsyncContentRendered: onResize,
            deferEnrichment: true,
          },
        );
        const fresh = [...blocks, tail].flatMap((block) =>
          Array.from(block.children),
        ) as HTMLElement[];
        markStreamingEntrances(
          fresh,
          next.appeared,
          next.committedElements,
          now(),
        );
        withChatContentScrollGuard(target, () => {
          if (next.tail.parentElement === target) {
            next.tail.replaceWith(...blocks, tail);
          } else {
            target.replaceChildren(...blocks, tail);
          }
          // An empty tail leaves the last committed block at the end.
          const end = tail.children.length
            ? tail
            : (blocks[blocks.length - 1] ?? next.end);
          if (next.end !== end) next.end?.classList.remove(STREAMING_END_CLASS);
          end?.classList.add(STREAMING_END_CLASS);
          next.end = end;
          next.committed = committed;
          next.committedElements += fresh.length - tail.children.length;
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

export const STREAMING_FADE_IN_MS = 600;

/**
 * Fades in elements that are new to the reader. The tail is rebuilt every
 * frame, so an element's first appearance is recorded by position: a rebuilt
 * element resumes its fade through a negative delay instead of restarting it,
 * and an element older than the fade is left alone.
 */
export function markStreamingEntrances(
  elements: HTMLElement[],
  appeared: number[],
  firstIndex: number,
  now: number,
): void {
  elements.forEach((element, offset) => {
    const index = firstIndex + offset;
    appeared[index] ??= now;
    const elapsed = now - appeared[index];
    if (elapsed >= STREAMING_FADE_IN_MS) return;
    element.classList.add("llm-streaming-fade-in");
    element.style.animationDelay = `${-Math.round(elapsed)}ms`;
    // Drop the class once done, or a hidden-then-shown panel replays it.
    const settle = (event: Event) => {
      if (event.target !== element) return;
      element.removeEventListener("animationend", settle);
      element.classList.remove("llm-streaming-fade-in");
      element.style.animationDelay = "";
    };
    element.addEventListener("animationend", settle);
  });
}

export function disposeStreamingMarkdown(target: HTMLElement): void {
  streams.get(target)?.scheduler.cancel();
  streams.delete(target);
}
