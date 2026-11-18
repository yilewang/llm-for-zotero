/**
 * How Antigravity asks before it acts: one of agy's four session modes, or
 * full access, which starts agy with --dangerously-skip-permissions (a
 * process flag, so full access runs in its own agy process).
 */
export const ANTIGRAVITY_PERMISSION_MODES = [
  "default",
  "accept-edits",
  "auto",
  "plan",
  "full-access",
] as const;

export type AntigravityPermissionMode =
  (typeof ANTIGRAVITY_PERMISSION_MODES)[number];

export function isAntigravityPermissionMode(
  value: unknown,
): value is AntigravityPermissionMode {
  return (ANTIGRAVITY_PERMISSION_MODES as readonly unknown[]).includes(value);
}
