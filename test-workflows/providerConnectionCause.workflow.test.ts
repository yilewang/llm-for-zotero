import { assert } from "chai";
import { setModelProviderGroups } from "../src/utils/modelProviders";
import { classifyConnectionFailure } from "../src/utils/connectionDiagnosis";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

declare const Components: any;

// Issue #572: when a provider cannot be reached, Zotero's fetch says only
// "NetworkError when attempting to fetch resource." for every cause. The
// plugin now names the cause. These failures are real and local: nothing
// listens on the port, the port is one Zotero refuses, or the name is reserved
// never to resolve.
describe("workflow: provider connection failures name their cause", function () {
  this.timeout(60000);

  /** A local port that was free a moment ago, so nothing listens on it. */
  function closedLocalPort(): number {
    const socket = Components.classes[
      "@mozilla.org/network/server-socket;1"
    ].createInstance(Components.interfaces.nsIServerSocket);
    socket.init(-1, true, -1);
    const port = socket.port as number;
    socket.close();
    return port;
  }

  async function chatError(apiBase: string): Promise<string> {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    try {
      await api.checkProviderConversationTransport({
        conversationKey: -57200572,
        apiBase,
        apiKey: "workflow-dummy-key",
        model: "workflow-model",
        providerProtocol: "openai_chat_compat",
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`Expected the request to ${apiBase} to fail`);
  }

  it("shows a refused connection in the settings Test result", async function () {
    const prefix = "extensions.zotero.llmforzotero.";
    const keys = [
      "modelProviderGroups",
      "modelProviderGroupsMigrationVersion",
      "lastUsedModelEntryId",
      "outputTokenAutoMigrationNoticePending",
    ];
    const previous = new Map(
      keys.map((key) => [key, Zotero.Prefs.get(prefix + key, true)]),
    );
    const port = closedLocalPort();
    let win: Window | undefined;
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = Date.now() + 20000;
      while (!condition() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.isTrue(condition(), message);
    };
    try {
      setModelProviderGroups([
        {
          id: "workflow-refused",
          authMode: "api_key",
          apiBase: `http://127.0.0.1:${port}/v1`,
          apiKey: "workflow-dummy-key",
          providerProtocol: "openai_chat_compat",
          models: [
            {
              id: "workflow-refused-model",
              model: "workflow-model",
              temperature: 0.3,
              outputTokenLimit: { mode: "auto" },
            },
          ],
        },
      ]);
      win = (Zotero.Utilities.Internal as any).openPreferences(
        "llmforzotero-preferences",
      );
      await waitFor(
        () =>
          Boolean(
            win?.document.querySelector(
              '[data-llm-provider-row="workflow-refused"]',
            ),
          ),
        "provider preferences render",
      );
      const row = win!.document.querySelector(
        '[data-llm-provider-row="workflow-refused"]',
      )!;
      const button = (
        Array.from(
          row.querySelectorAll<HTMLButtonElement>("button"),
        ) as HTMLButtonElement[]
      ).find((b) => b.textContent?.trim() === "Test")!;
      assert.isOk(button, "real settings Test button exists");
      button.click();
      await waitFor(
        () => Boolean(row.textContent?.includes("✗")) && !button.disabled,
        "settings test fails",
      );
      assert.include(
        row.textContent!,
        `Could not connect to 127.0.0.1:${port}: the server refused the connection (NS_ERROR_CONNECTION_REFUSED).`,
      );
    } finally {
      if (win && !win.closed) win.close();
      for (const [key, value] of previous) {
        if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, value, true);
      }
    }
  });

  it("names a blocked port and an unknown host in chat errors", async function () {
    const blocked = await chatError("http://127.0.0.1:9/v1");
    assert.include(
      blocked,
      "Could not connect to 127.0.0.1:9: Zotero blocks connections to this port for security reasons (NS_ERROR_PORT_ACCESS_NOT_ALLOWED).",
    );
    // The original text stays, so retry rules that match it still apply.
    assert.include(blocked, "NetworkError when attempting to fetch resource.");

    const unknown = await chatError("https://relay-572.invalid/v1");
    assert.include(
      unknown,
      "Could not connect to relay-572.invalid: the server name could not be found (NS_ERROR_UNKNOWN_HOST).",
    );
  });

  // The codes below are what Zotero 10 reported for badssl.com's test hosts
  // (expired, self-signed, untrusted root, wrong host, TLS 1.0 only).
  it("describes certificate and TLS failures by their security error", function () {
    const reasonFor = (securityErrorName: string) =>
      classifyConnectionFailure({
        host: "relay.example",
        status: 0x805a1ff5,
        securityErrorName,
      });
    assert.deepEqual(reasonFor("SEC_ERROR_EXPIRED_CERTIFICATE"), {
      host: "relay.example",
      kind: "certificate",
      code: "SEC_ERROR_EXPIRED_CERTIFICATE",
      reason: "its security certificate has expired",
    });
    for (const code of [
      "MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT",
      "SEC_ERROR_UNKNOWN_ISSUER",
    ])
      assert.equal(
        reasonFor(code)?.reason,
        "Zotero does not trust its security certificate (self-signed or from an unknown authority)",
      );
    assert.equal(
      reasonFor("SSL_ERROR_BAD_CERT_DOMAIN")?.reason,
      "its security certificate is for a different domain",
    );
    assert.deepInclude(reasonFor("SSL_ERROR_UNSUPPORTED_VERSION"), {
      kind: "tls",
      reason: "the secure (TLS) connection could not be set up",
    });
    assert.isNull(
      classifyConnectionFailure({ host: "relay.example", status: 0 }),
      "a connection that worked is not a failure",
    );
  });
});
