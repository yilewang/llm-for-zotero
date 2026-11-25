/**
 * How agy reports the tool calls a turn makes, as far as the Zotero tools
 * are concerned: which Zotero tool a call names, and which file reads are
 * agy working with its own files.
 */

import type { AcpToolCall } from "../shared/acpProtocol";

/** agy's own tool for calling an MCP tool it did not offer directly. */
const AGY_CALL_MCP_TOOL_NAME = "call_mcp_tool";

export function toolArguments(
  call: Pick<AcpToolCall, "args" | "rawInput">,
): unknown {
  return call.args ?? call.rawInput ?? {};
}

/**
 * The Zotero tool a tool call names, when it is one of this turn's. agy
 * names a tool it offers directly `mcp_<server>_<tool>`; any other tool of
 * the server goes through `call_mcp_tool` with the server and tool as
 * arguments.
 */
export function zoteroToolNameOf(
  call: Pick<AcpToolCall, "name" | "args" | "rawInput">,
  serverName: string,
): string | null {
  if (call.name === AGY_CALL_MCP_TOOL_NAME) {
    const named = toolArguments(call) as {
      ServerName?: unknown;
      ToolName?: unknown;
    } | null;
    return named?.ServerName === serverName &&
      typeof named.ToolName === "string" &&
      named.ToolName
      ? named.ToolName
      : null;
  }
  const prefix = `mcp_${serverName}_`;
  return call.name && call.name.startsWith(prefix)
    ? call.name.slice(prefix.length)
    : null;
}

/**
 * agy reads two kinds of its own files while it works with MCP tools, both
 * in its data folder. A long tool result is saved under
 * `brain/<session>/.system_generated/` and read back in chunks; those reads
 * repeat a result the chat already shows. The definition of a tool agy did
 * not offer directly is read from `mcp/<server>/<tool>.json` before the
 * call. Neither read gets an activity row of its own.
 */
export function isAgyOwnFileRead(call: AcpToolCall, dataDir: string): boolean {
  if (call.kind !== "read" || !dataDir) return false;
  const root = dataDir.replace(/[\\/]+$/, "");
  const paths = (call.locations ?? []).map((location) => location.path);
  return (
    paths.length > 0 &&
    paths.every((path) => {
      if (typeof path !== "string" || !path.startsWith(root)) return false;
      const rest = path.slice(root.length);
      return (
        /^[\\/]brain[\\/][^\\/]+[\\/]\.system_generated[\\/]/.test(rest) ||
        /^[\\/]mcp[\\/][^\\/]+[\\/][^\\/]+\.json$/.test(rest)
      );
    })
  );
}
