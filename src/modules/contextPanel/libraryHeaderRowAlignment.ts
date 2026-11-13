/**
 * In the library tab, the Independent chat's two header rows sit beside
 * Zotero's own two rows: the Paper chat | Library chat toggle beside the items
 * toolbar, and the action row beside the item list's column headers. Zotero
 * sizes its rows from its own font size and density, and the plugin's font
 * size changes the toggle, so no fixed padding keeps them level. This module
 * measures the native rows and writes three sizes for the plugin's rows; the
 * stylesheet uses them only while the root carries ALIGNED_ATTRIBUTE.
 */

const ALIGNED_ATTRIBUTE = "data-llm-library-header-aligned";
const TOGGLE_ROW_HEIGHT = "--llm-library-toggle-row-height";
const ROW_GAP = "--llm-library-header-row-gap";
const ACTION_ROW_HEIGHT = "--llm-library-action-row-height";

const px = (value: number) => `${Math.round(value * 100) / 100}px`;

export function installLibraryHeaderRowAlignment(doc: Document): () => void {
  const root = doc.documentElement;
  const win = doc.defaultView as
    | (Window & {
        ResizeObserver?: typeof ResizeObserver;
        MutationObserver?: typeof MutationObserver;
      })
    | null;
  // Without a layout engine there is nothing to measure or align.
  if (!win?.ResizeObserver || !win.MutationObserver) return () => {};

  const clear = () => {
    root.removeAttribute(ALIGNED_ATTRIBUTE);
    root.style.removeProperty(TOGGLE_ROW_HEIGHT);
    root.style.removeProperty(ROW_GAP);
    root.style.removeProperty(ACTION_ROW_HEIGHT);
  };

  // Zotero's font size and density resize the native rows; a pane resize or
  // a new item list re-renders them; the chat section resizes from zero when
  // its view opens.
  const resizeObserver = new win.ResizeObserver(() => refresh());
  let observedSection: Element | null = null;

  const refresh = () => {
    const toolbar = doc.getElementById("zotero-items-toolbar");
    const columns = doc.querySelector(
      "#zotero-items-tree .virtualized-table-header",
    );
    const section = doc.querySelector(
      "#zotero-item-pane .llm-dedicated-chat-pane",
    );
    if (section && section !== observedSection) {
      if (observedSection) resizeObserver.unobserve(observedSection);
      observedSection = section;
      resizeObserver.observe(section);
    }
    const headerTop = section?.querySelector(".llm-header-top");
    if (!toolbar || !columns || !headerTop) return;
    const toolbarRect = toolbar.getBoundingClientRect();
    const columnsRect = columns.getBoundingClientRect();
    const headerRect = headerTop.getBoundingClientRect();
    // A hidden pane or list measures as zero: keep the last good sizes.
    if (!toolbarRect.height || !columnsRect.height || !headerRect.height)
      return;
    // The toggle row starts at the header's top, so it is centred on the
    // toolbar when it is twice as tall as the distance to the toolbar's centre.
    const toolbarCentre = toolbarRect.top + toolbarRect.height / 2;
    const toggleHeight = 2 * (toolbarCentre - headerRect.top);
    const gap = columnsRect.top - headerRect.top - toggleHeight;
    if (toggleHeight <= 0 || gap < 0) {
      clear();
      return;
    }
    root.style.setProperty(TOGGLE_ROW_HEIGHT, px(toggleHeight));
    root.style.setProperty(ROW_GAP, px(gap));
    root.style.setProperty(ACTION_ROW_HEIGHT, px(columnsRect.height));
    root.setAttribute(ALIGNED_ATTRIBUTE, "true");
  };

  for (const id of [
    "zotero-items-toolbar",
    "zotero-items-tree",
    "zotero-item-pane",
  ]) {
    const node = doc.getElementById(id);
    if (node) resizeObserver.observe(node);
  }
  // Opening the chat view or switching the sidebar layout changes these root
  // attributes; measure once the new layout has been laid out.
  let frame: number | undefined;
  const refreshAfterLayout = () => {
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      refresh();
    });
  };
  const attributeObserver = new win.MutationObserver(refreshAfterLayout);
  attributeObserver.observe(root, {
    attributes: true,
    attributeFilter: ["data-llm-pane-view", "data-llm-sidebar-layout"],
  });
  // The chat section joins the item pane's section list when it is first
  // rendered. Only that list's direct children are watched, not the chat.
  const sectionList = doc.getElementById("zotero-view-item");
  if (sectionList) attributeObserver.observe(sectionList, { childList: true });
  win.addEventListener("resize", refresh);
  refresh();

  return () => {
    resizeObserver.disconnect();
    attributeObserver.disconnect();
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    win.removeEventListener("resize", refresh);
    clear();
  };
}
