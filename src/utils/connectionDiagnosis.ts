/**
 * Why a provider request failed before any HTTP reply.
 *
 * Zotero's `fetch` reports every connection failure as the same
 * "NetworkError when attempting to fetch resource." — an expired certificate,
 * a refused port and a misspelled host all look identical. The network layer
 * underneath knows the cause, so after such a failure we open one plain
 * connection to the same server and read the code it fails with.
 *
 * The check carries no API key, cookie or request body: it is an anonymous
 * HEAD request to the server's root. It uses the same proxy settings and
 * certificate store as `fetch`, so it fails the same way.
 */

export type ConnectionFailureKind =
  | "certificate"
  | "tls"
  | "unknown_host"
  | "refused"
  | "blocked_port"
  | "timeout"
  | "reset"
  | "proxy"
  | "offline"
  | "other";

export type ConnectionFailure = {
  host: string;
  kind: ConnectionFailureKind;
  /** The network layer's own name for the failure, e.g. SEC_ERROR_EXPIRED_CERTIFICATE. */
  code: string;
  /** One plain-language sentence fragment naming the cause. */
  reason: string;
};

/** Network-layer status codes (Firefox `Components.results`) we can name. */
const STATUS_CODES: ReadonlyMap<
  number,
  { code: string; kind: ConnectionFailureKind }
> = new Map([
  [0x804b000d, { code: "NS_ERROR_CONNECTION_REFUSED", kind: "refused" }],
  [0x804b000e, { code: "NS_ERROR_NET_TIMEOUT", kind: "timeout" }],
  [0x804b0055, { code: "NS_ERROR_NET_TIMEOUT_EXTERNAL", kind: "timeout" }],
  [0x804b0014, { code: "NS_ERROR_NET_RESET", kind: "reset" }],
  [0x804b0047, { code: "NS_ERROR_NET_INTERRUPT", kind: "reset" }],
  [0x804b001e, { code: "NS_ERROR_UNKNOWN_HOST", kind: "unknown_host" }],
  [0x804b002a, { code: "NS_ERROR_UNKNOWN_PROXY_HOST", kind: "proxy" }],
  [0x804b0048, { code: "NS_ERROR_PROXY_CONNECTION_REFUSED", kind: "proxy" }],
  [0x804b05de, { code: "NS_ERROR_PROXY_BAD_GATEWAY", kind: "proxy" }],
  [0x804b05e0, { code: "NS_ERROR_PROXY_GATEWAY_TIMEOUT", kind: "proxy" }],
  [
    0x804b0013,
    { code: "NS_ERROR_PORT_ACCESS_NOT_ALLOWED", kind: "blocked_port" },
  ],
  [0x804b0010, { code: "NS_ERROR_OFFLINE", kind: "offline" }],
]);

const CHECK_TIMEOUT_MS = 10_000;

function certificateReason(code: string): string | null {
  if (code === "SEC_ERROR_EXPIRED_CERTIFICATE")
    return "its security certificate has expired";
  if (code === "SSL_ERROR_BAD_CERT_DOMAIN")
    return "its security certificate is for a different domain";
  if (
    code === "SEC_ERROR_UNKNOWN_ISSUER" ||
    code === "MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT" ||
    code === "SEC_ERROR_UNTRUSTED_ISSUER" ||
    code === "SEC_ERROR_CA_CERT_INVALID"
  )
    return "Zotero does not trust its security certificate (self-signed or from an unknown authority)";
  if (/CERT|ISSUER|PKIX/.test(code))
    return "its security certificate was rejected";
  return null;
}

const KIND_REASONS: Record<
  Exclude<ConnectionFailureKind, "certificate">,
  string
> = {
  tls: "the secure (TLS) connection could not be set up",
  unknown_host: "the server name could not be found",
  refused: "the server refused the connection",
  blocked_port: "Zotero blocks connections to this port for security reasons",
  timeout: "the connection timed out",
  reset: "the connection was reset",
  proxy: "the proxy server could not be reached",
  offline: "Zotero is offline",
  other: "the connection failed",
};

/**
 * Name the failure from what the network layer reported: a security error
 * name (TLS and certificate failures) or a status code. Null when the
 * connection did not fail.
 */
export function classifyConnectionFailure(params: {
  host: string;
  status: number;
  securityErrorName?: string | null;
}): ConnectionFailure | null {
  const securityError = params.securityErrorName?.trim();
  if (securityError) {
    const certificate = certificateReason(securityError);
    return {
      host: params.host,
      kind: certificate ? "certificate" : "tls",
      code: securityError,
      reason: certificate ?? KIND_REASONS.tls,
    };
  }
  const status = params.status >>> 0;
  if (status === 0) return null;
  const known = STATUS_CODES.get(status);
  const kind = known?.kind ?? "other";
  return {
    host: params.host,
    kind,
    code: known?.code ?? `0x${status.toString(16)}`,
    reason: KIND_REASONS[kind as Exclude<ConnectionFailureKind, "certificate">],
  };
}

/** Whether `fetch` failed before the server sent any HTTP reply. */
export function isFetchNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError && /NetworkError/i.test(error.message || "")
  );
}

type ChannelLike = {
  loadFlags: number;
  requestMethod?: string;
  securityInfo?: { errorCodeString?: string } | null;
  asyncOpen: (listener: unknown) => void;
  cancel: (status: number) => void;
};

/**
 * Open one anonymous connection to the server behind `url` and report how it
 * fails. Null when it connects, or when the check itself cannot run.
 */
export async function diagnoseConnectionFailure(
  url: string,
  signal?: AbortSignal | null,
): Promise<ConnectionFailure | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.host;
  const { NetUtil } = ChromeUtils.importESModule(
    "resource://gre/modules/NetUtil.sys.mjs",
  ) as {
    NetUtil: {
      newChannel: (options: {
        uri: string;
        loadUsingSystemPrincipal: boolean;
      }) => ChannelLike;
      readInputStreamToString: (stream: unknown, count: number) => string;
    };
  };
  let channel: ChannelLike;
  try {
    channel = NetUtil.newChannel({
      uri: `${parsed.origin}/`,
      loadUsingSystemPrincipal: true,
    });
  } catch {
    return null;
  }
  // No cached reply, and no cookies or stored credentials.
  channel.loadFlags |=
    (Ci.nsIRequest.LOAD_BYPASS_CACHE ?? 0) |
    (Ci.nsIRequest.LOAD_ANONYMOUS ?? 0);
  if (channel instanceof Ci.nsIHttpChannel) channel.requestMethod = "HEAD";

  return new Promise<ConnectionFailure | null>((resolve) => {
    const timeoutStatus = 0x804b000e; // NS_ERROR_NET_TIMEOUT
    const abortStatus = 0x804b0002; // NS_BINDING_ABORTED
    let settled = false;
    const finish = (failure: ConnectionFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(failure);
    };
    const onAbort = () => {
      channel.cancel(abortStatus);
      finish(null);
    };
    const timer = setTimeout(
      () => channel.cancel(timeoutStatus),
      CHECK_TIMEOUT_MS,
    );
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    try {
      channel.asyncOpen({
        onStartRequest() {},
        onDataAvailable(
          _request: unknown,
          stream: unknown,
          _o: number,
          count: number,
        ) {
          NetUtil.readInputStreamToString(stream, count);
        },
        onStopRequest(_request: unknown, status: number) {
          let securityErrorName: string | null = null;
          try {
            securityErrorName = channel.securityInfo?.errorCodeString || null;
          } catch {
            securityErrorName = null;
          }
          finish(
            classifyConnectionFailure({ host, status, securityErrorName }),
          );
        },
        QueryInterface: ChromeUtils.generateQI([
          "nsIStreamListener",
          "nsIRequestObserver",
        ]),
      });
    } catch (error) {
      // Some failures, such as a blocked port, are refused before any
      // connection is attempted.
      const status = Number((error as { result?: unknown })?.result);
      finish(
        Number.isFinite(status)
          ? classifyConnectionFailure({ host, status })
          : null,
      );
    }
  });
}

/** A provider request that could not reach the server, with its cause. */
export class ProviderConnectionError extends Error {
  readonly failure: ConnectionFailure;

  constructor(failure: ConnectionFailure, original: Error) {
    // The original text stays at the end: retry rules match on it.
    super(
      `Could not connect to ${failure.host}: ${failure.reason} (${failure.code}). ${original.message}`,
      { cause: original },
    );
    this.name = "ProviderConnectionError";
    this.failure = failure;
  }
}
