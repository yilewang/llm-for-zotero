# Context Panel Architecture

This folder implements the reader/library side-panel chat experience.

## Core Modules

- `index.ts`: registration entrypoint (panel section, style injection, reader popup selection tracking).
- `dedicatedChatPane.ts`: mutually exclusive chat/details presentation in the native right pane, with a native lifecycle recheck when returning to a retained reader tab.
- `sidebarLayout.ts`: persisted Independent/Stacked presentation choice and live native section updates.
- `buildUI.ts`: static panel DOM construction.
- `setupHandlers.ts`: runtime orchestration and event wiring across panel features.
- `chat.ts`: conversation load/render/send/retry/edit and streaming orchestration.
- `contextResolution.ts`: active context resolution and selected-text context state updates.
- `pdfContext.ts`: PDF text extraction/caching and context candidate/full-text builders.
- `multiContextPlanner.ts`: adaptive budget-first context planning across multiple papers.
- `notes.ts`: note export and assistant-response save flows.
- `shortcuts.ts`: quick-action shortcut render/edit/reorder behavior.

## Shared Domain Helpers

- `constants.ts`: context-panel constants and label helpers.
- `types.ts`: shared types.
- `state.ts`: in-memory module state caches/maps.
- `normalizers.ts`: canonical normalization helpers for selected text source, paper contexts, hashes, and positive integers.
- `menuPositioning.ts`: reusable floating menu positioning functions.
- `prefHelpers.ts`: preference read/write wrappers for panel behavior.
- `textUtils.ts`: sanitization, prompt composition, status, and rendering helpers.

## Handler Subfolder

- `setupHandlers/domRefs.ts`: centralized DOM query/typing helper for panel elements.
- `setupHandlers/types.ts`: lightweight handler wiring types.
- `setupHandlers/controllers/menuController.ts`: floating menu open-state and positioning primitives.
- `setupHandlers/controllers/modelReasoningController.ts`: model-specific screenshot gating and reasoning label helpers.
- `setupHandlers/controllers/conversationHistoryController.ts`: history row/title/date normalization and shared history types.
- `setupHandlers/controllers/composeContextController.ts`: paper-context normalization and chip metadata formatting helpers.
- `setupHandlers/controllers/fileIntakeController.ts`: file drag/paste/upload parsing and attachment ingestion pipeline.
- `setupHandlers/controllers/sendFlowController.ts`: send/edit/retry request dispatch orchestration.

## Design Constraints

- Keep exported signatures stable for plugin entrypoints and persistence helpers.
- Keep DOM IDs/class names stable to preserve CSS and event behavior.
- Keep persistence schema/pref keys stable to avoid user data regressions.

## Dedicated Right Pane

The plugin icon selects a full-height chat view; other native pane icons restore Zotero's details or notes view.
The chat section stays connected to its original per-tab `item-details` host so conversation ownership, drafts, selection routing, and Paper/Library mode remain with their existing owners.
Presentation state belongs to the main window and survives tab changes without being persisted as a conversation preference.
Zotero namespaces registered pane IDs, so navigation identifies the registered host through its class rather than constructing an ID.
Native tab selection can reuse a rendered section without calling plugin hooks, so the dedicated view requests `_forceRenderAll()` after the native deck selection to reconcile the active conversation through the existing lifecycle.
The native workflow regression covers full-height geometry, returning to item details, reader tab context changes, and Library chat staying selected until the user switches to Paper chat.

Customization offers Independent and Stacked (default) layouts without rebuilding the mounted chat.
Stacked restores native section headers, collapse controls, and the classic chat toolbar.
Independent's header has two rows: the centered Paper chat | Library chat toggle above the actions row.
Stacked's header is one row, with the mode chip in place of the runtime divider; on hover or keyboard focus it drops down into a Paper chat | Library chat switch (`sidebarModeSwitch.ts`) whose picks take the toggle's switch path.
Every header builds both controls and CSS picks one from `data-llm-sidebar-layout`, so a live layout change swaps them.
With no library item selected, its rail icon opens the existing full-height starter page; selecting an item restores the chosen stacked layout.
