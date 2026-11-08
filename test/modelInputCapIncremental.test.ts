import { assert } from "chai";
import {
  applyModelInputTokenCap,
  estimateConversationTokens,
  modelInputCapInternalsForTests as internals,
  resolveModelInputTokenLimit,
  type InputCapMessage,
} from "../src/utils/modelInputCap";

/**
 * Frozen copy of applyModelInputTokenCap as it stood before the incremental
 * estimate: it re-estimates the whole conversation after every change. The
 * current implementation must return exactly the same result.
 */
function legacyApplyModelInputTokenCap(
  messages: InputCapMessage[],
  modelName: string,
  inputTokenCapOverride?: number,
) {
  const resolvedLimit = resolveModelInputTokenLimit(
    modelName,
    inputTokenCapOverride,
  );
  const limitTokens = resolvedLimit.limitTokens;
  const softLimitTokens = Math.max(1, Math.floor(limitTokens * 0.9));
  let working = internals.cloneMessages(messages);
  const estimatedBeforeTokens = estimateConversationTokens(working);
  let estimatedAfterTokens = estimatedBeforeTokens;
  const effects = {
    documentContextTrimmed: false,
    documentContextDropped: false,
    promptTrimmed: false,
    historyDropped: false,
  };
  if (estimatedAfterTokens <= softLimitTokens) {
    return {
      messages: working,
      capped: false,
      limitTokens,
      limitSource: resolvedLimit.source,
      softLimitTokens,
      estimatedBeforeTokens,
      estimatedAfterTokens,
      effects,
    };
  }
  let lastUserIndex = internals.findLastUserIndex(working);
  for (
    let i = 0;
    i < working.length && estimatedAfterTokens > softLimitTokens;
  ) {
    if (i === lastUserIndex || working[i].role === "system") {
      i++;
      continue;
    }
    working.splice(i, 1);
    effects.historyDropped = true;
    if (lastUserIndex >= 0 && i < lastUserIndex) lastUserIndex -= 1;
    estimatedAfterTokens = estimateConversationTokens(working);
  }
  let contextTrimGuard = 0;
  while (estimatedAfterTokens > softLimitTokens && contextTrimGuard < 24) {
    contextTrimGuard += 1;
    const contextIndex = internals.findContextMessageIndex(working);
    if (contextIndex < 0) break;
    const overflow = estimatedAfterTokens - softLimitTokens;
    const changed = internals.trimContextMessage(
      working[contextIndex],
      overflow,
    );
    if (!changed) {
      working.splice(contextIndex, 1);
      effects.documentContextDropped = true;
      if (lastUserIndex >= 0 && contextIndex < lastUserIndex) {
        lastUserIndex -= 1;
      }
    } else {
      effects.documentContextTrimmed = true;
    }
    estimatedAfterTokens = estimateConversationTokens(working);
  }
  let userTrimGuard = 0;
  while (
    estimatedAfterTokens > softLimitTokens &&
    lastUserIndex >= 0 &&
    userTrimGuard < 32
  ) {
    userTrimGuard += 1;
    const overflow = estimatedAfterTokens - softLimitTokens;
    const changed = internals.trimUserMessage(working[lastUserIndex], overflow);
    if (!changed) break;
    effects.promptTrimmed = true;
    estimatedAfterTokens = estimateConversationTokens(working);
  }
  if (estimatedAfterTokens > softLimitTokens) {
    const fallbackLength = internals.buildFallbackMessages(
      working,
      lastUserIndex,
    ).length;
    if (fallbackLength < working.length) effects.historyDropped = true;
    working = internals.buildFallbackMessages(working, lastUserIndex);
    estimatedAfterTokens = estimateConversationTokens(working);
    const fallbackUserIndex = internals.findLastUserIndex(working);
    let fallbackGuard = 0;
    while (
      estimatedAfterTokens > softLimitTokens &&
      fallbackUserIndex >= 0 &&
      fallbackGuard < 32
    ) {
      fallbackGuard += 1;
      const overflow = estimatedAfterTokens - softLimitTokens;
      const changed = internals.trimUserMessage(
        working[fallbackUserIndex],
        overflow,
      );
      if (!changed) break;
      effects.promptTrimmed = true;
      estimatedAfterTokens = estimateConversationTokens(working);
    }
  }
  return {
    messages: working,
    capped: true,
    limitTokens,
    limitSource: resolvedLimit.source,
    softLimitTokens,
    estimatedBeforeTokens,
    estimatedAfterTokens,
    effects,
  };
}

const ENGLISH =
  "The population response was low-dimensional with most variance explained. ";
const CJK = "群体反应是低维的，大部分方差由前几个成分解释。";

function text(size: number, seed: number): string {
  const unit = seed % 3 === 0 ? CJK : ENGLISH;
  return unit.repeat(Math.max(1, Math.ceil(size / unit.length))).slice(0, size);
}

function conversation(
  count: number,
  size: (index: number) => number,
): InputCapMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: text(size(index), index),
  }));
}

type Shape = {
  name: string;
  messages: InputCapMessage[];
  cap?: number;
};

const shapes: Shape[] = [
  {
    name: "under the limit",
    messages: conversation(10, () => 400),
    cap: 20_000,
  },
  {
    name: "200 uniform 4KB messages, model limit",
    messages: conversation(200, () => 4_000),
  },
  {
    name: "200 uniform 4KB messages, 20k cap",
    messages: conversation(200, () => 4_000),
    cap: 20_000,
  },
  {
    name: "mixed sizes with CJK",
    messages: conversation(120, (index) => 200 + ((index * 7919) % 9_000)),
    cap: 15_000,
  },
  {
    name: "system prompt, document context, and image parts",
    messages: [
      { role: "system", content: "You are helpful. ".repeat(50) },
      { role: "system", content: `Document Context:\n${text(60_000, 1)}` },
      ...conversation(40, () => 3_000),
      {
        role: "user",
        content: [
          { type: "text", text: text(2_000, 2) },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,BB" } },
        ],
      },
    ],
    cap: 4_000,
  },
  {
    name: "huge last user prompt forces prompt trim",
    messages: [
      ...conversation(6, () => 1_000),
      { role: "user", content: text(200_000, 4) },
    ],
    cap: 3_000,
  },
  {
    name: "document context trimmed to its floor, then dropped",
    messages: [
      { role: "system", content: text(12_000, 5) },
      { role: "system", content: `Document Context:\n${text(20_000, 1)}` },
      ...conversation(9, () => 800),
    ],
    cap: 2_000,
  },
  {
    name: "unshrinkable system prompt forces the fallback path",
    messages: [
      { role: "system", content: text(30_000, 5) },
      ...conversation(5, () => 500),
      { role: "assistant", content: text(500, 7) },
    ],
    cap: 2_000,
  },
];

describe("applyModelInputTokenCap incremental estimate", function () {
  // The reference algorithm re-estimates every message on each trim, which
  // takes about a second on the large shapes and longer when the parallel
  // run shares the CPU.
  this.timeout(10_000);

  for (const shape of shapes) {
    it(`matches the full re-estimate algorithm: ${shape.name}`, function () {
      const expected = legacyApplyModelInputTokenCap(
        shape.messages,
        "gpt-4o",
        shape.cap,
      );
      const actual = applyModelInputTokenCap(
        shape.messages,
        "gpt-4o",
        shape.cap,
      );
      assert.deepEqual(actual, expected);
      assert.equal(
        actual.estimatedAfterTokens,
        estimateConversationTokens(actual.messages),
      );
    });
  }
});
