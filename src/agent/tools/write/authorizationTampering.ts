/**
 * Whether code or a command reaches the plugin's own permission state.
 *
 * One test for zotero_script and run_command, so both block the same things:
 * the plugin's permission and approval prefs (and the MCP bearer token), a
 * write to any pref in the plugin's namespace, the grant store, and the
 * authorization service's identifiers. The plain word "authorization" is
 * not among them: it is an HTTP header, a comment or a paper title far more
 * often than an attack, and blocking it stopped ordinary scripts.
 */
const PERMISSION_PREF_KEYS =
  /originalAgentPermissionMode|agentLibraryWriteMode|agentPermissionMode|claudeCodePermissionMode|codexAppServerPermissionState|codexAppServerApprovalsReviewer|codexZoteroMcpBearerToken/i;

const GRANT_STORE = /grantStore/i;

const AUTHORIZATION_SERVICE_IDENTIFIERS =
  /\b(?:ActionAuthorizationService|authorizeOriginalAction|authorizeExternalAction|actionIntegrityFailure|registerPendingConfirmation|resolveConfirmation)\b/;

// Zotero.Prefs.set / clear and the Gecko pref service setters, with the
// plugin's namespace in the call; and a prefs.js line that sets one.
const PLUGIN_PREF_WRITE =
  /\bPrefs\s*\.\s*(?:set|clear|reset)\w*\s*\([^)]*llmforzotero|\b(?:set|clear)(?:Bool|Int|Char|String|Complex)?(?:User)?Pref\s*\([^)]*llmforzotero|\buser_pref\s*\(\s*\\?["']extensions\.zotero\.llmforzotero/i;

export function reachesAuthorizationState(text: string): boolean {
  return (
    PERMISSION_PREF_KEYS.test(text) ||
    GRANT_STORE.test(text) ||
    AUTHORIZATION_SERVICE_IDENTIFIERS.test(text) ||
    PLUGIN_PREF_WRITE.test(text)
  );
}
