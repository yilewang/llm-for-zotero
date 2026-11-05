import type { ConversationSystem } from "../../shared/types";

/**
 * Runtime sections of a skill body: lines that only one external runtime
 * should read, such as the name of its own tool.
 *
 *     <!-- runtime: claude_code -->
 *     Call the digest tool through the Claude Code MCP server.
 *     <!-- /runtime -->
 *
 * The ids are the external `ConversationSystem` values. The markers are HTML
 * comments on their own lines, so a Markdown view hides them and ordinary
 * prose cannot produce one by accident.
 *
 * The file keeps its markers: users edit it as written, and its hashes
 * drive upgrades. Each path that hands a body to a model strips it here,
 * at delivery.
 */
export type SkillRuntime = Extract<ConversationSystem, "claude_code" | "codex">;

const SKILL_RUNTIMES: ReadonlySet<string> = new Set<SkillRuntime>([
  "claude_code",
  "codex",
]);

/** An open marker; its id may be empty or unknown, and is then kept by no runtime. */
const OPEN_MARKER = /^\s*<!--\s*runtime\b\s*:?\s*([^\s>]*?)\s*-->\s*$/;
const CLOSE_MARKER = /^\s*<!--\s*\/\s*runtime\s*-->\s*$/;
/** Any marker-like text, anywhere: what delivered text must never contain. */
const ANY_MARKER = /<!--\s*\/?\s*runtime\b/;

/** Whether `text` holds a runtime-section marker or something like one. */
export function hasSkillRuntimeMarker(text: string): boolean {
  return ANY_MARKER.test(text);
}

/**
 * The body as `runtime` should read it: that runtime's sections kept
 * without their markers, every other section removed.
 *
 * - No runtime, or one that is not an external runtime (the plugin's own
 *   Agent is `upstream`): every section is removed.
 * - A section without its close marker, including one whose close is
 *   preceded by another open marker, is removed to the end of the body,
 *   for every runtime: its end is unknown, so nothing of it may leak.
 * - A stray close marker is dropped.
 * - A body without a marker comes back unchanged; otherwise runs of blank
 *   lines a removed section leaves collapse to one.
 */
export function skillBodyForRuntime(
  body: string,
  runtime?: ConversationSystem | null,
): string {
  if (!hasSkillRuntimeMarker(body)) return body;
  const reader = runtime && SKILL_RUNTIMES.has(runtime) ? runtime : undefined;
  const lines = body.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (CLOSE_MARKER.test(line)) continue;
    const open = OPEN_MARKER.exec(line);
    if (!open) {
      // Marker-like text that is not a whole marker line is dropped too.
      if (!hasSkillRuntimeMarker(line)) out.push(line);
      continue;
    }
    let close = -1;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (CLOSE_MARKER.test(lines[next])) {
        close = next;
        break;
      }
      if (OPEN_MARKER.test(lines[next])) break;
    }
    if (close < 0) break;
    if (reader && open[1] === reader)
      for (const kept of lines.slice(index + 1, close))
        if (!hasSkillRuntimeMarker(kept)) out.push(kept);
    index = close;
  }
  return out.join("\n").replace(/\n(?:[ \t]*\n){2,}/g, "\n\n");
}
