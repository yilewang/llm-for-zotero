/**
 * The shared native transport for JSON web-search APIs (AnySearch, DeepSeek).
 * Requests run anonymously in a fresh cookie context, never follow redirects,
 * never log bodies, and never parse an error body.
 */
const TIMEOUT_MS = 60_000;
const RESPONSE_LIMIT = 1_048_576;

export type IsolatedJsonTransport = (request: {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ status: number; body: unknown }>;

function parseBody(text: string): unknown {
  if (
    text.length > RESPONSE_LIMIT ||
    new TextEncoder().encode(text).byteLength > RESPONSE_LIMIT
  ) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readLimitedResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > RESPONSE_LIMIT
  ) {
    await response.body?.cancel();
    throw new Error("Response size limit exceeded.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response streaming unavailable.");
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("Response size limit exceeded.");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parseBody(parts.join(""));
  } finally {
    reader.releaseLock();
  }
}

/** Never parse or propagate error bodies: quota messages can contain credentials. */
export async function isolatedJsonTransport(
  request: Parameters<IsolatedJsonTransport>[0],
): ReturnType<IsolatedJsonTransport> {
  const zotero =
    typeof Zotero !== "undefined"
      ? Zotero
      : (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero;
  // The runtime HTTP API is newer than the bundled type declarations.
  type CookieContext = { id: number; dispose: () => void };
  const http = zotero?.HTTP as
    | (typeof Zotero.HTTP & { newCookieContext?: () => CookieContext })
    | undefined;
  if (http?.request) {
    let cookieContext: CookieContext | undefined;
    let cancel: (() => void) | undefined;
    let tooLarge = false;
    let observedStatus = 0;
    let removeObservers: (() => void) | undefined;
    const abort = () => cancel?.();
    try {
      // Modern Zotero has no CookieSandbox constructor. Always create a fresh
      // context, and never fall back to ambient cookies if its setup fails.
      let isolation:
        | { userContextId: number }
        | { cookieSandbox: Zotero.CookieSandbox };
      if (typeof http.newCookieContext === "function") {
        cookieContext = http.newCookieContext();
        if (
          !cookieContext ||
          !Number.isSafeInteger(cookieContext.id) ||
          cookieContext.id <= 0 ||
          typeof cookieContext.dispose !== "function"
        ) {
          throw new Error("Cookie isolation unavailable.");
        }
        isolation = { userContextId: cookieContext.id };
      } else {
        const CookieSandbox = (
          zotero as unknown as { CookieSandbox?: Zotero.CookieSandbox }
        ).CookieSandbox;
        if (!CookieSandbox) throw new Error("Cookie isolation unavailable.");
        isolation = {
          cookieSandbox: new CookieSandbox(
            null,
            new URL(request.url).origin,
            "",
            "",
          ),
        };
      }
      const components =
        typeof Components !== "undefined"
          ? Components
          : (
              globalThis as unknown as {
                Components?: {
                  interfaces?: { nsIRequest?: { LOAD_ANONYMOUS?: number } };
                };
              }
            ).Components;
      const anonymousFlag = components?.interfaces?.nsIRequest?.LOAD_ANONYMOUS;
      if (typeof anonymousFlag !== "number" || anonymousFlag <= 0) {
        throw new Error("Anonymous channel isolation unavailable.");
      }
      request.signal.addEventListener("abort", abort, { once: true });
      const options = {
        // Zotero 10 supports anon. The explicit channel flag below also
        // enforces no cached HTTP authentication on older supported runtimes.
        anon: true,
        headers: request.headers,
        body: request.body,
        responseType: "text",
        timeout: TIMEOUT_MS,
        successCodes: false as const,
        errorDelayMax: 0,
        followRedirects: false,
        debug: false,
        foreground: false,
        ...isolation,
        logBodyLength: 0,
        requestObserver: (xhr: XMLHttpRequest) => {
          const channel = (
            xhr as XMLHttpRequest & { channel?: { loadFlags: number } }
          ).channel;
          if (!channel || typeof channel.loadFlags !== "number") {
            throw new Error("Anonymous channel isolation unavailable.");
          }
          channel.loadFlags |= anonymousFlag;
          if ((channel.loadFlags & anonymousFlag) !== anonymousFlag) {
            throw new Error("Anonymous channel isolation failed.");
          }
          const stopOversize = () => {
            tooLarge = true;
            observedStatus = Number(xhr.status) || 0;
            xhr.abort();
          };
          const onHeaders = () => {
            if (xhr.readyState !== 2) return;
            const length = xhr.getResponseHeader("content-length");
            if (
              length &&
              /^\d+$/.test(length) &&
              Number(length) > RESPONSE_LIMIT
            ) {
              stopOversize();
            }
          };
          const onProgress = (event: ProgressEvent) => {
            if (event.loaded > RESPONSE_LIMIT) stopOversize();
          };
          xhr.addEventListener("readystatechange", onHeaders);
          xhr.addEventListener("progress", onProgress);
          removeObservers = () => {
            xhr.removeEventListener("readystatechange", onHeaders);
            xhr.removeEventListener("progress", onProgress);
          };
        },
        cancellerReceiver: (fn: () => void) => {
          cancel = fn;
          if (request.signal.aborted) fn();
        },
      };
      let xhr: XMLHttpRequest;
      try {
        xhr = await http.request(request.method, request.url, options);
      } catch {
        if (tooLarge) return { status: observedStatus || 200, body: undefined };
        throw new Error("Native transport failed.");
      }
      const status = Number(xhr.status) || 0;
      return {
        status,
        body:
          !tooLarge && status >= 200 && status < 300
            ? parseBody(xhr.responseText || "")
            : undefined,
      };
    } finally {
      try {
        removeObservers?.();
      } finally {
        try {
          request.signal.removeEventListener("abort", abort);
        } finally {
          if (typeof cookieContext?.dispose === "function") {
            cookieContext.dispose();
          }
        }
      }
    }
  }
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, body: undefined };
  }
  return { status: response.status, body: await readLimitedResponse(response) };
}
