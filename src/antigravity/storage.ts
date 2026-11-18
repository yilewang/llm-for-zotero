import { isAntigravityModeEnabled } from "./prefs";
import { antigravityConversationStore } from "./store";
import { removeConversationSystemChecks } from "../shared/conversationSystemCheckMigration";

/**
 * Antigravity storage startup and first-enable preparation.
 *
 * Every profile gets the (empty) Antigravity tables at startup, like the
 * Claude Code and Codex tables, so the satellites that scan every store need
 * no special case. Only a profile with Antigravity turned on has the shared
 * conversation tables rebuilt without their system CHECK, which an
 * Antigravity row would otherwise violate.
 */

export async function initAntigravityStore(): Promise<void> {
  await antigravityConversationStore.initStore();
  if (isAntigravityModeEnabled()) await prepareAntigravityStorage();
}

/**
 * Makes the shared conversation tables accept Antigravity rows. Idempotent;
 * called at startup when the mode is on and when the user turns it on.
 */
export async function prepareAntigravityStorage(): Promise<void> {
  await removeConversationSystemChecks();
}
