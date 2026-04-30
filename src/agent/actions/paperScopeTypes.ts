export type PaperScopedActionTargetMode = "single" | "multi" | "single_or_multi";
export type PaperScopedActionAllowedScope =
  | "current"
  | "selection"
  | "collection"
  | "all";
export type PaperScopedActionDefaultEmptyInput =
  | "current"
  | "selection_or_prompt"
  | "prompt";
export type PaperScopedActionPaperRequirement = "bibliographic" | "pdf_backed";

export type PaperScopedActionInput = {
  itemId?: number;
  itemIds?: number[];
  collectionId?: number;
  collectionIds?: number[];
  scope?: "all" | "collection";
  limit?: number;
};

export type PaperScopedActionPromptOption = {
  label: string;
  input: PaperScopedActionInput;
};

export type PaperScopedActionProfile = {
  targetMode: PaperScopedActionTargetMode;
  allowedScopes: PaperScopedActionAllowedScope[];
  defaultEmptyInput: PaperScopedActionDefaultEmptyInput;
  paperRequirement: PaperScopedActionPaperRequirement;
  supportsLimit: boolean;
  scopePromptOptions?: {
    first?: PaperScopedActionPromptOption;
    all?: PaperScopedActionPromptOption;
  };
};

export type PaperScopedActionCollectionCandidate = {
  collectionId: number;
  name: string;
  path?: string;
};
