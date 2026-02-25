# LLM-for-Zotero Refactor Parity Checklist

Use this checklist after each optimization phase to verify behavior parity.

## Request Flows

- [ ] Send plain prompt from a paper item.
- [ ] Send prompt with selected text context.
- [ ] Send with attachments only (no typed text).
- [ ] Send with supplemental paper contexts.
- [ ] Retry latest assistant response.
- [ ] Retry latest response with a different model from retry menu.
- [ ] Edit latest user message and retry.
- [ ] Stale edit marker is rejected with status message.
- [ ] Cancel during stream restores input/send/cancel/history controls.

## Context UI

- [ ] Add text from reader selection button.
- [ ] Add text from reader popup "Add Text" action.
- [ ] Remove selected text context chip.
- [ ] Pin/unpin selected text context panel.
- [ ] Capture screenshot and append to selected images.
- [ ] Remove selected screenshots.
- [ ] Upload files via slash menu upload option.
- [ ] Drag/drop files into input area.
- [ ] Paste files/images from clipboard into input area.
- [ ] Remove selected files.
- [ ] Add supplemental papers via slash picker.
- [ ] Remove one supplemental paper from preview list.
- [ ] Pin/unpin image/file/paper context panels.

## Menus and Keyboard

- [ ] Model dropdown opens, selects, and updates label.
- [ ] Reasoning dropdown opens, selects, and updates label.
- [ ] Export menu opens and closes correctly.
- [ ] History menu opens and closes correctly.
- [ ] Slash menu opens and closes correctly.
- [ ] Paper picker supports Up/Down/Left/Right/Enter/Tab/Escape.

## History and Conversation Management

- [ ] `+` menu shows `Open Chat` and `Paper Chat`.
- [ ] `Paper Chat` option is disabled (with hint) when no paper context exists.
- [ ] Create paper chat `v2`/`v3` sessions and verify each starts empty.
- [ ] Delete paper chat `v{n}` and verify new paper session reuses lowest missing version.
- [ ] Switch paper conversation sessions from history (same paper only).
- [ ] Switch open/global conversation from history.
- [ ] Paper history section never shows sessions from other papers.
- [ ] Open history section still shows library open chats with `Open` tags.
- [ ] Delete/undo works for both open and paper sessions.
- [ ] Active paper-session delete falls back to most recent remaining paper session, or auto-creates one.
- [ ] Clear button clears current conversation and resets compose state.

## Export / Notes

- [ ] Copy response works.
- [ ] Save response as note works.
- [ ] Copy chat as markdown works.
- [ ] Save chat history as note works.
- [ ] Note export keeps screenshot embedding and file links.

## Persistence / Data Safety

- [ ] Conversation history still loads after restart.
- [ ] Attachment references are updated after send/edit/export.
- [ ] No orphaned attachment blobs immediately after normal use.
- [ ] Legacy prefs still readable after startup migrations.

## Utility Regression Tests

- [ ] `apiHelpers` endpoint/header/token helpers pass unit tests.
- [ ] `normalization` temperature/max-token helpers pass unit tests.
- [ ] New shared normalizer/path helper tests pass (when added).
