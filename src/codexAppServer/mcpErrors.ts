import { t } from "../utils/i18n";

export type CodexZoteroMcpFailureKind =
  | "proxy_intercepted"
  | "endpoint_unreachable"
  | "authorization_failed"
  | "unknown";

export type CodexZoteroMcpFailure = {
  kind: CodexZoteroMcpFailureKind;
  technicalMessage: string;
  userMessage: string;
};

const ZOTERO_MCP_ERROR_MARKERS = [
  "llm_for_zotero",
  "zotero mcp",
  "/llm-for-zotero/mcp",
];

const PROXY_INTERCEPTION_MESSAGE =
  "Codex could not reach Zotero's local MCP server because a proxy or VPN likely intercepted the loopback request (HTTP 502). LLM for Zotero already requested a direct localhost connection. In your proxy app, route localhost, 127.0.0.1, and ::1 directly, fully restart Zotero, and retry. External OpenAI traffic can remain proxied.";
const ENDPOINT_UNREACHABLE_MESSAGE =
  "Codex could not reach Zotero's local MCP server. Keep Zotero open, make sure its local HTTP server is available, and retry.";
const AUTHORIZATION_FAILED_MESSAGE =
  "Codex reached Zotero's local MCP server, but authorization failed. Click Install/update Zotero MCP config, then retry.";
const UNKNOWN_FAILURE_PREFIX = "Zotero MCP connection failed: ";

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  const message = String(error ?? "").trim();
  return message || "Unknown error";
}

function redactTechnicalMessage(message: string): string {
  return message
    .replace(
      /(authorization["']?\s*[=:]\s*["']?bearer\s+)[^"'\s,;}]+/gi,
      "$1[redacted]",
    )
    .replace(/(bearer\s+)[a-z0-9._~+/=-]{16,}/gi, "$1[redacted]")
    .replace(
      /(x-llm-for-zotero-scope["']?\s*[=:]\s*["']?)[^"'\s,;}]+/gi,
      "$1[redacted]",
    );
}

function isZoteroMcpError(message: string): boolean {
  const normalized = message.toLowerCase();
  return ZOTERO_MCP_ERROR_MARKERS.some((marker) => normalized.includes(marker));
}

export function describeCodexZoteroMcpFailure(
  error: unknown,
): CodexZoteroMcpFailure | null {
  const rawMessage = getErrorMessage(error);
  if (!isZoteroMcpError(rawMessage)) return null;

  const technicalMessage = redactTechnicalMessage(rawMessage);
  if (/\bhttp\s*502\b|\b502\s+bad gateway\b/i.test(rawMessage)) {
    return {
      kind: "proxy_intercepted",
      technicalMessage,
      userMessage: t(PROXY_INTERCEPTION_MESSAGE),
    };
  }
  if (
    /\bhttp\s*401\b|\b401\s+unauthorized\b|\bunauthorized\b/i.test(rawMessage)
  ) {
    return {
      kind: "authorization_failed",
      technicalMessage,
      userMessage: t(AUTHORIZATION_FAILED_MESSAGE),
    };
  }
  if (
    /econnrefused|connection refused|could not connect|failed to connect|error sending request for url|http request failed|networkerror|timed out|timeout/i.test(
      rawMessage,
    )
  ) {
    return {
      kind: "endpoint_unreachable",
      technicalMessage,
      userMessage: t(ENDPOINT_UNREACHABLE_MESSAGE),
    };
  }
  return {
    kind: "unknown",
    technicalMessage,
    userMessage: `${t(UNKNOWN_FAILURE_PREFIX)}${technicalMessage}`,
  };
}

export function formatCodexZoteroMcpError(
  error: unknown,
  context: string,
): string {
  const failure = describeCodexZoteroMcpFailure(error);
  if (!failure) return getErrorMessage(error);
  try {
    (
      globalThis as typeof globalThis & {
        Zotero?: { debug?: (message: string) => void };
      }
    ).Zotero?.debug?.(
      `[llm-for-zotero] ${context} (${failure.kind}): ${failure.technicalMessage}`,
    );
  } catch {
    /* diagnostics must not mask the user-facing error */
  }
  return failure.userMessage;
}
