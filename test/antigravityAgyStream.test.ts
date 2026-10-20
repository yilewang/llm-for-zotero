import { assert } from "chai";
import {
  AgyTextAccumulator,
  buildAgyPrompt,
  describeAgyFailure,
  encodeAgyUserEvent,
  fingerprintSystemContext,
  isAgyAuthenticationFailure,
  parseAgyStreamLine,
  toUsageStats,
} from "../src/antigravity/agyStream";
import {
  buildAgyArguments,
  listAgyBinaryCandidates,
  parseAgyModelList,
  parseScutilProxy,
} from "../src/antigravity/agyProcess";
import {
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  buildAntigravityRuntimeModelEntries,
  loadAntigravityModelCatalog,
  getAntigravityModelCatalogSnapshot,
  resetAntigravityModelCatalogForTests,
  selectAntigravityRuntimeEntry,
  toAntigravityModelPref,
} from "../src/antigravity/modelCatalog";
import type { ChatMessage } from "../src/shared/llm";

describe("Antigravity agy headless protocol", function () {
  describe("parseAgyStreamLine", function () {
    it("reads init, answer deltas, tool steps and the result", function () {
      assert.deepEqual(
        parseAgyStreamLine(
          '{"event":"init","conversation_id":"c-1","model":"gemini"}',
        ),
        { kind: "init", conversationId: "c-1", model: "gemini" },
      );
      assert.deepEqual(
        parseAgyStreamLine(
          '{"event":"step_update","step_type":"agent_response","step_index":2,"state":"ACTIVE","text_delta":"Hel"}',
        ),
        { kind: "text", stepIndex: 2, state: "ACTIVE", delta: "Hel" },
      );
      assert.deepEqual(
        parseAgyStreamLine(
          '{"event":"step_update","step_update":{"step_type":"tool","step_index":3,"state":"ACTIVE","tool_name":"view_file","tool_info":{"summary":"Reading paper.md"}}}',
        ),
        {
          kind: "tool",
          stepIndex: 3,
          toolName: "view_file",
          state: "ACTIVE",
          summary: "Reading paper.md",
        },
      );
      const result = parseAgyStreamLine(
        '{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"Done","usage":{"input_tokens":10,"output_tokens":4},"denied_actions":[{"summary":"run ls"},"write file"]}}',
      );
      assert.deepEqual(result, {
        kind: "result",
        conversationId: "c-1",
        status: "SUCCESS",
        response: "Done",
        error: undefined,
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          thinking_tokens: undefined,
          cache_read_tokens: undefined,
          total_tokens: undefined,
        },
        deniedActions: ["run ls", "write file"],
      });
    });

    it("reads a real agy 1.4.2 transcript", function () {
      const lines = [
        '{"event":"init","conversation_id":"cf3b","init":{"model":"gemini-4-argon-low","cwd":"/Users/m","tools":["view_file"],"permission_mode":"request-review"}}',
        '{"event":"step_update","step_update":{"conversation_id":"cf3b","step_index":0,"state":"DONE","step_type":"user_input"}}',
        '{"event":"step_update","step_update":{"conversation_id":"cf3b","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello! How can I help you today?"}}',
        '{"event":"step_update","step_update":{"conversation_id":"cf3b","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":27.69,"usage":{"input_tokens":11765,"output_tokens":13}}}',
        '{"event":"result","result":{"conversation_id":"cf3b","status":"SUCCESS","response":"Hello! How can I help you today?\\n","num_turns":1,"usage":{"input_tokens":11765,"output_tokens":13,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":11778}}}',
      ];
      const events = lines.map(parseAgyStreamLine);
      assert.deepInclude(events[0], { kind: "init", conversationId: "cf3b" });
      assert.isNull(events[1]);
      assert.deepEqual(events[2], {
        kind: "text",
        stepIndex: 1,
        state: "ACTIVE",
        delta: "Hello! How can I help you today?",
      });
      const result = events[4];
      assert.equal(result?.kind, "result");
      if (result?.kind === "result") {
        assert.equal(result.conversationId, "cf3b");
        assert.equal(result.status, "SUCCESS");
        assert.equal(result.response, "Hello! How can I help you today?\n");
      }
      const acc = new AgyTextAccumulator();
      for (const event of events) {
        if (event?.kind === "text")
          acc.push(event.stepIndex, event.delta, event.state);
      }
      assert.equal(acc.text().trim(), "Hello! How can I help you today?");
    });

    it("ignores lines that are not protocol events", function () {
      assert.isNull(parseAgyStreamLine(""));
      assert.isNull(parseAgyStreamLine("Loading model…"));
      assert.isNull(parseAgyStreamLine("{not json"));
      assert.isNull(parseAgyStreamLine('{"event":"heartbeat"}'));
      assert.isNull(
        parseAgyStreamLine(
          '{"event":"step_update","step_type":"user_input","text_delta":"x"}',
        ),
      );
    });
  });

  describe("AgyTextAccumulator", function () {
    it("streams fragments, trims cumulative snapshots and skips DONE", function () {
      const acc = new AgyTextAccumulator();
      assert.equal(acc.push(1, "Hello"), "Hello");
      assert.equal(acc.push(1, "Hello, wor"), ", wor");
      assert.equal(acc.push(1, "ld"), "ld");
      assert.equal(acc.push(1, "Hello, world", "DONE"), "");
      assert.equal(acc.push(4, "After the tool."), "\n\nAfter the tool.");
      assert.equal(acc.text(), "Hello, world\n\nAfter the tool.");
    });
  });

  describe("buildAgyPrompt", function () {
    const messages: ChatMessage[] = [
      { role: "system", content: "You read papers." },
      { role: "system", content: "Paper text: ..." },
      { role: "user", content: "What is it about?" },
      { role: "assistant", content: "Diffusion." },
      {
        role: "user",
        content: [
          { type: "text", text: "And this figure?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
        ],
      } as ChatMessage,
    ];

    it("sends context, the transcript and the question to a fresh conversation", function () {
      const prompt = buildAgyPrompt({
        messages,
        resumed: false,
        includeSystem: true,
      });
      assert.include(
        prompt,
        "<instructions_and_context>\nYou read papers.\n\nPaper text: ...\n</instructions_and_context>",
      );
      assert.include(
        prompt,
        "<earlier_conversation>\nUser: What is it about?\n\nAssistant: Diffusion.\n</earlier_conversation>",
      );
      assert.include(
        prompt,
        "<question>\nAnd this figure?\n[An image was attached here.]\n</question>",
      );
    });

    it("sends only the question to a resumed conversation whose context is unchanged", function () {
      assert.equal(
        buildAgyPrompt({ messages, resumed: true, includeSystem: false }),
        "And this figure?\n[An image was attached here.]",
      );
      const updated = buildAgyPrompt({
        messages,
        resumed: true,
        includeSystem: true,
      });
      assert.match(updated, /^<updated_context>/);
      assert.notInclude(updated, "<earlier_conversation>");
    });

    it("fingerprints only the system context", function () {
      const a = fingerprintSystemContext(messages);
      const b = fingerprintSystemContext([
        ...messages,
        { role: "user", content: "more" },
      ]);
      const c = fingerprintSystemContext([
        { role: "system", content: "Other paper" },
      ]);
      assert.equal(a, b);
      assert.notEqual(a, c);
    });
  });

  it("encodes one stdin user event per turn", function () {
    const line = encodeAgyUserEvent('Say "hi"\nplease');
    assert.isTrue(line.endsWith("\n"));
    assert.deepEqual(JSON.parse(line), {
      event: "user",
      message: { content: 'Say "hi"\nplease' },
    });
  });

  it("reads AGY_ERROR lines and recognises a missing sign-in", function () {
    assert.equal(
      describeAgyFailure(
        'starting\nAGY_ERROR: {"status":"MODEL_ERROR","message":"quota exceeded"}\n',
      ),
      "quota exceeded",
    );
    assert.equal(describeAgyFailure("one\nlast line\n"), "last line");
    assert.isTrue(isAgyAuthenticationFailure("Please sign in to continue"));
    assert.isFalse(isAgyAuthenticationFailure("quota exceeded"));
  });

  it("maps agy usage to plugin usage stats", function () {
    assert.deepEqual(
      toUsageStats({
        input_tokens: 100,
        cache_read_tokens: 20,
        output_tokens: 30,
        thinking_tokens: 5,
      }),
      {
        promptTokens: 120,
        completionTokens: 35,
        totalTokens: 155,
        cacheReadTokens: 20,
      },
    );
    assert.isNull(toUsageStats(undefined));
    assert.isNull(toUsageStats({}));
  });
});

describe("Antigravity agy process helpers", function () {
  it("builds the headless arguments from the turn options", function () {
    assert.deepEqual(buildAgyArguments({}), [
      "--print=",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
    ]);
    assert.deepEqual(
      buildAgyArguments({
        model: " gemini-x ",
        effort: "high",
        mode: "plan",
        skipPermissions: true,
        conversationId: "c-9",
      }).slice(6),
      [
        "--model",
        "gemini-x",
        "--effort",
        "high",
        "--mode",
        "plan",
        "--dangerously-skip-permissions",
        "--conversation",
        "c-9",
      ],
    );
  });

  it("turns the macOS system proxy into proxy variables for agy", function () {
    const clash = [
      "<dictionary> {",
      "  ExceptionsList : <array> {",
      "    0 : 127.0.0.1",
      "  }",
      "  HTTPEnable : 1",
      "  HTTPPort : 7890",
      "  HTTPProxy : 127.0.0.1",
      "  HTTPSEnable : 1",
      "  HTTPSPort : 7890",
      "  HTTPSProxy : 127.0.0.1",
      "  SOCKSEnable : 1",
      "  SOCKSPort : 7891",
      "  SOCKSProxy : 127.0.0.1",
      "}",
    ].join("\n");
    assert.deepInclude(parseScutilProxy(clash), {
      HTTPS_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://127.0.0.1:7891",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
    assert.equal(
      parseScutilProxy(
        "<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 1080\n  SOCKSProxy : 10.0.0.2\n}",
      ).HTTPS_PROXY,
      "socks5://10.0.0.2:1080",
    );
    assert.deepEqual(
      parseScutilProxy(
        "<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}",
      ),
      {},
    );
  });

  it("lists install locations per platform", function () {
    const linux = listAgyBinaryCandidates({
      platform: "linux",
      home: "/home/max",
    });
    assert.equal(linux[0], "/home/max/.local/bin/agy");
    assert.include(linux, "/usr/local/bin/agy");
    assert.include(
      listAgyBinaryCandidates({ platform: "macos", home: "/Users/max" }),
      "/opt/homebrew/bin/agy",
    );
    assert.isTrue(
      listAgyBinaryCandidates({
        platform: "windows",
        home: "C:\\Users\\max",
      }).every((path) => path.endsWith("agy.exe")),
    );
  });

  it("parses agy models output in its JSON shapes", function () {
    const ids = (raw: string) => parseAgyModelList(raw).map((m) => m.id);
    assert.deepEqual(ids('["a","b","a"]'), ["a", "b"]);
    assert.deepEqual(
      parseAgyModelList(
        '{"models":[{"slug":"x","display_name":"X One"},{"id":"y"},{"name":"z"}]}',
      ),
      [
        { id: "x", label: "X One" },
        { id: "y", label: "y" },
        { id: "z", label: "z" },
      ],
    );
    assert.deepEqual(ids('{"slug":"p"}\n{"slug":"q"}\n'), ["p", "q"]);
    assert.deepEqual(parseAgyModelList("not json"), []);
  });

  it("reads the plain agy models table agy 1.4.2 prints", function () {
    assert.deepEqual(
      parseAgyModelList(
        [
          "gemini-4-argon-medium     Gemini 4 Argon (Medium)",
          "gemini-3.8-flash-high     Gemini 3.8 Flash (High)",
          "claude-opus-5-5-low       Claude Opus 5.5 (Low)",
          "gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
        ].join("\n"),
      ),
      [
        { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
        { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
        { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
        { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
      ],
    );
  });

  it("keeps only slug-shaped lines from other plain listings", function () {
    assert.deepEqual(
      parseAgyModelList(
        [
          "Available models:",
          "  MODEL                 NAME",
          "\u001b[1m* claude-sonnet-5-5     Claude Sonnet 5.5 (current)\u001b[0m",
          "  - gemini-3.5-pro (High)",
          "  2) gemini-3-flash, Gemini 3 Flash",
          "Run agy --model <slug> to choose one.",
        ].join("\n"),
      ).map((model) => model.id),
      ["claude-sonnet-5-5", "gemini-3.5-pro", "gemini-3-flash"],
    );
  });
});

describe("Antigravity model menu", function () {
  afterEach(function () {
    resetAntigravityModelCatalogForTests();
  });

  it("offers the CLI default first and keeps a saved model the catalog dropped", function () {
    const entries = buildAntigravityRuntimeModelEntries({
      models: [
        { id: "gemini-a", label: "Gemini A" },
        { id: "gemini-b", label: "Gemini B" },
      ],
      selectedModel: "gemini-old",
    });
    assert.deepEqual(
      entries.map((entry) => entry.model),
      [ANTIGRAVITY_DEFAULT_MODEL_ID, "gemini-old", "gemini-a", "gemini-b"],
    );
    assert.equal(entries[2]!.displayModelLabel, "Gemini A");
    assert.isTrue(
      entries.every((entry) => entry.providerLabel === "Antigravity"),
    );
    assert.isTrue(entries.every((entry) => entry.apiBase.length > 0));
    assert.equal(
      selectAntigravityRuntimeEntry(entries, "").model,
      ANTIGRAVITY_DEFAULT_MODEL_ID,
    );
    assert.equal(
      selectAntigravityRuntimeEntry(entries, "gemini-b").model,
      "gemini-b",
    );
    assert.equal(toAntigravityModelPref(ANTIGRAVITY_DEFAULT_MODEL_ID), "");
    assert.equal(toAntigravityModelPref("gemini-a"), "gemini-a");
  });

  it("caches the model list and keeps the last one on failure", async function () {
    let calls = 0;
    const ok = async () => {
      calls += 1;
      return [{ id: "m1", label: "M1" }];
    };
    assert.deepEqual(
      (await loadAntigravityModelCatalog("", { list: ok })).map((m) => m.id),
      ["m1"],
    );
    assert.deepEqual(
      (await loadAntigravityModelCatalog("", { list: ok })).map((m) => m.id),
      ["m1"],
    );
    assert.equal(calls, 1);
    const failing = async (): Promise<Array<{ id: string; label: string }>> => {
      throw new Error("agy not found");
    };
    assert.deepEqual(
      (
        await loadAntigravityModelCatalog("", { force: true, list: failing })
      ).map((m) => m.id),
      ["m1"],
    );
    const snapshot = getAntigravityModelCatalogSnapshot();
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.error, "agy not found");
    assert.deepEqual(snapshot.models, [{ id: "m1", label: "M1" }]);
  });
});
