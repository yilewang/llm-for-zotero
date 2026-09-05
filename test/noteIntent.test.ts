import { assert } from "chai";
import {
  inferExplicitNoteIntent,
  inferNoteIntent,
} from "../src/agent/skills/noteIntent";
import { resolveSkillRouting as resolveSkillRoutingResolved } from "../src/agent/skills/routing";
import type { AgentRuntimeRequestInput } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function resolveSkillRouting(
  input: AgentRuntimeRequestInput,
  ...args: Tail<Parameters<typeof resolveSkillRoutingResolved>>
): ReturnType<typeof resolveSkillRoutingResolved> {
  return resolveSkillRoutingResolved(
    resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      ...input,
    }),
    ...args,
  );
}

type Tail<T extends readonly unknown[]> = T extends readonly [
  unknown,
  ...infer R,
]
  ? R
  : never;
import type { AgentSkill } from "../src/agent/skills/skillLoader";

function makeSkill(id: string, pattern: RegExp): AgentSkill {
  return {
    id,
    description: `${id} description`,
    version: 1,
    patterns: [pattern],
    contexts: ["any"],
    activation: "auto",
    instruction: `${id} instruction`,
    source: "system",
  };
}

describe("inferNoteIntent (multilingual)", function () {
  const positives: Array<[string, string]> = [
    ["English", "write a reading note for this paper"],
    ["English save-as", "save this as my notes"],
    ["Chinese", "为这篇论文写阅读笔记"],
    ["Chinese save", "把总结保存到笔记里"],
    ["Japanese", "この論文のノートを作成してください"],
    ["Korean", "이 논문 노트를 작성해줘"],
    ["Spanish", "crear una nota para este artículo"],
    ["French", "écrire une note sur cet article"],
    ["German", "schreiben Sie eine Notiz zu diesem Paper"],
    ["Russian", "написать заметку об этой статье"],
  ];
  for (const [label, text] of positives) {
    it(`detects note intent: ${label}`, function () {
      assert.isTrue(inferNoteIntent({ userText: text }), text);
    });
  }

  const negatives: Array<[string, string]> = [
    ["English summary", "summarize this paper"],
    ["English noun mention", "what did the authors note about accuracy"],
    ["Chinese summary", "总结这篇论文的主要发现"],
    ["Japanese question", "この論文の主な結論は何ですか"],
    ["Korean laptop", "노트북에 저장해줘"],
    ["Japanese laptop", "グラフをノートパソコンに保存して"],
    ["Chinese laptop", "把文件保存到笔记本电脑"],
    ["Japanese memory", "メモリ使用量を保存して分析して"],
    ["Arabic without-a-note", "لخص هذه الورقة بدون ملاحظة"],
    ["French describe", "Décris cette figure"],
    ["Empty", ""],
  ];
  for (const [label, text] of negatives) {
    it(`ignores non-note request: ${label}`, function () {
      assert.isFalse(inferNoteIntent({ userText: text }), text);
    });
  }

  it("uses note context to accept weaker phrasings", function () {
    assert.isTrue(
      inferNoteIntent({
        userText: "添加一段关于方法的讨论",
        activeNoteContext: {
          noteId: 7,
          title: "Reading note",
          noteKind: "standalone",
          noteText: "",
        },
      }),
    );
  });

  it("keeps unanchored stems from firing even with a note open", function () {
    // écri must not match inside "décris"; the weak branch needs a real
    // action verb.
    assert.isFalse(
      inferNoteIntent({
        userText: "Décris cette figure",
        activeNoteContext: {
          noteId: 7,
          title: "Reading note",
          noteKind: "standalone",
          noteText: "",
        },
      }),
    );
  });
});

describe("inferExplicitNoteIntent (strong text-only signal)", function () {
  it("accepts explicit note requests", function () {
    assert.isTrue(inferExplicitNoteIntent("为这篇论文写阅读笔记"));
    assert.isTrue(inferExplicitNoteIntent("save this as my notes"));
  });

  it("rejects weak open-note phrasings that need context", function () {
    // The strong signal never fires on a bare action verb — that branch is
    // reserved for inferNoteIntent's context-aware consumers.
    assert.isFalse(inferExplicitNoteIntent("add this paper to my collection"));
    assert.isFalse(inferExplicitNoteIntent("添加一段关于方法的讨论"));
  });
});

describe("note-intent skill routing force", function () {
  it("forces write-note for non-English note requests even without pattern matches", function () {
    // English-only patterns simulate the pre-v8 shipped regexes (and any
    // user-customized pattern set): the deterministic force must still
    // activate the skill.
    const writeNote = makeSkill("write-note", /\bnote\b.*\bpaper\b/i);
    const other = makeSkill("simple-paper-qa", /\bsummarize\b/i);

    const resolution = resolveSkillRouting(
      { userText: "为这篇论文写阅读笔记" },
      [writeNote, other],
    );

    assert.include(resolution.matchedSkillIds, "write-note");
    assert.include(resolution.contextForcedSkillIds, "write-note");
    assert.notInclude(resolution.matchedSkillIds, "simple-paper-qa");
  });

  it("does not force write-note for non-note requests", function () {
    const writeNote = makeSkill("write-note", /\bnote\b.*\bpaper\b/i);

    const resolution = resolveSkillRouting(
      { userText: "总结这篇论文的主要发现" },
      [writeNote],
    );

    assert.notInclude(resolution.matchedSkillIds, "write-note");
    assert.notInclude(resolution.contextForcedSkillIds, "write-note");
  });

  it("does not force write-note on a bare action verb with a note open", function () {
    const writeNote = makeSkill("write-note", /\bnote\b.*\bpaper\b/i);

    const resolution = resolveSkillRouting(
      {
        userText: "add this paper to my collection",
        activeNoteContext: {
          noteId: 7,
          title: "Reading note",
          noteKind: "standalone",
          noteText: "",
        },
      },
      [writeNote],
    );

    assert.notInclude(resolution.matchedSkillIds, "write-note");
    assert.notInclude(resolution.contextForcedSkillIds, "write-note");
  });
});

describe("noteIntent French conjugations", function () {
  /**
   * The file's contract is that note intent triggers "regardless of the
   * user's language or phrasing". `\benregistrer\b` only matched the
   * infinitive, so the imperative "enregistre la note" — the natural way to
   * ask — missed, and the write-note skill (and the user's customizations
   * in it) were silently skipped.
   */
  it("matches conjugated enregistrer, not just the infinitive", function () {
    assert.isTrue(inferExplicitNoteIntent("enregistre la note"));
    assert.isTrue(inferExplicitNoteIntent("enregistrer la note"));
    assert.isTrue(inferExplicitNoteIntent("enregistrez cette note"));
  });

  it("still does not fire without a note object", function () {
    assert.isFalse(inferExplicitNoteIntent("enregistre le fichier"));
  });
});
