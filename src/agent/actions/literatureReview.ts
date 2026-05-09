import type {
  AgentAction,
  ActionExecutionContext,
  ActionResult,
} from "./types";

type LiteratureReviewInput = Record<string, never>;
type LiteratureReviewOutput = Record<string, never>;

/**
 * Placeholder action for the literature review workflow.
 * The UI layer handles prompt injection and agent-mode activation;
 * full agent-driven execution will be implemented later.
 */
export const literatureReviewAction: AgentAction<
  LiteratureReviewInput,
  LiteratureReviewOutput
> = {
  name: "literature_review",
  modes: ["library"],
  description: "Launch a literature review workflow.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },

  async execute(
    _input: LiteratureReviewInput,
    _ctx: ActionExecutionContext,
  ): Promise<ActionResult<LiteratureReviewOutput>> {
    return { ok: true, output: {} };
  },
};
