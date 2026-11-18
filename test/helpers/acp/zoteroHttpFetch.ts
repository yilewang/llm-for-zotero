/**
 * A `fetch` for the fake ACP agent inside the test Zotero.
 *
 * The test Zotero does not listen on its HTTP port, so the fake agent's
 * calls to the plugin's MCP server go straight to the registered Zotero
 * server endpoint, as the request handler would receive them. The real agy,
 * a separate process, reaches the same endpoint over HTTP. Only what the
 * fake reads is provided: `ok`, `status`, `json()`, and `text()`.
 */
declare const Zotero: any;

export const zoteroHttpFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = new URL(String(input));
  const Endpoint = Zotero.Server.Endpoints[url.pathname];
  if (!Endpoint) throw new Error(`No Zotero endpoint at ${url.pathname}`);
  const [status, , body] = (await new Endpoint().init({
    method: String(init?.method || "GET"),
    headers: (init?.headers || {}) as Record<string, string>,
    data: init?.body ? JSON.parse(String(init.body)) : undefined,
  })) as [number, string, string];
  const text = String(body ?? "");
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}) as unknown as typeof fetch;
