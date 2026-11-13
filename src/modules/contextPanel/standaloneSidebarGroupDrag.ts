/**
 * Reordering the "Group by agent" sections of the window sidebar: drag a
 * section label up or down, or focus it and press Alt+Up / Alt+Down.
 *
 * Pointer events rather than HTML drag and drop, so Zotero's own item drop
 * handling never sees the drag.
 */

const GROUP_SELECTOR = ".llm-standalone-conv-group";
const DRAG_THRESHOLD_PX = 4;

export type StandaloneSidebarGroupDragOptions = {
  list: HTMLElement;
  /** Called with the section moved and its new place among the others. */
  onMove: (key: string, toIndex: number) => void;
};

function groupHeaders(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll(GROUP_SELECTOR)) as HTMLElement[];
}

function clearDropMarks(list: HTMLElement): void {
  for (const header of groupHeaders(list)) {
    delete header.dataset.drop;
    header.classList.remove("dragging");
  }
  list.classList.remove("llm-standalone-group-dragging");
  delete list.dataset.dropEnd;
}

/** The place among the other sections that the pointer is over. */
function dropIndex(list: HTMLElement, dragged: HTMLElement, y: number): number {
  const others = groupHeaders(list).filter((header) => header !== dragged);
  let index = 0;
  for (const header of others) {
    const rect = header.getBoundingClientRect();
    if (y > rect.top + rect.height / 2) index += 1;
  }
  return index;
}

function markDrop(list: HTMLElement, dragged: HTMLElement, index: number) {
  const others = groupHeaders(list).filter((header) => header !== dragged);
  for (const header of others) delete header.dataset.drop;
  delete list.dataset.dropEnd;
  // The line goes above the section it lands before, or under the list.
  if (index < others.length) others[index].dataset.drop = "before";
  else if (others.length) list.dataset.dropEnd = "true";
}

export function installStandaloneSidebarGroupDrag(
  options: StandaloneSidebarGroupDragOptions,
): () => void {
  const { list, onMove } = options;
  let drag: {
    header: HTMLElement;
    pointerId: number;
    startY: number;
    active: boolean;
  } | null = null;
  let suppressClick = false;

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const header = (event.target as Element | null)?.closest?.(
      GROUP_SELECTOR,
    ) as HTMLElement | null;
    if (!header || !list.contains(header)) return;
    // The label's own buttons (its sort button) are not drag handles.
    if ((event.target as Element).closest?.("button")) return;
    // No text selection while dragging; focus still goes to the label.
    event.preventDefault();
    header.focus();
    drag = {
      header,
      pointerId: event.pointerId,
      startY: event.clientY,
      active: false,
    };
    try {
      header.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety */
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      drag.header.classList.add("dragging");
      list.classList.add("llm-standalone-group-dragging");
    }
    event.preventDefault();
    // Near the list's top or bottom edge, scroll so far sections are reachable.
    const rect = list.getBoundingClientRect();
    if (event.clientY < rect.top + 24) list.scrollTop -= 12;
    else if (event.clientY > rect.bottom - 24) list.scrollTop += 12;
    markDrop(list, drag.header, dropIndex(list, drag.header, event.clientY));
  };

  const finish = (event: PointerEvent, commit: boolean) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { header, active } = drag;
    drag = null;
    try {
      header.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    if (!active) return;
    const index = dropIndex(list, header, event.clientY);
    clearDropMarks(list);
    suppressClick = true;
    if (commit && header.dataset.groupKey) {
      onMove(header.dataset.groupKey, index);
    }
  };
  const onPointerUp = (event: PointerEvent) => finish(event, true);
  const onPointerCancel = (event: PointerEvent) => finish(event, false);

  // A drag ends with a click on the label; it must not reach the list.
  const onClick = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    if ((event.target as Element | null)?.closest?.(GROUP_SELECTOR)) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const header = (event.target as Element | null)?.closest?.(
      GROUP_SELECTOR,
    ) as HTMLElement | null;
    if (!header?.dataset.groupKey) return;
    event.preventDefault();
    event.stopPropagation();
    const headers = groupHeaders(list);
    const current = headers.indexOf(header);
    const next = current + (event.key === "ArrowUp" ? -1 : 1);
    if (next < 0 || next >= headers.length) return;
    onMove(header.dataset.groupKey, next);
  };

  list.addEventListener("pointerdown", onPointerDown);
  list.addEventListener("pointermove", onPointerMove);
  list.addEventListener("pointerup", onPointerUp);
  list.addEventListener("pointercancel", onPointerCancel);
  list.addEventListener("click", onClick, true);
  list.addEventListener("keydown", onKeyDown);
  return () => {
    list.removeEventListener("pointerdown", onPointerDown);
    list.removeEventListener("pointermove", onPointerMove);
    list.removeEventListener("pointerup", onPointerUp);
    list.removeEventListener("pointercancel", onPointerCancel);
    list.removeEventListener("click", onClick, true);
    list.removeEventListener("keydown", onKeyDown);
  };
}
