import type { ActionRequestContext } from "../../agent/actions";
import {
  resolvePaperScopedCommandInput,
  type PaperScopedActionCollectionCandidate,
  type PaperScopedActionProfile,
} from "../../agent/actions";

export type AutoTagCollectionCandidate = PaperScopedActionCollectionCandidate;

const AUTO_TAG_PROFILE: PaperScopedActionProfile = {
  targetMode: "multi",
  allowedScopes: ["current", "selection", "collection", "all"],
  defaultEmptyInput: "selection_or_prompt",
  paperRequirement: "pdf_backed",
  supportsLimit: true,
  scopePromptOptions: {
    first: {
      label: "First 20 papers",
      input: { scope: "all", limit: 20 },
    },
    all: {
      label: "Whole library",
      input: { scope: "all" },
    },
  },
};

export function resolveAutoTagCommandInput(
  params: string,
  requestContext: ActionRequestContext | undefined,
  collections: AutoTagCollectionCandidate[],
) {
  return resolvePaperScopedCommandInput(
    params,
    requestContext,
    AUTO_TAG_PROFILE,
    collections,
  );
}
