/**
 * A fake OpenAI-compatible provider for live workflow tests. It replaces the
 * plugin's `fetch` (through its toolkit's `getGlobal`) for one fake API base
 * only, and hands every streamed chat completion to the test as a held
 * stream that the test pushes text into, finishes, or breaks.
 *
 * The same mechanism chatTurnLifecycle.workflow.test.ts uses, as a reusable
 * helper: the plugin's real send flow, request assembly and stream parsing
 * all run; only the network is scripted.
 */

declare const Zotero: any;

/** One streamed chat completion that the test controls chunk by chunk. */
export type HeldStream = {
  url: string;
  /** The JSON request body the panel sent. */
  requestBody: string;
  /** The `model` field of the request body. */
  model: string;
  /** Text of the last user message in the request. */
  lastUserText: string;
  push: (text: string) => void;
  finish: () => void;
  fail: (message: string) => void;
  readonly aborted: boolean;
  readonly ended: boolean;
};

export type HeldChatProvider = {
  streams: HeldStream[];
  /** Waits for the first unclaimed stream whose last user message has `marker`. */
  waitForStream: (marker: string, timeoutMs?: number) => Promise<HeldStream>;
  /** Fails every stream that is still open (for test cleanup). */
  failOpenStreams: (message: string) => void;
  restore: () => void;
};

function readLastUserText(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      input?: Array<{ role?: string; content?: unknown }>;
    };
    const messages = parsed.messages || parsed.input || [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role !== "user") continue;
      const content = message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part: any) =>
            typeof part === "string" ? part : String(part?.text || ""),
          )
          .join("\n");
      }
      return JSON.stringify(content ?? "");
    }
  } catch {
    // Fall through: an unparsable body is matched as raw text below.
  }
  return body;
}

function readModel(body: string): string {
  try {
    return String((JSON.parse(body) as { model?: unknown }).model || "");
  } catch {
    return "";
  }
}

function createHeldStream(
  url: string,
  requestBody: string,
  signal?: AbortSignal,
): HeldStream & { body: unknown } {
  const encoder = new TextEncoder();
  const queue: Uint8Array[] = [];
  let ended = false;
  let failure: unknown = null;
  let aborted = false;
  let waiter: {
    resolve: (result: { value?: Uint8Array; done: boolean }) => void;
    reject: (error: unknown) => void;
  } | null = null;
  const settleWaiter = () => {
    if (!waiter) return;
    const current = waiter;
    if (queue.length) {
      waiter = null;
      current.resolve({ value: queue.shift(), done: false });
    } else if (failure) {
      waiter = null;
      current.reject(failure);
    } else if (ended) {
      waiter = null;
      current.resolve({ value: undefined, done: true });
    }
  };
  const send = (payload: unknown) => {
    queue.push(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    settleWaiter();
  };
  // A real fetch body rejects its pending read with an AbortError once the
  // request's signal aborts; poll so the fake does not depend on whether the
  // signal in this chrome scope supports listeners.
  const abortPoll = setInterval(() => {
    if (!signal?.aborted || failure) return;
    aborted = true;
    failure = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    clearInterval(abortPoll);
    settleWaiter();
  }, 20);
  return {
    url,
    requestBody,
    model: readModel(requestBody),
    lastUserText: readLastUserText(requestBody),
    push: (text) => send({ choices: [{ delta: { content: text } }] }),
    finish: () => {
      if (ended || failure) return;
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      queue.push(encoder.encode("data: [DONE]\n\n"));
      ended = true;
      clearInterval(abortPoll);
      settleWaiter();
    },
    fail: (message) => {
      if (ended || failure) return;
      failure = new Error(message);
      clearInterval(abortPoll);
      settleWaiter();
    },
    get aborted() {
      return aborted;
    },
    get ended() {
      return ended || Boolean(failure);
    },
    body: {
      getReader: () => ({
        read: () =>
          new Promise<{ value?: Uint8Array; done: boolean }>(
            (resolve, reject) => {
              waiter = { resolve, reject };
              settleWaiter();
            },
          ),
        releaseLock: () => undefined,
        cancel: async () => undefined,
      }),
    },
  };
}

function jsonResponse(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Not Found",
    headers: { get: () => "application/json" },
    body: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Routes every request to `apiBase` to the fake. Streamed chat completions
 * become held streams; non-streamed chat completions (utility calls such as
 * the retrieval query planner) get an empty-variants answer; anything else on
 * the fake host is a 404. Other hosts pass through to the real fetch.
 */
export function installHeldChatProvider(apiBase: string): HeldChatProvider {
  const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
  const originalGetGlobal = toolkit.getGlobal as (name: string) => unknown;
  const streams: HeldStream[] = [];
  const claimed = new Set<HeldStream>();
  toolkit.getGlobal = function (this: unknown, name: string) {
    if (name !== "fetch") return originalGetGlobal.call(this, name);
    const realFetch = originalGetGlobal.call(this, name) as typeof fetch;
    return async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (!target.startsWith(apiBase)) return realFetch(target, init);
      const bodyText = String(init?.body || "");
      const payload = (() => {
        try {
          return JSON.parse(bodyText || "{}") as { stream?: boolean };
        } catch {
          return {};
        }
      })();
      if (target === `${apiBase}/chat/completions` && payload.stream) {
        const stream = createHeldStream(
          target,
          bodyText,
          init?.signal || undefined,
        );
        streams.push(stream);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "text/event-stream" },
          body: stream.body,
          json: async () => ({}),
          text: async () => "",
        };
      }
      if (target === `${apiBase}/chat/completions`) {
        return jsonResponse(true, 200, {
          choices: [
            {
              message: { role: "assistant", content: '{"variants":[]}' },
              finish_reason: "stop",
            },
          ],
        });
      }
      return jsonResponse(false, 404, { error: { message: "not found" } });
    };
  };
  return {
    streams,
    waitForStream: async (marker, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = streams.find(
          (stream) =>
            !claimed.has(stream) && stream.lastUserText.includes(marker),
        );
        if (match) {
          claimed.add(match);
          return match;
        }
        await Zotero.Promise.delay(25);
      }
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for a provider request for "${marker}"; requests seen: ${JSON.stringify(
          streams.map((stream) => stream.lastUserText.slice(0, 120)),
        )}`,
      );
    },
    failOpenStreams: (message) => {
      for (const stream of streams) stream.fail(message);
    },
    restore: () => {
      toolkit.getGlobal = originalGetGlobal;
    },
  };
}
