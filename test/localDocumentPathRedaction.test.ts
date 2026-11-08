import { assert } from "chai";
import { afterEach, describe, it } from "mocha";

import {
  AgentEventLocalDocumentStreamRedactor,
  acquireLocalDocumentPathLease,
  clearRememberedLocalDocumentPaths,
  getRememberedLocalDocumentPathCountForTests,
  LocalDocumentPathStreamRedactor,
  redactAllRememberedLocalDocumentPaths,
  redactRememberedLocalDocumentPaths,
  redactRememberedLocalDocumentPathsFromText,
  rememberLocalDocumentPaths,
} from "../src/agent/privacy/localDocumentPathRedaction";
import type { LocalDocumentResource } from "../src/shared/types";

const usedConversationKeys = new Set<number>();

function documentAt(
  absolutePath: string,
  itemId = 10,
  contextItemId = 11,
): LocalDocumentResource {
  return {
    kind: "local_pdf",
    sourceKey: `zotero-pdf:${itemId}:${contextItemId}`,
    itemId,
    contextItemId,
    title: `PDF ${contextItemId}`,
    name: `paper-${contextItemId}.pdf`,
    mimeType: "application/pdf",
    absolutePath,
  };
}

function remember(
  conversationKey: number,
  documents: readonly LocalDocumentResource[],
): void {
  usedConversationKeys.add(conversationKey);
  rememberLocalDocumentPaths(conversationKey, documents);
}

describe("local raw PDF path redaction", function () {
  afterEach(function () {
    for (const conversationKey of usedConversationKeys) {
      clearRememberedLocalDocumentPaths(conversationKey);
    }
    usedConversationKeys.clear();
  });

  it("redacts raw, JSON-escaped, parent-directory, key, and nested value forms", function () {
    const conversationKey = 7101;
    const rawPath = "/private/papers/A\npaper.pdf";
    const jsonEscapedPath = "/private/papers/A\\npaper.pdf";
    const parentPath = "/private/papers";
    remember(conversationKey, [documentAt(rawPath)]);

    const redacted = redactRememberedLocalDocumentPaths(conversationKey, {
      [rawPath]: {
        raw: `read ${rawPath}`,
        escaped: `json ${jsonEscapedPath}`,
        parent: `directory ${parentPath}`,
        unrelated: "/private/other/file.pdf",
      },
    });
    const serialized = JSON.stringify(redacted);

    assert.notInclude(serialized, rawPath);
    assert.notInclude(serialized, jsonEscapedPath);
    assert.notInclude(serialized, parentPath);
    assert.include(serialized, "[raw_pdf_path:zotero-pdf:10:11]");
    assert.match(
      serialized,
      /\[raw_pdf_(?:path|directory):zotero-pdf:10:11\]/u,
    );
    assert.include(serialized, "/private/other/file.pdf");
  });

  it("keeps prior-turn paths protected during a later non-PDF turn", function () {
    const conversationKey = 7102;
    const rawPath = "/papers/turn-a/selected.pdf";
    remember(conversationKey, [documentAt(rawPath)]);

    const laterTurnText = redactRememberedLocalDocumentPathsFromText(
      conversationKey,
      `The previous file was ${rawPath}; unrelated=/papers-other/file.pdf`,
    );

    assert.notInclude(laterTurnText, rawPath);
    assert.notInclude(laterTurnText, "/papers/turn-a");
    assert.include(laterTurnText, "/papers-other/file.pdf");
  });

  it("does not evict earlier paths when one conversation selects many PDFs", function () {
    const conversationKey = 7103;
    const documents = Array.from({ length: 80 }, (_, index) =>
      documentAt(
        `/papers/batch-${index}/paper-${index}.pdf`,
        100 + index,
        200 + index,
      ),
    );
    remember(conversationKey, documents);

    const redacted = redactRememberedLocalDocumentPathsFromText(
      conversationKey,
      `${documents[0].absolutePath} ${documents[79].absolutePath}`,
    );

    assert.notInclude(redacted, documents[0].absolutePath);
    assert.notInclude(redacted, documents[79].absolutePath);
  });

  it("redacts a UNC share directory but does not treat broad filesystem roots as secrets", function () {
    const uncConversation = 7104;
    const rootConversation = 7105;
    const uncPath = "\\\\server\\share\\papers\\selected.pdf";
    remember(uncConversation, [documentAt(uncPath)]);
    remember(rootConversation, [documentAt("/selected.pdf", 20, 21)]);

    const uncText = redactRememberedLocalDocumentPathsFromText(
      uncConversation,
      "root=\\\\server\\share\\papers exact=" + uncPath,
    );
    const rootText = redactRememberedLocalDocumentPathsFromText(
      rootConversation,
      "exact=/selected.pdf unrelated=/other/path.pdf slash=/",
    );

    assert.notInclude(uncText, "\\\\server\\share\\papers");
    assert.notInclude(rootText, "/selected.pdf");
    assert.include(rootText, "/other/path.pdf");
    assert.include(rootText, "slash=/");
  });

  it("redacts equivalent Windows drive spellings, JSON escapes, and file URLs", function () {
    const conversationKey = 7108;
    const rawPath = "C:\\Users\\Alice Doe\\Päper.pdf";
    remember(conversationKey, [documentAt(rawPath)]);

    const variants = [
      "c:/users/ALICE DOE/pÄper.pdf",
      "c:\\\\users\\\\alice doe\\\\päper.pdf",
      "FILE:///c:/users/alice%20doe/p%c3%a4per.pdf",
      "file://localhost/C:/Users/Alice%20Doe/P%C3%A4per.pdf",
      "file:///c:/users/alice%20doe",
    ];
    const redacted = redactRememberedLocalDocumentPathsFromText(
      conversationKey,
      variants.join(" | "),
    );

    for (const variant of variants) assert.notInclude(redacted, variant);
    assert.include(redacted, "[raw_pdf_path:zotero-pdf:10:11]");
    assert.match(redacted, /\[raw_pdf_(?:path|directory):zotero-pdf:10:11\]/);
  });

  it("redacts equivalent UNC slash, host/share case, and file-URL spellings", function () {
    const conversationKey = 7109;
    const rawPath = "\\\\Server\\Research Share\\Papers\\Selected File.pdf";
    remember(conversationKey, [documentAt(rawPath)]);

    const variants = [
      "//server/RESEARCH SHARE/papers/selected file.pdf",
      "\\\\SERVER\\\\research share\\\\PAPERS\\\\selected file.pdf",
      "FILE://server/research%20share/papers/selected%20file.pdf",
      "file:////SERVER/RESEARCH%20SHARE/PAPERS/SELECTED%20FILE.PDF",
      "file://server/research%20share/papers",
    ];
    const redacted = redactRememberedLocalDocumentPathsFromText(
      conversationKey,
      variants.join(" | "),
    );

    for (const variant of variants) assert.notInclude(redacted, variant);
    assert.include(redacted, "[raw_pdf_path:zotero-pdf:10:11]");
    assert.include(redacted, "[raw_pdf_directory:zotero-pdf:10:11]");
  });

  it("treats a selected forward-slash UNC path as Windows-only UNC", function () {
    const conversationKey = 7111;
    const originalZotero = globalThis.Zotero;
    (globalThis as typeof globalThis & { Zotero: { isWin: boolean } }).Zotero =
      {
        ...(originalZotero as unknown as Record<string, unknown>),
        isWin: true,
      } as typeof Zotero & { isWin: boolean };
    try {
      remember(conversationKey, [
        documentAt("//Server/Research Share/Papers/Selected.pdf"),
      ]);
    } finally {
      globalThis.Zotero = originalZotero;
    }

    const variants = [
      "\\\\server\\RESEARCH SHARE\\papers\\selected.pdf",
      "file://SERVER/research%20share/PAPERS/SELECTED.PDF",
    ];
    const redacted = redactRememberedLocalDocumentPathsFromText(
      conversationKey,
      variants.join(" | "),
    );
    for (const variant of variants) assert.notInclude(redacted, variant);
  });

  it("redacts POSIX file URLs while preserving exact POSIX path case", function () {
    const conversationKey = 7110;
    const rawPath = "/Users/Alice Doe/Paper.pdf";
    const lowerCasePath = "/users/alice doe/paper.pdf";
    const lowerCaseUrl = "file:///users/alice%20doe/paper.pdf";
    remember(conversationKey, [documentAt(rawPath)]);

    const redacted = redactRememberedLocalDocumentPathsFromText(
      conversationKey,
      [
        "file:///Users/Alice%20Doe/Paper.pdf",
        "FILE:///Users/Alice%20Doe/Paper.pdf",
        "file://localhost/Users/Alice%20Doe/Paper.pdf",
        lowerCasePath,
        lowerCaseUrl,
      ].join(" | "),
    );

    assert.notInclude(redacted, "file:///Users/Alice%20Doe/Paper.pdf");
    assert.notInclude(redacted, "FILE:///Users/Alice%20Doe/Paper.pdf");
    assert.notInclude(redacted, "file://localhost/Users/Alice%20Doe/Paper.pdf");
    assert.include(redacted, lowerCasePath);
    assert.include(redacted, lowerCaseUrl);
  });

  it("redacts NFC, NFD, single-slash file URLs, and shell-escaped POSIX forms", function () {
    const conversationKey = 7121;
    const decomposedPath = "/Users/Alice/Cafe\u0301 Papers/Selected File.pdf";
    const composedPath = decomposedPath.normalize("NFC");
    remember(conversationKey, [documentAt(decomposedPath)]);

    const variants = [
      composedPath,
      "file:/Users/Alice/Caf%C3%A9%20Papers/Selected%20File.pdf",
      "FILE:/Users/Alice/Caf%C3%A9%20Papers/Selected%20File.pdf",
      "/Users/Alice/Café\\ Papers/Selected\\ File.pdf",
    ];
    const redacted = redactRememberedLocalDocumentPathsFromText(
      conversationKey,
      variants.join(" | "),
    );

    for (const variant of variants) assert.notInclude(redacted, variant);
    assert.include(redacted, "[raw_pdf_path:zotero-pdf:10:11]");

    for (const variant of variants) {
      const split = Math.max(1, Math.floor(variant.length / 2));
      const stream = new LocalDocumentPathStreamRedactor(conversationKey);
      const output = [
        stream.push("answer", variant.slice(0, split)),
        stream.push("answer", variant.slice(split)),
        stream.push("answer", " done"),
        stream.flush("answer"),
      ].join("");
      assert.notInclude(output, variant);
      assert.match(output, /\[raw_pdf_(?:path|directory):/);
    }
  });

  it("redacts mixed raw/percent file URLs and partially shell-escaped paths", function () {
    const conversationKey = 7121;
    const rawPath = "/Users/Alice Doe/Café Papers/Selected File.pdf";
    remember(conversationKey, [documentAt(rawPath)]);
    const variants = [
      "file:///Users/Alice%20Doe/Café%20Papers/Selected%20File.pdf",
      "/Users/Alice\\ Doe/Café Papers/Selected\\ File.pdf",
      "file:///Users/Alice Doe/Caf%C3%A9 Papers/Selected%20File.pdf",
    ];
    const redacted = redactRememberedLocalDocumentPathsFromText(
      conversationKey,
      variants.join(" | "),
    );
    for (const variant of variants) assert.notInclude(redacted, variant);
  });

  it("fails closed at every terminal boundary of UNC and file-URL hosts", function () {
    const conversationKey = 7122;
    const paths = [
      "\\\\PrivateServer\\Research Share\\Selected.pdf",
      "file://PrivateServer/Research%20Share/Selected.pdf",
    ];
    remember(conversationKey, [documentAt(paths[0])]);
    for (const path of paths) {
      for (let split = 3; split < path.length; split += 1) {
        const prefix = path.slice(0, split);
        const stream = new LocalDocumentPathStreamRedactor(conversationKey);
        stream.push("test", prefix);
        const flushed = stream.flush("test");
        if (
          /^(?:\\\\|\/\/)[^\\/]+/u.test(prefix) ||
          /^file:[\\/]+[^\\/]+/iu.test(prefix)
        ) {
          assert.notInclude(flushed, prefix, `boundary ${split}: ${prefix}`);
        }
      }
    }
  });

  it("retains active lease protection across clear and releases it afterward", function () {
    const conversationKey = 7123;
    usedConversationKeys.add(conversationKey);
    const rawPath = "/private/leased/selected.pdf";
    const lease = acquireLocalDocumentPathLease(conversationKey, [
      documentAt(rawPath),
    ]);
    clearRememberedLocalDocumentPaths(conversationKey);
    assert.notInclude(
      redactRememberedLocalDocumentPathsFromText(conversationKey, rawPath),
      rawPath,
    );
    lease.release();
    assert.equal(
      getRememberedLocalDocumentPathCountForTests(conversationKey),
      0,
    );
  });

  it("keeps a completed turn's paths protected until conversation cleanup", function () {
    const conversationKey = 7125;
    usedConversationKeys.add(conversationKey);
    const rawPath = "/private/cross-turn/selected.pdf";
    const lease = acquireLocalDocumentPathLease(conversationKey, [
      documentAt(rawPath),
    ]);

    lease.release();

    assert.notInclude(
      redactRememberedLocalDocumentPathsFromText(conversationKey, rawPath),
      rawPath,
    );
    assert.isAbove(
      getRememberedLocalDocumentPathCountForTests(conversationKey),
      0,
    );
    clearRememberedLocalDocumentPaths(conversationKey);
    assert.equal(
      getRememberedLocalDocumentPathCountForTests(conversationKey),
      0,
    );
  });

  it("does not let an old lease release erase a newly registered path", function () {
    const conversationKey = 7124;
    usedConversationKeys.add(conversationKey);
    const rawPath = "/private/recreated/selected.pdf";
    const lease = acquireLocalDocumentPathLease(conversationKey, [
      documentAt(rawPath),
    ]);
    clearRememberedLocalDocumentPaths(conversationKey);
    remember(conversationKey, [documentAt(rawPath)]);
    lease.release();
    assert.notInclude(
      redactRememberedLocalDocumentPathsFromText(conversationKey, rawPath),
      rawPath,
    );
  });

  it("redacts raw, escaped, and file-URL paths split at every stream boundary", function () {
    const conversationKey = 7112;
    const rawPath = "C:\\Private Papers\\Alice\\Selected File.pdf";
    remember(conversationKey, [documentAt(rawPath)]);
    const variants = [
      rawPath,
      JSON.stringify(rawPath).slice(1, -1),
      "c:/private papers/ALICE/selected file.pdf",
      "FILE:///c:/private%20papers/alice/selected%20file.pdf",
    ];

    for (const variant of variants) {
      for (let split = 1; split < variant.length; split += 1) {
        const redactor = new LocalDocumentPathStreamRedactor(conversationKey);
        const output = [
          redactor.push("answer", variant.slice(0, split)),
          redactor.push("answer", variant.slice(split)),
          redactor.push("answer", " done"),
          redactor.flush("answer"),
        ].join("");
        assert.notInclude(output, variant, `split ${split} of ${variant}`);
        assert.include(output, "[raw_pdf_path:zotero-pdf:10:11]");
      }
    }
  });

  it("fails closed when a held raw, URI, drive, UNC, NFC, or NFD prefix diverges", function () {
    const cases = [
      {
        rawPath: "/Users/Alice Doe/Private Papers/Selected.pdf",
        variants: [
          "/Users/Alice Doe/Private Papers/Selected.pdf",
          "/Users/Alice\\ Doe/Private\\ Papers/Selected.pdf",
          "file:///Users/Alice%20Doe/Private%20Papers/Selected.pdf",
        ],
      },
      {
        rawPath: "C:\\Private Papers\\Alice\\Selected.pdf",
        variants: [
          "c:/private papers/alice/selected.pdf",
          "FILE:///C:/Private%20Papers/Alice/Selected.pdf",
        ],
      },
      {
        rawPath: "\\\\Server\\Private Share\\Selected.pdf",
        variants: [
          "//server/private share/selected.pdf",
          "file://SERVER/Private%20Share/Selected.pdf",
        ],
      },
      {
        rawPath: "/Users/Alice/Café/Selected.pdf",
        variants: [
          "/Users/Alice/Café/Selected.pdf".normalize("NFC"),
          "/Users/Alice/Café/Selected.pdf".normalize("NFD"),
        ],
      },
    ];
    let conversationKey = 7130;
    for (const testCase of cases) {
      remember(conversationKey, [documentAt(testCase.rawPath)]);
      for (const variant of testCase.variants) {
        const split = Math.max(2, variant.length - 3);
        const prefix = variant.slice(0, split);
        const redactor = new LocalDocumentPathStreamRedactor(conversationKey);
        assert.equal(redactor.push("answer", prefix), "");
        const output = `${redactor.push("answer", "☃")}${redactor.flush(
          "answer",
        )}`;
        assert.notInclude(output, prefix);
        assert.include(output, "[raw_pdf_");
        assert.include(output, "☃");
      }
      conversationKey += 1;
    }
  });

  it("retains an immutable stream snapshot while lifecycle cleanup drains split output", function () {
    const conversationKey = 7122;
    const rawPath = "/Users/Alice/Secret Papers/Selected.pdf";
    const split = rawPath.indexOf(" Papers");
    remember(conversationKey, [documentAt(rawPath)]);
    const stream = new LocalDocumentPathStreamRedactor(conversationKey);

    const first = stream.push("answer", rawPath.slice(0, split));
    clearRememberedLocalDocumentPaths(conversationKey);
    const second = stream.push("answer", rawPath.slice(split));
    const terminal = stream.flush("answer");
    const output = `${first}${second}${terminal}`;

    assert.notInclude(output, rawPath);
    assert.notInclude(output, "/Users/Alice/Secret");
    assert.match(output, /\[raw_pdf_(?:path|directory):zotero-pdf:10:11\]/);
  });

  it("fails closed when a stream ends during a sensitive path prefix", function () {
    const cases = [
      {
        conversationKey: 7114,
        rawPath: "/Users/Alice Doe/Private Papers/Selected.pdf",
        prefix: "/Users/Ali",
      },
      {
        conversationKey: 7115,
        rawPath: "C:\\Private Papers\\Alice\\Selected.pdf",
        prefix: "c:/private pa",
      },
      {
        conversationKey: 7116,
        rawPath: "\\\\server\\private share\\Selected.pdf",
        prefix: "//SERVER/private sh",
      },
    ];

    for (const { conversationKey, rawPath, prefix } of cases) {
      remember(conversationKey, [documentAt(rawPath)]);
      const direct = new LocalDocumentPathStreamRedactor(conversationKey);
      assert.equal(direct.push("answer", prefix), "");
      assert.match(direct.flush("answer"), /^\[raw_pdf_(?:path|directory):/);

      const aggregate = new LocalDocumentPathStreamRedactor(conversationKey);
      assert.equal(aggregate.push("reasoning", prefix), "");
      const flushed = aggregate.flushAll();
      assert.lengthOf(flushed, 1);
      assert.match(flushed[0]?.text || "", /^\[raw_pdf_(?:path|directory):/);
      assert.notInclude(JSON.stringify(flushed), prefix);
    }
  });

  it("does not treat ordinary terminal text as a sensitive path prefix", function () {
    const conversationKey = 7117;
    remember(conversationKey, [
      documentAt("/Users/Alice Doe/Private Papers/Selected.pdf"),
    ]);
    for (const ordinary of [
      "PDF",
      "ordinary file",
      "https://example.com/",
      "proof",
    ]) {
      const direct = new LocalDocumentPathStreamRedactor(conversationKey);
      const output = `${direct.push("answer", ordinary)}${direct.flush(
        "answer",
      )}`;
      assert.equal(output, ordinary);
    }
  });

  it("holds split assistant and reasoning event paths until a safe boundary", function () {
    const conversationKey = 7113;
    const rawPath = "/private/papers/selected.pdf";
    remember(conversationKey, [documentAt(rawPath)]);
    const split = Math.floor(rawPath.length / 2);
    const redactor = new AgentEventLocalDocumentStreamRedactor(conversationKey);

    const events = [
      ...redactor.process({
        type: "message_delta",
        text: rawPath.slice(0, split),
      }),
      ...redactor.process({
        type: "message_delta",
        text: rawPath.slice(split),
      }),
      ...redactor.process({
        type: "message_delta",
        text: " done",
      }),
      ...redactor.process({
        type: "reasoning",
        round: 1,
        stepId: "reasoning-1",
        stepLabel: `Reading ${rawPath}`,
        summary: rawPath.slice(0, split),
      }),
      ...redactor.process({
        type: "reasoning",
        round: 1,
        stepId: "reasoning-1",
        stepLabel: `Reading ${rawPath}`,
        summary: rawPath.slice(split),
      }),
      ...redactor.process({
        type: "provider_event",
        providerType: `test:${rawPath}`,
        payload: { [rawPath]: "provider value" },
      }),
      ...redactor.process({
        type: "status",
        text: `Reading ${rawPath}`,
      }),
      ...redactor.process({
        type: "message_rollback",
        length: split,
        text: rawPath.slice(0, split),
      }),
      ...redactor.process({
        type: "fallback",
        reason: rawPath.slice(0, split),
      }),
      ...redactor.process({
        type: "final",
        text: rawPath.slice(0, split),
      }),
    ];
    const serialized = JSON.stringify(events);

    assert.notInclude(serialized, rawPath);
    assert.include(serialized, "[raw_pdf_path:zotero-pdf:10:11]");
    assert.include(serialized, '"type":"message_delta"');
    assert.include(serialized, '"type":"reasoning"');
    assert.include(serialized, '"type":"status"');
    assert.include(serialized, '"type":"message_rollback"');
  });

  it("passes a step snapshot whole, redacting a path in its steps", function () {
    const conversationKey = 7141;
    const rawPath = "/private/papers/selected.pdf";
    remember(conversationKey, [documentAt(rawPath)]);
    const redactor = new AgentEventLocalDocumentStreamRedactor(conversationKey);
    const events = [
      ...redactor.process({
        type: "codex_progress",
        itemId: "codex-plan-checklist",
        text: `• Read ${rawPath.slice(0, 10)}`,
        runtime: "claude",
        steps: [{ content: `Read ${rawPath}`, status: "pending" }],
      }),
      ...redactor.flush(),
    ];

    assert.lengthOf(events, 1);
    assert.notInclude(JSON.stringify(events), rawPath);
    const [event] = events;
    assert.equal(event.type, "codex_progress");
    assert.include(
      (event as { steps: Array<{ content: string }> }).steps[0].content,
      "[raw_pdf_path:zotero-pdf:10:11]",
    );
  });

  it("redacts each status and provider event on its own, holding nothing for the next one", function () {
    let conversationKey = 7140;
    for (const rawPath of [
      "/Users/Alice/Papers/Selected.pdf",
      "T:\\Papers\\Selected.pdf",
      "D:\\Papers\\Selected.pdf",
    ]) {
      remember(conversationKey, [documentAt(rawPath)]);
      const redactor = new AgentEventLocalDocumentStreamRedactor(
        conversationKey,
      );
      const statuses = [
        "Running agent",
        "Reading the pdf",
        "Saving the file",
        "Checked the draft",
        "Done",
      ];
      const payload = { rule: "final_answer", status: "completed", id: "3f" };
      const events = [
        ...statuses.flatMap((text) =>
          redactor.process({ type: "status", text }),
        ),
        ...redactor.process({
          type: "provider_event",
          providerType: "agent_run_stop",
          payload,
        }),
        ...redactor.flush(),
      ];

      assert.deepEqual(
        events.map((event) =>
          event.type === "status" ? event.text : event.type,
        ),
        [...statuses, "provider_event"],
        rawPath,
      );
      assert.deepEqual(
        events.find((event) => event.type === "provider_event")?.payload,
        payload,
        rawPath,
      );
      conversationKey += 1;
    }
  });

  it("releases ordinary words that stream lookahead held at a delta boundary", function () {
    let conversationKey = 7145;
    for (const rawPath of [
      "/Users/Alice/Papers/Selected.pdf",
      "T:\\Papers\\Selected.pdf",
    ]) {
      remember(conversationKey, [documentAt(rawPath)]);
      const redactor = new AgentEventLocalDocumentStreamRedactor(
        conversationKey,
      );
      const deltas = [
        "I saved it to the file",
        " you named. The best",
        " test is the pdf",
        " itself.",
      ];
      const summaries = ["Check the pdf", " first, then the draft", "."];
      const events = [
        ...deltas.flatMap((text) =>
          redactor.process({ type: "message_delta", text }),
        ),
        ...summaries.flatMap((summary) =>
          redactor.process({
            type: "reasoning",
            round: 1,
            stepId: "reasoning-1",
            summary,
          }),
        ),
        ...redactor.flush(),
      ];

      assert.equal(
        events
          .map((event) => (event.type === "message_delta" ? event.text : ""))
          .join(""),
        deltas.join(""),
        rawPath,
      );
      assert.equal(
        events
          .map((event) =>
            event.type === "reasoning" ? event.summary || "" : "",
          )
          .join(""),
        summaries.join(""),
        rawPath,
      );
      conversationKey += 1;
    }
  });

  it("preserves ordinary provider payload text", function () {
    const conversationKey = 7118;
    remember(conversationKey, [
      documentAt("/Users/Alice Doe/Private Papers/Selected.pdf"),
    ]);
    const redactor = new AgentEventLocalDocumentStreamRedactor(conversationKey);
    const events = [
      ...redactor.process({
        type: "provider_event",
        providerType: "test",
        payload: { text: "proof" },
      }),
      ...redactor.flush(),
    ];
    const chunks = events.map((event) =>
      event.type === "provider_event" ? String(event.payload?.text || "") : "",
    );

    assert.equal(chunks.join(""), "proof");
  });

  it("fails closed for a terminal sensitive prefix in a provider payload", function () {
    const conversationKey = 7119;
    const prefix = "/Users/Ali";
    remember(conversationKey, [
      documentAt("/Users/Alice Doe/Private Papers/Selected.pdf"),
    ]);
    const redactor = new AgentEventLocalDocumentStreamRedactor(conversationKey);
    const events = [
      ...redactor.process({
        type: "provider_event",
        providerType: "test",
        payload: { text: prefix },
      }),
      ...redactor.flush(),
    ];
    const serialized = JSON.stringify(events);

    assert.notInclude(serialized, prefix);
    assert.match(
      serialized,
      /\[raw_pdf_(?:path|directory):zotero-pdf:10:11\]/u,
    );
  });

  it("fails closed for terminal prefixes in complete structured events", function () {
    const conversationKey = 7120;
    const prefix = "/Users/Ali";
    remember(conversationKey, [
      documentAt("/Users/Alice Doe/Private Papers/Selected.pdf"),
    ]);
    const redactor = new AgentEventLocalDocumentStreamRedactor(conversationKey);
    const events = redactor.process({
      type: "tool_result",
      callId: "call-1",
      name: "example",
      ok: false,
      content: { nested: { error: prefix } },
    });
    const serialized = JSON.stringify(events);

    assert.notInclude(serialized, prefix);
    assert.match(serialized, /\[raw_pdf_(?:path|directory):zotero-pdf:10:11\]/);
  });

  it("terminal-redacts non-streamed metadata on reasoning and provider events", function () {
    const conversationKey = 7125;
    const prefix = "/Users/Ali";
    remember(conversationKey, [
      documentAt("/Users/Alice Doe/Private Papers/Selected.pdf"),
    ]);
    const redactor = new AgentEventLocalDocumentStreamRedactor(conversationKey);
    const events = [
      ...redactor.process({
        type: "reasoning",
        round: 1,
        stepId: prefix,
        stepLabel: prefix,
        summary: "safe summary",
      }),
      ...redactor.process({
        type: "provider_event",
        providerType: prefix,
        sessionId: prefix,
        payload: { completeMetadata: "safe" },
      }),
      ...redactor.flush(),
    ];
    assert.notInclude(JSON.stringify(events), prefix);
  });

  it("supports process-wide redaction and clears only on lifecycle cleanup", function () {
    const conversationKey = 7106;
    const otherConversationKey = 7107;
    const rawPath = "C:\\papers\\selected.pdf";
    remember(conversationKey, [documentAt(rawPath)]);

    assert.equal(
      redactRememberedLocalDocumentPathsFromText(otherConversationKey, rawPath),
      rawPath,
    );
    assert.notInclude(
      JSON.stringify(
        redactAllRememberedLocalDocumentPaths({ message: rawPath }),
      ),
      rawPath,
    );

    clearRememberedLocalDocumentPaths(conversationKey);
    assert.equal(
      redactRememberedLocalDocumentPathsFromText(conversationKey, rawPath),
      rawPath,
    );
  });
});
