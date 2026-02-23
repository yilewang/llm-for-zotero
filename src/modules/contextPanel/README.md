# Context Panel Architecture

This folder implements the reader/library side-panel chat experience.

## Core Modules

- `index.ts`: registration entrypoint (panel section, style injection, reader popup selection tracking).
- `buildUI.ts`: static panel DOM construction.
- `setupHandlers.ts`: runtime orchestration and event wiring across panel features.
- `chat.ts`: conversation load/render/send/retry/edit and streaming orchestration.
- `contextResolution.ts`: active context resolution and selected-text context state updates.
- `pdfContext.ts`: PDF text extraction/caching and retrieval context building.
- `paperContext.ts`: supplemental paper context construction.
- `notes.ts`: note export and assistant-response save flows.
- `shortcuts.ts`: quick-action shortcut render/edit/reorder behavior.

## Shared Domain Helpers

- `constants.ts`: context-panel constants and label helpers.
- `types.ts`: shared types.
- `state.ts`: in-memory module state caches/maps.
- `normalizers.ts`: canonical normalization helpers for selected text source, paper contexts, hashes, and positive integers.
- `readerSelection.ts`: shared reader-selection document traversal helpers used by popup and panel flows.
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
