/**
 * Shared fixtures for the section picker tests (sectionPicker.ts): synthetic
 * papers in Chinese and English, a plain PDF without headings, and a fake
 * reader that answers the picker prompt apart from any other prompt. All
 * text is invented.
 */
import type { ReaderAdapterFactories } from "../../src/agent/reader/resolveReader";
import { SECTION_PICK_TASK_LINE } from "../../src/agent/digests/sectionPicker";
import type { PdfContext } from "../../src/services/paperContent/types";

export const QUESTION =
  "帮我读所有这个文件夹里的文献的结果部分，然后告诉我他们的结果有什么异同";

export const CHINESE_RESULTS =
  "解码准确率在每一天都高于随机水平，而且群体向量的漂移速度保持稳定。";
export const CHINESE_DISCUSSION =
  "漂移与稳定的解码可以共存，这与以往关于海马体的研究结论一致。";
export const CHINESE_METHODS = "我们在十天内用双光子成像记录了四十个位置细胞。";

export const CHINESE_MD = [
  "# 海马位置细胞的表征漂移",
  "",
  "## 摘要",
  "",
  "本文研究表征漂移是否影响位置解码。",
  "",
  "## 一、引言",
  "",
  "位置细胞在数天内缓慢漂移。",
  "",
  "## 二、方法",
  "",
  CHINESE_METHODS,
  "",
  "## 三、结果与讨论",
  "",
  CHINESE_RESULTS,
  "",
  CHINESE_DISCUSSION,
  "",
  "## 四、结论",
  "",
  "表征漂移并不妨碍位置解码。",
  "",
  "## 参考文献",
  "",
  "[1] Author A. An invented study of drift. 2013.",
].join("\n");

export const COMBINED_RESULTS =
  "Decoding stayed above chance on every recorded day across forty cells.";
export const COMBINED_DISCUSSION =
  "Drift and stable decoding can coexist, as earlier hippocampal work suggested.";

export const COMBINED_MD = [
  "# Drift in place cells",
  "",
  "## Abstract",
  "",
  "We ask whether representational drift impairs decoding of position.",
  "",
  "## 1 Introduction",
  "",
  "Place cells drift slowly across days.",
  "",
  "## 2 Methods",
  "",
  "We recorded forty cells over ten days.",
  "",
  "## 3 Results and Discussion",
  "",
  COMBINED_RESULTS,
  "",
  COMBINED_DISCUSSION,
  "",
  "## 4 Conclusion",
  "",
  "Drift does not impair decoding.",
].join("\n");

export const SPREAD_A =
  "Population vectors rotated by a fixed angle per day in every mouse.";
export const SPREAD_B =
  "A decoder trained on day one still read position on day ten above chance.";

export const SPREAD_MD = [
  "# Drift and decoding",
  "",
  "## Abstract",
  "",
  "Drift is slow and decoding survives it.",
  "",
  "## 1 Introduction",
  "",
  "Place cells drift.",
  "",
  "## 2 Methods",
  "",
  "We imaged CA1 for ten days.",
  "",
  "## 3 Population vectors drift at a fixed rate",
  "",
  SPREAD_A,
  "",
  "## 4 Decoding survives the drift",
  "",
  SPREAD_B,
  "",
  "## 5 Discussion",
  "",
  "Slow drift leaves room for stable readout.",
].join("\n");

export const REVIEW_ABSTRACT =
  "We review twenty years of work on representational drift in the hippocampus.";

export const REVIEW_MD = [
  "# Representational drift: a review",
  "",
  "## Abstract",
  "",
  REVIEW_ABSTRACT,
  "",
  "## 1 Introduction",
  "",
  "Drift was first reported in CA1.",
  "",
  "## 2 Studies of drift across brain areas",
  "",
  "Studies in cortex and hippocampus report drift at different rates.",
  "",
  "## 3 Open questions",
  "",
  "Whether drift serves a function is not known.",
  "",
  "## References",
  "",
  "[1] Ziv Y. 2013.",
].join("\n");

export const SHORT_RESULTS = "解码准确率在十天内保持高于随机水平。";
export const SHORT_METHODS = "我们用双光子成像记录了细胞。";

/** A Chinese paper headed with two-character section names. */
export const SHORT_HEADINGS_MD = [
  "# 表征漂移与位置解码",
  "",
  "## 摘要",
  "",
  "本文研究漂移与解码。",
  "",
  "## 方法",
  "",
  SHORT_METHODS,
  "",
  "## 结果",
  "",
  SHORT_RESULTS,
  "",
  "## 讨论",
  "",
  "漂移与稳定解码可以共存。",
].join("\n");

export const PREAMBLE_ABSTRACT =
  "摘要：本文研究表征漂移是否影响海马位置细胞对位置的解码，并给出十天记录的结果。";

/** No heading before the introduction: the abstract is an unheaded lead. */
export const PREAMBLE_MD = [
  "表征漂移与位置解码",
  "",
  PREAMBLE_ABSTRACT,
  "",
  "## 一、引言",
  "",
  "位置细胞在数天内缓慢漂移。",
  "",
  "## 二、结果",
  "",
  SHORT_RESULTS,
].join("\n");

/** The abstract under the title heading, before the first section. */
export const TITLED_PREAMBLE_MD = [
  "# 表征漂移与位置解码",
  "",
  PREAMBLE_ABSTRACT,
  "",
  "## 一、引言",
  "",
  "位置细胞在数天内缓慢漂移。",
  "",
  "## 二、结果",
  "",
  SHORT_RESULTS,
].join("\n");

/** Plain PDF text with no headings: five chunks. */
export const PLAIN_CHUNKS = [
  "Representational drift in hippocampal place cells, by A. Author.",
  "Place cells were long thought to keep a stable map of space.",
  "Across ten days the population vector rotated by a fixed angle per day.",
  "A decoder trained on the first day still read position on the last day.",
  "Slow drift may leave room for a stable readout downstream.",
];

/** One chunk per page; chunk metadata holds 0-based page indexes. */
export const PLAIN_CONTEXT = {
  title: "Plain PDF",
  chunks: PLAIN_CHUNKS,
  chunkMeta: PLAIN_CHUNKS.map((text, chunkIndex) => ({
    chunkIndex,
    text,
    normalizedText: text,
    chunkKind: "body",
    pageStart: chunkIndex,
    pageEnd: chunkIndex,
    sourceFingerprint: "pdf-fingerprint-5",
  })),
  chunkStats: [],
  docFreq: {},
  avgChunkLength: 60,
  fullLength: PLAIN_CHUNKS.join("\n").length,
} as unknown as PdfContext;

/** The outline id of the line that holds `heading` in a picker prompt. */
export function idOf(prompt: string, heading: string): string {
  const line = prompt
    .split("\n")
    .find((entry) => /^[sp]\d+ \|/.test(entry) && entry.includes(heading));
  const id = line ? /^([sp]\d+)\b/.exec(line)?.[1] : undefined;
  if (!id) throw new Error(`no outline line for ${heading}`);
  return id;
}

/** The requested names a picker prompt lists, in order. */
export function namesOf(prompt: string): string[] {
  const line = prompt
    .split("\n")
    .find((entry) => entry.startsWith("Parts asked for"));
  return [...(line || "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

export type FakeReader = {
  pickPrompts: string[];
  digestPrompts: string[];
  factories: ReaderAdapterFactories;
};

/** A reader that answers the picker by `pick` and every digest the same. */
export function fakeReader(pick: (prompt: string) => unknown): FakeReader {
  const reader: FakeReader = {
    pickPrompts: [],
    digestPrompts: [],
    factories: {},
  };
  const complete = () => async (prompt: string) => {
    if (prompt.includes(SECTION_PICK_TASK_LINE)) {
      reader.pickPrompts.push(prompt);
      return { text: JSON.stringify(pick(prompt)) };
    }
    reader.digestPrompts.push(prompt);
    return {
      text: JSON.stringify({ answer: "The paper's results, read in full." }),
    };
  };
  reader.factories = {
    turnModel: complete,
    codexResponses: complete,
    claudeBridge: complete,
  };
  return reader;
}

/** An outline line's text the stand-in reader matches: a heading or a chunk's first line. */
function outlineLineText(line: string): string {
  const fields = line.split(" | ");
  return (line.startsWith("c") ? fields[fields.length - 1] : fields[1]) || "";
}

/**
 * A stand-in reader for English fixtures: per name, the outline lines whose
 * heading (or, for a plain PDF, whose first line) holds the name's word
 * ("Results" for "results"), else none. Only what a reader would pick in
 * the obvious case; a test of anything else scripts its own pick.
 */
export function headingMatchReader(): FakeReader {
  return fakeReader((prompt) => ({
    parts: namesOf(prompt).map((name) => {
      const stem = name.toLowerCase().replace(/s$/, "");
      const ids = prompt
        .split("\n")
        .filter((line) => /^[spc]\d+ \|/.test(line))
        .filter((line) => outlineLineText(line).toLowerCase().includes(stem))
        .map((line) => line.split(" | ")[0]);
      return ids.length ? { name, sections: ids } : { name, none: true };
    }),
  }));
}
