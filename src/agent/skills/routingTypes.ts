export const SKILL_ROUTER_SCHEMA_VERSION = 1 as const;
export const SKILL_ROUTER_PROMPT_VERSION = 1 as const;
export const SKILL_ROUTER_ADAPTER_PROTOCOL_VERSION = 1 as const;

export type SkillRequestedScope =
  | "none"
  | "single-paper"
  | "paper-set"
  | "library-corpus"
  | "note"
  | "visual-input";

export type SkillRouterSelection = Readonly<{
  skillId: string;
  requestedScope: SkillRequestedScope;
  evidenceText: string;
  occurrence?: number;
}>;

export type SkillRouterResponseV1 = Readonly<{
  schemaVersion: 1;
  taskKind: "read" | "write" | "mixed";
  queryLanguage?: string;
  requestedScopes: readonly SkillRequestedScope[];
  selections: readonly SkillRouterSelection[];
  retrievalIntent: "enumerate" | "verify" | "summarize" | "none";
  deliverableIntent?: "chat" | "document" | "unspecified";
  documentKind?:
    | "research_brief"
    | "literature_review"
    | "comparison"
    | "report"
    | "guide"
    | "custom";
  paperTargetIntent?: "active" | "added" | "all_visible" | "unspecified";
  externalSearchIntent?: "none" | "web" | "literature" | "both";
  wantedSections: readonly ("methods" | "results" | "limitations")[];
}>;

export type ValidatedSkillActivation = Readonly<{
  id: string;
  source: "automatic" | "explicit";
  requestedScope: SkillRequestedScope;
  evidence?: Readonly<{ text: string; start: number; end: number }>;
  version: number;
  instructionHash: string;
}>;

export type SkillRoutingReceipt = Readonly<{
  routerSchemaVersion: number;
  routerIdentityHash: string;
  skillManifestHash: string;
  skills: readonly ValidatedSkillActivation[];
}>;

export type PlanSkillRoutingReceipt = Readonly<{
  routerSchemaVersion: number;
  skillManifestHash: string;
  skills: readonly Readonly<{
    id: string;
    version: number;
    instructionHash: string;
    source: "automatic" | "explicit";
  }>[];
}>;
