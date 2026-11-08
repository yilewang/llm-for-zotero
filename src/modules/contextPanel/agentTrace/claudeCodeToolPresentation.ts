import type { AgentToolPresentation } from "../../../agent/types";

/**
 * How the tools Claude Code and Codex run themselves present in the trace.
 *
 * Claude Code runs Bash, Read, Edit and the rest inside its own process, so
 * they never reach the plugin's tool registry and would otherwise show as
 * "Using Bash". These hooks give each one the plain words a Claude session
 * itself uses: what a command is for, which file was read or changed, what
 * was searched, and the icon its kind of step has in every mode. They are
 * looked up only when the registry knows no tool of that name, so a
 * registered tool always speaks for itself.
 */

function readArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function shorten(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function fileName(path: unknown): string {
  const text = readText(path);
  return text ? text.split(/[\\/]/).filter(Boolean).pop() || text : "";
}

function hostName(url: unknown): string {
  const text = readText(url);
  try {
    return new URL(text).hostname.replace(/^www\./, "") || text;
  } catch {
    return text;
  }
}

/**
 * A tool whose row reads what `build` makes of the call's arguments.
 *
 * A call recorded without arguments (runs from before the bridge forwarded
 * them) builds nothing, so its row keeps the generic "Using Read lines
 * 1-200" the trace has always drawn for it.
 */
function presentation(
  build: (args: Record<string, unknown>) => string,
  extra: Partial<AgentToolPresentation> = {},
): AgentToolPresentation {
  const words = ({ args }: { args?: unknown }): string | null =>
    build(readArgs(args)) || null;
  return {
    summaries: { onCall: words },
    buildTraceSummary: words,
    // The row already names the file, pattern or page; chips would repeat it.
    buildChips: () => [],
    mergeResultIntoCallTrace: true,
    ...extra,
  };
}

const named =
  (verb: string, key: string) =>
  (args: Record<string, unknown>): string =>
    fileName(args[key]) ? `${verb} ${fileName(args[key])}` : "";

const quoted =
  (verb: string, key: string) =>
  (args: Record<string, unknown>): string =>
    readText(args[key]) ? `${verb} "${shorten(readText(args[key]), 60)}"` : "";

const CLAUDE_CODE_TOOL_PRESENTATIONS: Readonly<
  Record<string, AgentToolPresentation>
> = {
  Bash: presentation(
    (args) =>
      readText(args.description) ||
      (readText(args.command) ? `Ran ${shorten(readText(args.command))}` : ""),
    {
      buildTraceCodeBlock: ({ args }) => {
        const command = readArgs(args).command;
        return typeof command === "string" && command.trim()
          ? { code: command }
          : null;
      },
      traceIcon: "code",
    },
  ),
  Read: presentation(named("Read", "file_path"), { traceIcon: "file" }),
  Write: presentation(named("Write", "file_path"), { traceIcon: "edit" }),
  Edit: presentation(named("Edit", "file_path"), { traceIcon: "edit" }),
  MultiEdit: presentation(named("Edit", "file_path"), { traceIcon: "edit" }),
  NotebookEdit: presentation(named("Edit", "notebook_path"), {
    traceIcon: "edit",
  }),
  Grep: presentation(quoted("Search for", "pattern"), { traceIcon: "search" }),
  Glob: presentation(
    (args) =>
      readText(args.pattern)
        ? `Find files ${shorten(readText(args.pattern), 60)}`
        : "",
    { traceIcon: "search" },
  ),
  WebSearch: presentation(quoted("Search the web for", "query"), {
    traceIcon: "web",
  }),
  WebFetch: presentation(
    (args) => (hostName(args.url) ? `Open ${hostName(args.url)}` : ""),
    { traceIcon: "web" },
  ),
  Task: presentation((args) => readText(args.description)),
  Agent: presentation((args) => readText(args.description)),
};

/**
 * The work Codex runs itself, under the names its trace rows carry.
 *
 * Codex's rows already say what ran ("Ran rg -n …", "Edited notes.md"), so
 * these only give each kind of step the icon it has in every other mode and
 * drop the argument chips the row's own words already cover.
 */
const CODEX_NATIVE_TOOL_PRESENTATIONS: Readonly<
  Record<string, AgentToolPresentation>
> = {
  command: { traceIcon: "code", buildChips: () => [] },
  file_changes: { traceIcon: "edit", buildChips: () => [] },
  codex_web_search: { traceIcon: "web", buildChips: () => [] },
  image_view: { traceIcon: "file", buildChips: () => [] },
};

function lookup(
  table: Readonly<Record<string, AgentToolPresentation>>,
  name: string,
): AgentToolPresentation | undefined {
  return Object.prototype.hasOwnProperty.call(table, name)
    ? table[name]
    : undefined;
}

export function resolveClaudeCodeToolPresentation(
  name: string,
): AgentToolPresentation | undefined {
  return (
    lookup(CLAUDE_CODE_TOOL_PRESENTATIONS, name) ||
    lookup(CODEX_NATIVE_TOOL_PRESENTATIONS, name)
  );
}
