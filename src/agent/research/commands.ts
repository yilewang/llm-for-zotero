import { fail, ok, validateObject } from "../tools/shared";
import type { AgentToolInputValidation } from "../types";
import { RESEARCH_STAGES as STAGES, type ResearchStage } from "./policy";
import {
  normalizeRecordPaperInput,
  type NormalizedRecordPaper,
} from "./recordDecoding";
type NoPayload = {
  stage?: never;
  papers?: never;
  warnings?: never;
  probes?: never;
  themes?: never;
  outcome?: never;
  slots?: never;
  tiers?: never;
  edges?: never;
  questions?: never;
  phase?: never;
  view?: "compact" | "full";
  cursor?: number;
  limit?: number;
};
export type ResearchUpdateInput =
  | (NoPayload & {
      operation:
        | "inventory_scope"
        | "next_screen_batch"
        | "list_verified_reads"
        | "list_findings"
        | "list_themes"
        | "list_graph"
        | "next_work";
    })
  | (Omit<NoPayload, "edges"> & {
      operation: "record_edges" | "update_edges";
      edges: unknown[];
    })
  | (Omit<NoPayload, "questions"> & {
      operation: "record_questions" | "resolve_questions";
      questions: unknown[];
    })
  | (Omit<NoPayload, "phase"> & {
      operation: "advance_phase";
      phase: string;
    })
  | (Omit<NoPayload, "stage"> & {
      operation: "set_stage";
      stage: ResearchStage;
    })
  | (Omit<NoPayload, "papers" | "warnings"> & {
      operation: "record_papers";
      papers: NormalizedRecordPaper[];
      warnings: string[];
    })
  | (Omit<NoPayload, "probes"> & {
      operation: "record_probes";
      probes: unknown[];
    })
  | (Omit<NoPayload, "themes"> & {
      operation: "record_themes";
      themes: unknown[];
    })
  | (Omit<NoPayload, "outcome"> & {
      operation: "finalize";
      outcome: "complete" | "partial" | "failed";
    })
  | (Omit<NoPayload, "slots"> & {
      operation: "set_frame";
      slots: unknown[];
    })
  | (Omit<NoPayload, "tiers"> & {
      operation: "set_tiers";
      tiers: unknown[];
    });
export function validateResearchUpdate(
  args: unknown,
): AgentToolInputValidation<ResearchUpdateInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("research_update expects an object");
  }
  const operation = args.operation as ResearchUpdateInput["operation"];
  if (
    ![
      "inventory_scope",
      "next_screen_batch",
      "list_verified_reads",
      "list_findings",
      "list_themes",
      "record_papers",
      "record_probes",
      "record_themes",
      "set_stage",
      "finalize",
      "set_frame",
      "set_tiers",
      "record_edges",
      "update_edges",
      "record_questions",
      "resolve_questions",
      "advance_phase",
      "next_work",
      "list_graph",
    ].includes(String(operation))
  ) {
    return fail("research_update operation is invalid");
  }
  if (
    (operation === "record_edges" || operation === "update_edges") &&
    (!Array.isArray(args.edges) || !args.edges.length)
  ) {
    return fail(`${operation} requires edges[]`);
  }
  if (
    (operation === "record_questions" || operation === "resolve_questions") &&
    (!Array.isArray(args.questions) || !args.questions.length)
  ) {
    return fail(`${operation} requires questions[]`);
  }
  if (
    operation === "advance_phase" &&
    (typeof args.phase !== "string" || !args.phase.trim())
  ) {
    return fail("advance_phase requires phase");
  }
  if (
    args.view !== undefined &&
    args.view !== "compact" &&
    args.view !== "full"
  ) {
    return fail("view must be compact or full");
  }
  if (
    operation === "set_frame" &&
    (!Array.isArray(args.slots) || !args.slots.length)
  ) {
    return fail("set_frame requires slots[] describing the whole frame");
  }
  if (
    operation === "set_tiers" &&
    (!Array.isArray(args.tiers) || !args.tiers.length)
  ) {
    return fail("set_tiers requires tiers[] with identity and tier");
  }
  if (operation === "set_stage" && args.stage === undefined)
    return fail("set_stage requires stage");
  if (operation !== "set_stage" && args.stage !== undefined)
    return fail(
      "stage is allowed only for set_stage; records use the stored research stage",
    );
  if (
    args.stage !== undefined &&
    !STAGES.includes(args.stage as ResearchStage)
  ) {
    return fail("research_update stage is invalid");
  }
  if (
    args.cursor !== undefined &&
    (!Number.isInteger(args.cursor) || Number(args.cursor) < 0)
  ) {
    return fail("research_update cursor must be a non-negative integer");
  }
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) ||
      Number(args.limit) < 1 ||
      Number(args.limit) > 25)
  ) {
    return fail("research_update limit must be an integer from 1 to 25");
  }
  if (operation === "record_papers" && !Array.isArray(args.papers)) {
    return fail("record_papers requires papers[]");
  }
  if (
    operation === "record_papers" &&
    Array.isArray(args.papers) &&
    args.papers.length < 1
  ) {
    return fail("record_papers requires at least one paper");
  }
  if (operation === "record_probes" && !Array.isArray(args.probes)) {
    return fail("record_probes requires probes[]");
  }
  if (operation === "record_themes" && !Array.isArray(args.themes)) {
    return fail("record_themes requires themes[]");
  }
  if (
    operation === "finalize" &&
    !["complete", "partial", "failed"].includes(String(args.outcome))
  ) {
    return fail("finalize requires outcome complete, partial, or failed");
  }
  const page = {
    cursor: args.cursor === undefined ? undefined : Number(args.cursor),
    limit: args.limit === undefined ? undefined : Number(args.limit),
    ...(args.view === undefined
      ? {}
      : { view: args.view as "compact" | "full" }),
  };
  switch (operation) {
    case "set_stage":
      return ok({ ...page, operation, stage: args.stage as ResearchStage });
    case "record_papers": {
      const papers: NormalizedRecordPaper[] = [];
      const warnings: string[] = [];
      for (
        let index = 0;
        index < (args.papers as unknown[]).length;
        index += 1
      ) {
        try {
          const normalized = normalizeRecordPaperInput(
            (args.papers as unknown[])[index],
            index,
          );
          papers.push(normalized.paper);
          warnings.push(...normalized.warnings);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      }
      return ok({ ...page, operation, papers, warnings });
    }
    case "record_probes":
      return ok({ ...page, operation, probes: args.probes as unknown[] });
    case "record_themes":
      return ok({ ...page, operation, themes: args.themes as unknown[] });
    case "finalize":
      return ok({
        ...page,
        operation,
        outcome: args.outcome as "complete" | "partial" | "failed",
      });
    case "set_frame":
      return ok({ ...page, operation, slots: args.slots as unknown[] });
    case "set_tiers":
      return ok({ ...page, operation, tiers: args.tiers as unknown[] });
    case "record_edges":
    case "update_edges":
      return ok({ ...page, operation, edges: args.edges as unknown[] });
    case "record_questions":
    case "resolve_questions":
      return ok({
        ...page,
        operation,
        questions: args.questions as unknown[],
      });
    case "advance_phase":
      return ok({ ...page, operation, phase: String(args.phase).trim() });
    default:
      return ok({ ...page, operation });
  }
}
