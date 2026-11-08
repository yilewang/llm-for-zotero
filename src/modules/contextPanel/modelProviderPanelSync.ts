/**
 * What open chat panels do when the saved model providers change.
 *
 * Every panel syncs its model and reasoning controls (a light update that no
 * chat rebuild performs). A full chat rebuild runs only when the runtime model
 * entries changed, because rendered turns read them: the context gauge's
 * input limit, the output-limit Continue button's original model, prompt
 * editability, and the WebChat start page. Settings edits that leave the
 * entries unchanged (an empty model row, an open card, a preset choice) no
 * longer rebuild every open chat.
 */
export function createModelProviderGroupsPanelSync(deps: {
  /** Panels in registration order; disconnected ones are skipped. */
  listPanels: () => Iterable<Element>;
  /** A string that changes whenever the runtime model entries change. */
  readModelEntriesSignature: () => string;
  /** Rebuild every open chat (the previous behavior on every save). */
  refreshAllPanels: () => void;
}): {
  /** Register a panel's light model sync; returns its unregister function. */
  register: (body: Element, sync: () => void) => () => void;
  onModelProviderGroupsChanged: () => void;
} {
  const modelSyncs = new WeakMap<Element, () => void>();
  // The entries the open chats were rendered with. Unknown until the first
  // panel registers; then the first change rebuilds to be safe.
  let renderedSignature: string | null = null;

  return {
    register(body, sync) {
      modelSyncs.set(body, sync);
      if (renderedSignature === null) {
        renderedSignature = deps.readModelEntriesSignature();
      }
      return () => {
        if (modelSyncs.get(body) === sync) modelSyncs.delete(body);
      };
    },
    onModelProviderGroupsChanged() {
      const signature = deps.readModelEntriesSignature();
      if (signature !== renderedSignature) {
        renderedSignature = signature;
        deps.refreshAllPanels();
      }
      for (const body of deps.listPanels()) {
        if (!body.isConnected) continue;
        modelSyncs.get(body)?.();
      }
    },
  };
}
