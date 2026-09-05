/**
 * Grammar of a scoped conversation key.
 *
 * A scoped conversation key is a serialized record, not opaque text:
 *
 *   <conversationKey>::<scopeType>:<scopeId>
 *
 * The scope id is itself compound — a paper scope carries
 * `<profileSignature>:<libraryID>:<paperItemID>` — so the digits of a
 * conversation key routinely recur later in the string. Any rewrite therefore
 * has to be scoped to the leading key token; a substring operation such as
 * SQL `REPLACE()` corrupts the scope id as well.
 *
 * This module is the single owner of that grammar. Build, rewrite, and the
 * equality checks that depend on both must agree, so they live together.
 */

export const SCOPED_CONVERSATION_KEY_DELIMITER = "::";

export type ScopedConversationKeyScope = {
  scopeType?: string;
  scopeId?: string;
};

/**
 * Serialize a conversation key plus its scope. An incomplete scope yields the
 * bare key, which is the unscoped form stored for conversations that have no
 * scope binding.
 */
export function buildScopedConversationKey(
  conversationKey: number,
  scope?: ScopedConversationKeyScope,
): string {
  if (!scope?.scopeType || !scope.scopeId) {
    return String(conversationKey);
  }
  return `${conversationKey}${SCOPED_CONVERSATION_KEY_DELIMITER}${scope.scopeType}:${scope.scopeId}`;
}

/**
 * Rewrite ONLY the leading conversation-key token, preserving the scope tail
 * byte for byte.
 *
 * A stored key that does not lead with `legacyKey` is returned unchanged: it
 * does not describe this row, and overwriting it would replace one wrong value
 * with another. Consumers compare the stored key against a freshly built one
 * and decline on mismatch, so leaving it alone degrades safely.
 */
export function rekeyScopedConversationKey(
  scopedConversationKey: string | null | undefined,
  legacyKey: number,
  targetKey: number,
): string | null {
  const scoped =
    typeof scopedConversationKey === "string"
      ? scopedConversationKey.trim()
      : "";
  if (!scoped) return null;
  const legacyToken = String(legacyKey);
  if (scoped === legacyToken) return String(targetKey);
  if (scoped.startsWith(`${legacyToken}${SCOPED_CONVERSATION_KEY_DELIMITER}`)) {
    return `${targetKey}${scoped.slice(legacyToken.length)}`;
  }
  return scoped;
}
