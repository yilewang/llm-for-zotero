// The shortcut chips and the composer float over the bottom of the chat, and
// the chat runs on behind them. CSS reads their heights from these properties
// to pull them up over the chat, to fade the text that goes behind them, and
// to keep the last message and the jump button clear of them. The sidebar
// also reads how far the composer text box has grown past one line, and
// shortens the chat by that much so the panel keeps its height.
const SHORTCUTS_PROPERTY = "--llm-shortcuts-overlay";
const COMPOSER_PROPERTY = "--llm-composer-overlay";
const GROWTH_PROPERTY = "--llm-composer-growth";

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
    // Text box height above its one-line min-height; 0 when it does not float.
    const input = composer.querySelector<HTMLElement>(".llm-input");
    let growth = 0;
    if (input && composer.parentElement === panel) {
      const minHeight = Number.parseFloat(
        win?.getComputedStyle(input)?.minHeight ?? "",
      );
      if (Number.isFinite(minHeight))
        growth = Math.max(
          0,
          Math.round(input.getBoundingClientRect().height - minHeight),
        );
    }
    write(GROWTH_PROPERTY, `${growth}px`);
  };
  const resizeObserver = win?.ResizeObserver
    ? new win.ResizeObserver(sync)
    : null;
  resizeObserver?.observe(shortcuts);
  resizeObserver?.observe(composer);
  const inputBox = composer.querySelector<HTMLElement>(".llm-input");
  if (inputBox) resizeObserver?.observe(inputBox);
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
    panel.style.removeProperty(GROWTH_PROPERTY);
  };
}
