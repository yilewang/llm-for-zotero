// The shortcut chips and the composer float over the bottom of the chat, and
// the chat runs on behind them. CSS reads their heights from these properties
// to pull them up over the chat, to fade the text that goes behind them, and
// to keep the last message and the jump button clear of them.
const SHORTCUTS_PROPERTY = "--llm-shortcuts-overlay";
const COMPOSER_PROPERTY = "--llm-composer-overlay";

export function bindFloatingComposer({
  panel,
  shortcuts,
  composer,
}: {
  panel: HTMLElement;
  shortcuts: HTMLElement;
  composer: HTMLElement;
}): () => void {
  const win = panel.ownerDocument.defaultView as
    | (Window & typeof globalThis)
    | null;
  const write = (name: string, value: string) => {
    if (panel.style.getPropertyValue(name) !== value)
      panel.style.setProperty(name, value);
  };
  const sync = () => {
    // An empty shortcuts row is hidden and measures 0. Inline editing moves
    // the composer into a message; then nothing floats over the chat.
    const height = (node: HTMLElement) =>
      node.parentElement === panel
        ? Math.round(node.getBoundingClientRect().height)
        : 0;
    write(SHORTCUTS_PROPERTY, `${height(shortcuts)}px`);
    write(COMPOSER_PROPERTY, `${height(composer)}px`);
  };
  const resizeObserver = win?.ResizeObserver
    ? new win.ResizeObserver(sync)
    : null;
  resizeObserver?.observe(shortcuts);
  resizeObserver?.observe(composer);
  const mutationObserver = win?.MutationObserver
    ? new win.MutationObserver(sync)
    : null;
  mutationObserver?.observe(panel, { childList: true });
  sync();
  return () => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    panel.style.removeProperty(SHORTCUTS_PROPERTY);
    panel.style.removeProperty(COMPOSER_PROPERTY);
  };
}
