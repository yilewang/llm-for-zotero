export type SkillRouterSemanticCase = Readonly<{
  id: string;
  language: "en" | "zh" | "ja" | "ko" | "es" | "fr";
  text: string;
  context: "none" | "single-paper" | "paper-set" | "library-corpus";
  expectedSkillIds: readonly string[];
}>;

export const SKILL_ROUTER_SEMANTIC_CORPUS: readonly SkillRouterSemanticCase[] =
  [
    {
      id: "en-compare",
      language: "en",
      text: "Compare the methods in these two papers.",
      context: "paper-set",
      expectedSkillIds: ["compare-papers"],
    },
    {
      id: "en-negative",
      language: "en",
      text: "Compare the local and long-range mechanisms in this paper.",
      context: "single-paper",
      expectedSkillIds: ["simple-paper-qa"],
    },
    {
      id: "zh-compare",
      language: "zh",
      text: "比较这两篇论文的方法和结果。",
      context: "paper-set",
      expectedSkillIds: ["compare-papers"],
    },
    {
      id: "zh-note",
      language: "zh",
      text: "为这篇论文写一篇阅读笔记。",
      context: "single-paper",
      expectedSkillIds: ["write-note"],
    },
    {
      id: "ja-figure",
      language: "ja",
      text: "この論文の図3を説明してください。",
      context: "single-paper",
      expectedSkillIds: ["analyze-figures"],
    },
    {
      id: "ja-negative",
      language: "ja",
      text: "この論文の主張は何ですか。",
      context: "single-paper",
      expectedSkillIds: ["simple-paper-qa"],
    },
    {
      id: "ko-review",
      language: "ko",
      text: "선택한 논문들로 문헌 검토를 작성해 주세요.",
      context: "paper-set",
      expectedSkillIds: ["literature-review"],
    },
    {
      id: "ko-evidence",
      language: "ko",
      text: "이 논문에서 이 주장을 뒷받침하는 구절을 찾아 주세요.",
      context: "single-paper",
      expectedSkillIds: ["evidence-based-qa"],
    },
    {
      id: "es-library",
      language: "es",
      text: "Analiza las tendencias de toda mi biblioteca.",
      context: "library-corpus",
      expectedSkillIds: ["library-analysis"],
    },
    {
      id: "es-negative",
      language: "es",
      text: "Cambia la etiqueta del artículo seleccionado.",
      context: "single-paper",
      expectedSkillIds: [],
    },
    {
      id: "fr-compare",
      language: "fr",
      text: "Compare les résultats de ces deux articles.",
      context: "paper-set",
      expectedSkillIds: ["compare-papers"],
    },
    {
      id: "fr-evidence",
      language: "fr",
      text: "Trouve le passage exact qui soutient cette affirmation dans cet article.",
      context: "single-paper",
      expectedSkillIds: ["evidence-based-qa"],
    },
  ];
