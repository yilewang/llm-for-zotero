import { assert } from "chai";
import { callLLMStream } from "../src/utils/llmClient";

/**
 * Inline reasoning tags in the content stream.
 *
 * llama.cpp and vLLM without a reasoning parser pass the model's raw template
 * output straight through, so `<think>…</think>` arrives inside `content`
 * rather than in a dedicated field.
 */
describe("inline reasoning tag parsing", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  /** Build an SSE stream whose content deltas are the given strings. */
  function contentStream(parts: string[]): ReadableStream<Uint8Array> {
    return sseStream([
      ...parts.map(
        (part) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`,
      ),
      "data: [DONE]\n\n",
    ]);
  }

  function mockFetch(body: () => ReadableStream<Uint8Array>) {
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) =>
        name === "fetch"
          ? async () => ({
              ok: true,
              status: 200,
              statusText: "OK",
              body: body(),
              json: async () => ({}),
              text: async () => "",
            })
          : undefined,
      log: () => undefined,
    };
  }

  async function run(parts: string[]) {
    const reasoning: string[] = [];
    mockFetch(() => contentStream(parts));
    const answer = await callLLMStream(
      {
        prompt: "x",
        model: "qwen3-14b",
        apiBase: "http://localhost:8080/v1",
        providerProtocol: "openai_chat_compat",
      },
      () => undefined,
      (event) => reasoning.push(event.details || ""),
    );
    return { answer, reasoning: reasoning.join("") };
  }

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  for (const tag of ["thought", "think", "reasoning"]) {
    it(`routes <${tag}> content to reasoning, not the answer`, async function () {
      const { answer, reasoning } = await run([
        `<${tag}>weighing options</${tag}>The answer is 4.`,
      ]);
      assert.equal(answer, "The answer is 4.");
      assert.equal(reasoning, "weighing options");
    });
  }

  it("handles a tag split across stream chunks", async function () {
    const { answer, reasoning } = await run([
      "<thi",
      "nk>plan</thi",
      "nk>done",
    ]);
    assert.equal(answer, "done");
    assert.equal(reasoning, "plan");
  });

  it("strips a leaked block that opens after only whitespace", async function () {
    // Chat templates emit `<think>\n…\n</think>\n\n`, so leading newlines are
    // part of the leak, not answer text.
    const { answer, reasoning } = await run([
      "\n\n<think>plan</think>\n\ndone",
    ]);
    assert.equal(answer.trim(), "done");
    assert.equal(reasoning, "plan");
  });

  it("does not let a mismatched closing tag end the block early", async function () {
    const { answer, reasoning } = await run([
      "<thought>a</think>still thinking</thought>answer",
    ]);
    assert.equal(answer, "answer");
    assert.equal(reasoning, "a</think>still thinking");
  });

  it("keeps an unterminated block as reasoning", async function () {
    // Reasoning is emitted as it arrives so the Thinking panel stays live,
    // which means an unterminated block cannot be reclassified afterwards
    // without showing the same text twice. Documented, not accidental.
    const { answer, reasoning } = await run([
      "<think>the whole response, never closed",
    ]);
    assert.equal(answer, "");
    assert.equal(reasoning, "the whole response, never closed");
  });

  it("leaves ordinary content with angle brackets alone", async function () {
    const { answer } = await run(["use <div> and <thinking-cap> markup"]);
    assert.equal(answer, "use <div> and <thinking-cap> markup");
  });

  /**
   * A leaked reasoning block always OPENS the assistant message — that is how
   * the chat template is built. A model that merely writes about the tag does
   * so after it has started answering. Position is therefore the one signal
   * that separates leakage from prose, and without it a question like "how do
   * I stop my model emitting <think> blocks?" loses its own answer.
   */
  describe("a tag written inside an answer is content, not reasoning", function () {
    for (const tag of ["thought", "think", "reasoning"]) {
      it(`keeps a <${tag}> mention that follows answer text`, async function () {
        const { answer, reasoning } = await run([
          `Set think: false to hide the <${tag}> block.`,
        ]);
        assert.equal(answer, `Set think: false to hide the <${tag}> block.`);
        assert.equal(reasoning, "");
      });
    }

    it("keeps a paired mention and the words between it", async function () {
      const { answer, reasoning } = await run([
        "before <think>mid</think> after",
      ]);
      assert.equal(answer, "before <think>mid</think> after");
      assert.equal(reasoning, "");
    });

    it("keeps an unclosed mention that follows answer text", async function () {
      // The failure this guards: everything after the mention used to vanish
      // from the chat bubble into the Thinking panel.
      const { answer, reasoning } = await run([
        "Here is the answer.<think>afterthought",
      ]);
      assert.equal(answer, "Here is the answer.<think>afterthought");
      assert.equal(reasoning, "");
    });

    it("keeps a mention split across stream chunks", async function () {
      const { answer, reasoning } = await run(["Answer. <thi", "nk> literal"]);
      assert.equal(answer, "Answer. <think> literal");
      assert.equal(reasoning, "");
    });

    it("keeps a mention inside a fenced code block", async function () {
      const source = "Strip it with:\n\n```\n<think>.*?</think>\n```\n";
      const { answer } = await run([source]);
      assert.equal(answer, source);
    });

    it("keeps a second mention after a genuine leaked block", async function () {
      const { answer, reasoning } = await run([
        "<think>plan</think>Remove the <think> prefix yourself.",
      ]);
      assert.equal(answer, "Remove the <think> prefix yourself.");
      assert.equal(reasoning, "plan");
    });
  });
});
