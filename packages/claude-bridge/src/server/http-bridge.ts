import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Llm4ZoteroAgentBackendAdapter } from "../bridge/llm4zotero-agent-backend-adapter.js";
import { StructuredCompletionError } from "../runtime.js";
import type {
  Llm4ZoteroAgentEvent,
  Llm4ZoteroRunActionRequest,
  Llm4ZoteroRunTurnRequest,
  Llm4ZoteroRuntimeRetentionRequest,
  Llm4ZoteroSessionInvalidationRequest,
} from "../bridge/llm4zotero-contract.js";

export interface HttpBridgeServerOptions {
  adapter: Llm4ZoteroAgentBackendAdapter;
  host?: string;
  port?: number;
  /**
   * When set, every request path must start with `/<authToken>`. The token is
   * part of the base URL the plugin is given, so no caller has to add a header.
   */
  authToken?: string;
  /** Reported by /healthz so the plugin can tell bridge builds apart. */
  bridgeVersion?: string;
  /** Reported by /healthz: who started this bridge, e.g. "llm-for-zotero". */
  managedBy?: string;
}

/**
 * Strips the `/<token>` prefix from a request path. Returns undefined when the
 * path does not carry the token.
 */
export function stripAuthTokenPrefix(
  url: string,
  authToken: string,
): string | undefined {
  const match = /^\/([^/?#]*)(.*)$/s.exec(url);
  if (!match) return undefined;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(authToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return undefined;
  const rest = match[2];
  if (!rest) return "/";
  return rest.startsWith("/") ? rest : `/${rest}`;
}

export interface HttpBridgeServerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

type BridgeStreamLine =
  | { type: "start"; runId: string }
  | { type: "event"; event: Llm4ZoteroAgentEvent }
  | {
      type: "outcome";
      outcome:
        | {
            kind: "completed";
            runId: string;
            text: string;
            usedFallback: false;
          }
        | {
            kind: "fallback";
            runId: string;
            reason: string;
            usedFallback: true;
          };
    }
  | { type: "error"; error: string };

function parseScopeType(
  value: unknown,
): "paper" | "open" | "folder" | "tag" | "tagset" | "custom" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "paper":
    case "open":
    case "folder":
    case "tag":
    case "tagset":
    case "custom":
      return normalized;
    default:
      return undefined;
  }
}

function parseConversationKey(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function parseSettingSources(
  value: string | null | undefined,
): Array<"user" | "project" | "local"> | undefined {
  if (!value) return undefined;
  const normalized = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const accepted: Array<"user" | "project" | "local"> = [];
  for (const entry of normalized) {
    if (entry === "user" || entry === "project" || entry === "local") {
      if (!accepted.includes(entry)) accepted.push(entry);
    }
  }
  return accepted.length > 0 ? accepted : undefined;
}

function parseMcpServers(
  value: unknown,
): Record<string, Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, config] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const normalizedName = name.trim();
    if (
      !normalizedName ||
      !config ||
      typeof config !== "object" ||
      Array.isArray(config)
    )
      continue;
    servers[normalizedName] = config as Record<string, unknown>;
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      /authorization|api[-_]?key|token|secret|password/i.test(key)
        ? "[redacted]"
        : redactSecrets(entry),
    ]),
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function toRequestPayload(body: unknown): Llm4ZoteroRunTurnRequest {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const conversationKey = record.conversationKey;
  const userText = record.userText;

  if (
    !(
      typeof conversationKey === "string" || typeof conversationKey === "number"
    )
  ) {
    throw new Error("conversationKey must be string or number");
  }

  if (typeof userText !== "string" || userText.length === 0) {
    throw new Error("userText must be a non-empty string");
  }

  return {
    conversationKey,
    userText,
    providerSessionId:
      typeof record.providerSessionId === "string" &&
      record.providerSessionId.trim().length > 0
        ? record.providerSessionId.trim()
        : undefined,
    allowedTools: Array.isArray(record.allowedTools)
      ? record.allowedTools.filter((x): x is string => typeof x === "string")
      : undefined,
    scopeType: parseScopeType(record.scopeType),
    scopeId:
      typeof record.scopeId === "string" && record.scopeId.trim().length > 0
        ? record.scopeId.trim()
        : undefined,
    scopeLabel:
      typeof record.scopeLabel === "string" &&
      record.scopeLabel.trim().length > 0
        ? record.scopeLabel.trim()
        : undefined,
    runtimeRequest:
      record.runtimeRequest && typeof record.runtimeRequest === "object"
        ? (record.runtimeRequest as Record<string, unknown>)
        : undefined,
    mcpServers: parseMcpServers(record.mcpServers),
    metadata:
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined,
  };
}

function toActionPayload(body: unknown): Llm4ZoteroRunActionRequest {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const conversationKey = record.conversationKey;
  const toolName = record.toolName;
  if (
    !(
      typeof conversationKey === "string" || typeof conversationKey === "number"
    )
  ) {
    throw new Error("conversationKey must be string or number");
  }
  if (typeof toolName !== "string" || !toolName.trim()) {
    throw new Error("toolName must be a non-empty string");
  }
  return {
    conversationKey,
    toolName,
    args: record.args,
    approved: typeof record.approved === "boolean" ? record.approved : false,
    scopeType: parseScopeType(record.scopeType),
    scopeId:
      typeof record.scopeId === "string" && record.scopeId.trim().length > 0
        ? record.scopeId.trim()
        : undefined,
    scopeLabel:
      typeof record.scopeLabel === "string" &&
      record.scopeLabel.trim().length > 0
        ? record.scopeLabel.trim()
        : undefined,
    activeItemId:
      typeof record.activeItemId === "number" ? record.activeItemId : undefined,
    libraryID:
      typeof record.libraryID === "number" ? record.libraryID : undefined,
    contextEnvelope:
      record.contextEnvelope && typeof record.contextEnvelope === "object"
        ? (record.contextEnvelope as Record<string, unknown>)
        : undefined,
    metadata:
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined,
  };
}

function toResolveConfirmationPayload(body: unknown): {
  requestId: string;
  approved: boolean;
  actionId?: string;
  data?: unknown;
} {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const requestId =
    typeof record.requestId === "string" ? record.requestId.trim() : "";
  if (!requestId) {
    throw new Error("requestId must be a non-empty string");
  }
  return {
    requestId,
    approved: Boolean(record.approved),
    actionId:
      typeof record.actionId === "string" && record.actionId.trim().length > 0
        ? record.actionId.trim()
        : undefined,
    data: record.data,
  };
}

function toRetentionPayload(body: unknown): Llm4ZoteroRuntimeRetentionRequest {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const conversationKey = record.conversationKey;
  const mountId =
    typeof record.mountId === "string" ? record.mountId.trim() : "";
  if (
    !(
      typeof conversationKey === "string" || typeof conversationKey === "number"
    )
  ) {
    throw new Error("conversationKey must be string or number");
  }
  if (!mountId) {
    throw new Error("mountId must be a non-empty string");
  }
  return {
    conversationKey,
    providerSessionId:
      typeof record.providerSessionId === "string" &&
      record.providerSessionId.trim().length > 0
        ? record.providerSessionId.trim()
        : undefined,
    scopeType: parseScopeType(record.scopeType),
    scopeId:
      typeof record.scopeId === "string" && record.scopeId.trim().length > 0
        ? record.scopeId.trim()
        : undefined,
    scopeLabel:
      typeof record.scopeLabel === "string" &&
      record.scopeLabel.trim().length > 0
        ? record.scopeLabel.trim()
        : undefined,
    mountId,
    retain: Boolean(record.retain),
  };
}

function toSessionInvalidationPayload(
  body: unknown,
): Llm4ZoteroSessionInvalidationRequest {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const conversationKey = record.conversationKey;
  if (
    !(
      typeof conversationKey === "string" || typeof conversationKey === "number"
    )
  ) {
    throw new Error("conversationKey must be string or number");
  }
  return {
    conversationKey,
    scopeType: parseScopeType(record.scopeType),
    scopeId:
      typeof record.scopeId === "string" && record.scopeId.trim().length > 0
        ? record.scopeId.trim()
        : undefined,
    scopeLabel:
      typeof record.scopeLabel === "string" &&
      record.scopeLabel.trim().length > 0
        ? record.scopeLabel.trim()
        : undefined,
    metadata:
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined,
  };
}

function writeLine(res: ServerResponse, line: BridgeStreamLine): void {
  res.write(JSON.stringify(line));
  res.write("\n");
}

export async function startHttpBridgeServer(
  options: HttpBridgeServerOptions,
): Promise<HttpBridgeServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  const authToken = options.authToken?.trim() || "";

  const server = createServer(async (req, res) => {
    try {
      if (authToken) {
        const stripped = stripAuthTokenPrefix(req.url || "/", authToken);
        if (stripped === undefined) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        req.url = stripped;
      }
      const reqUrl = new URL(req.url || "/", `http://${host}:${port}`);
      if (req.method === "GET" && req.url === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          protocolVersion: 2,
          capabilities: [
            "local_pdf_paths",
            "model_catalog_v1",
            "permission_modes_v1",
            ...(options.adapter.supportsStructuredCompletion
              ? ["structured_completion_v1"]
              : []),
          ],
          ...(options.bridgeVersion
            ? { bridgeVersion: options.bridgeVersion }
            : {}),
          ...(options.managedBy ? { managedBy: options.managedBy } : {}),
          ts: Date.now(),
        });
        return;
      }

      if (
        req.method === "POST" &&
        reqUrl.pathname === "/structured-completion"
      ) {
        if (!options.adapter.supportsStructuredCompletion) {
          sendJson(res, 503, {
            error: "structured_completion_v1 is unavailable",
          });
          return;
        }
        const body = (await readJson(req)) as Record<string, unknown>;
        if (
          !body ||
          typeof body.prompt !== "string" ||
          !body.prompt.trim() ||
          (body.model !== undefined && typeof body.model !== "string")
        ) {
          sendJson(res, 400, {
            error: "A prompt and optional model are required",
          });
          return;
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once("close", cancel);
        try {
          const result = await options.adapter.completeStructured({
            prompt: body.prompt,
            model: body.model as string | undefined,
            timeoutMs: Math.min(
              300000,
              Math.max(1000, Number(body.timeoutMs) || 20000),
            ),
            signal: controller.signal,
          });
          sendJson(res, 200, result);
        } catch (error) {
          // A provider rate limit keeps its status so the caller can back off;
          // every other failure stays a generic 500.
          if (
            error instanceof StructuredCompletionError &&
            error.status === 429
          ) {
            sendJson(res, 429, { error: error.message });
            return;
          }
          throw error;
        } finally {
          res.off("close", cancel);
        }
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/tools") {
        const settingSources = parseSettingSources(
          reqUrl.searchParams.get("settingSources"),
        );
        const tools = await options.adapter.listTools({ settingSources });
        sendJson(res, 200, { tools });
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/mcp-servers") {
        const settingSources = parseSettingSources(
          reqUrl.searchParams.get("settingSources"),
        );
        const servers = await options.adapter.listMcpServers({
          settingSources,
        });
        sendJson(res, 200, { servers: redactSecrets(servers) });
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/commands") {
        const settingSources = parseSettingSources(
          reqUrl.searchParams.get("settingSources"),
        );
        const commands = await options.adapter.listCommands({ settingSources });
        sendJson(res, 200, { commands });
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/permission-modes") {
        const settingSources = parseSettingSources(
          reqUrl.searchParams.get("settingSources"),
        );
        const catalog = await options.adapter.listPermissionModes({
          settingSources,
        });
        sendJson(res, 200, catalog);
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/account-quota") {
        const conversationKey = parseConversationKey(
          reqUrl.searchParams.get("conversationKey"),
        );
        if (conversationKey === undefined) {
          sendJson(res, 400, {
            error: "conversationKey query param is required",
          });
          return;
        }
        const quota = await options.adapter.getAccountQuota({
          conversationKey,
          settingSources: parseSettingSources(
            reqUrl.searchParams.get("settingSources"),
          ),
          scopeType: parseScopeType(reqUrl.searchParams.get("scopeType")),
          scopeId: reqUrl.searchParams.get("scopeId")?.trim() || undefined,
          scopeLabel:
            reqUrl.searchParams.get("scopeLabel")?.trim() || undefined,
        });
        sendJson(res, 200, { quota });
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/models") {
        const settingSources = parseSettingSources(
          reqUrl.searchParams.get("settingSources"),
        );
        const conversationKey = parseConversationKey(
          reqUrl.searchParams.get("conversationKey"),
        );
        const scopeType = parseScopeType(reqUrl.searchParams.get("scopeType"));
        const scopeIdRaw = reqUrl.searchParams.get("scopeId");
        const scopeLabelRaw = reqUrl.searchParams.get("scopeLabel");
        const scopeId =
          typeof scopeIdRaw === "string" && scopeIdRaw.trim().length > 0
            ? scopeIdRaw.trim()
            : undefined;
        const scopeLabel =
          typeof scopeLabelRaw === "string" && scopeLabelRaw.trim().length > 0
            ? scopeLabelRaw.trim()
            : undefined;
        const forceRefresh =
          reqUrl.searchParams.get("refresh") === "1" ||
          reqUrl.searchParams.get("refresh") === "true";
        const catalog = await options.adapter.listModels({
          settingSources,
          conversationKey,
          scopeType,
          scopeId,
          scopeLabel,
          forceRefresh,
        });
        sendJson(res, 200, catalog);
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/efforts") {
        const settingSources = parseSettingSources(
          reqUrl.searchParams.get("settingSources"),
        );
        const conversationKey = parseConversationKey(
          reqUrl.searchParams.get("conversationKey"),
        );
        const scopeType = parseScopeType(reqUrl.searchParams.get("scopeType"));
        const scopeIdRaw = reqUrl.searchParams.get("scopeId");
        const scopeLabelRaw = reqUrl.searchParams.get("scopeLabel");
        const scopeId =
          typeof scopeIdRaw === "string" && scopeIdRaw.trim().length > 0
            ? scopeIdRaw.trim()
            : undefined;
        const scopeLabel =
          typeof scopeLabelRaw === "string" && scopeLabelRaw.trim().length > 0
            ? scopeLabelRaw.trim()
            : undefined;
        const model =
          typeof reqUrl.searchParams.get("model") === "string"
            ? (reqUrl.searchParams.get("model") || "").trim()
            : undefined;
        const efforts = await options.adapter.listEfforts({
          settingSources,
          model: model || undefined,
          conversationKey,
          scopeType,
          scopeId,
          scopeLabel,
        });
        sendJson(res, 200, { efforts });
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/session-info") {
        const conversationKey = parseConversationKey(
          reqUrl.searchParams.get("conversationKey"),
        );
        if (conversationKey === undefined) {
          sendJson(res, 400, {
            error: "conversationKey query param is required",
          });
          return;
        }
        const scopeType = parseScopeType(reqUrl.searchParams.get("scopeType"));
        const scopeIdRaw = reqUrl.searchParams.get("scopeId");
        const scopeLabelRaw = reqUrl.searchParams.get("scopeLabel");
        const scopeId =
          typeof scopeIdRaw === "string" && scopeIdRaw.trim().length > 0
            ? scopeIdRaw.trim()
            : undefined;
        const scopeLabel =
          typeof scopeLabelRaw === "string" && scopeLabelRaw.trim().length > 0
            ? scopeLabelRaw.trim()
            : undefined;
        const sessionInfo = await options.adapter.getSessionInfo({
          conversationKey,
          scopeType: scopeType || undefined,
          scopeId,
          scopeLabel,
        });
        sendJson(res, 200, { session: sessionInfo });
        return;
      }

      if (req.method === "POST" && req.url === "/runtime-retention") {
        let payload: Llm4ZoteroRuntimeRetentionRequest;
        try {
          payload = toRetentionPayload(await readJson(req));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return;
        }
        const outcome = await options.adapter.updateRuntimeRetention(payload);
        sendJson(res, 200, outcome);
        return;
      }

      if (req.method === "POST" && req.url === "/invalidate-session") {
        let payload: Llm4ZoteroSessionInvalidationRequest;
        try {
          payload = toSessionInvalidationPayload(await readJson(req));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return;
        }
        const outcome = await options.adapter.invalidateSession(payload);
        sendJson(res, 200, outcome);
        return;
      }

      if (req.method === "POST" && req.url === "/invalidate-all-hot-runtimes") {
        const outcome = await options.adapter.invalidateAllHotRuntimes();
        sendJson(res, 200, outcome);
        return;
      }

      if (req.method === "POST" && req.url === "/run-turn") {
        let payload: Llm4ZoteroRunTurnRequest;
        try {
          payload = toRequestPayload(await readJson(req));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const outcome = await options.adapter.runTurn({
          request: payload,
          onStart: (runId) => {
            writeLine(res, { type: "start", runId });
          },
          onEvent: (event) => {
            writeLine(res, { type: "event", event });
          },
        });

        writeLine(res, { type: "outcome", outcome });
        res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/run-action") {
        let payload: Llm4ZoteroRunActionRequest;
        try {
          payload = toActionPayload(await readJson(req));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const outcome = await options.adapter.runAction({
          request: payload,
          onStart: (runId) => {
            writeLine(res, { type: "start", runId });
          },
          onEvent: (event) => {
            writeLine(res, { type: "event", event });
          },
        });

        writeLine(res, { type: "outcome", outcome });
        res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/resolve-confirmation") {
        let payload: {
          requestId: string;
          approved: boolean;
          actionId?: string;
          data?: unknown;
        };
        try {
          payload = toResolveConfirmationPayload(await readJson(req));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return;
        }
        const resolution = options.adapter.resolveExternalConfirmation(
          payload.requestId,
          {
            approved: payload.approved,
            actionId: payload.actionId,
            data: payload.data,
          },
        );
        console.log(
          `[confirm] rid=${payload.requestId} source=${resolution.source} accepted=${resolution.accepted}`,
        );
        if (!resolution.accepted) {
          console.log(
            `[confirm] pending_count=${resolution.pendingPermissionCount} recent=${resolution.recentPendingRequestIds.join(",") || "-"}`,
          );
        }
        sendJson(res, resolution.accepted ? 200 : 404, {
          ok: resolution.accepted,
          requestId: payload.requestId,
          source: resolution.source,
          pendingPermissionCount: resolution.pendingPermissionCount,
          recentPendingRequestIds: resolution.recentPendingRequestIds,
        });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        writeLine(res, { type: "error", error: message });
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to resolve server address");
  }

  return {
    host,
    port: addr.port,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
