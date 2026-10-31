/**
 * Why an Original Agent run ended.
 *
 * Every ending of `AgentRuntime.runTurn` names exactly one rule. The rule is
 * recorded as an `agent_run_stop` provider event just before the run is
 * finished. It decides the run's end state (`decideRunEnd`) and whether a
 * following "continue" gets a resume note (`turnBoundary.ts`); the whole-turn
 * rules themselves are decided in `turnBoundary.ts`.
 */
export type RunStopRule =
  // A model without tool support hands the turn back for a direct response.
  | "tools_unsupported_fallback"
  // A /compact request ended the turn without a model step.
  | "manual_compaction"
  // The protected prompt stays above the input budget after compaction.
  | "prompt_budget_exceeded"
  // A tool the provider ran through its callback ended the run.
  | "provider_terminal_outcome"
  // A final answer kept hitting the output limit; the kept text ships.
  | "answer_continuation_limit"
  // Navigation found no new evidence through a checkpoint and one more
  // window; the answer was written without tools.
  | "search_exhausted"
  // A per-turn safety limit (model calls, input tokens, wall clock) was
  // reached; the work is kept and "continue" goes on.
  | "budget_reached"
  // The model could not be reached after the automatic retries; the work
  // is kept and "continue" goes on.
  | "connection_lost"
  // Incomplete model steps reached the segment's round limit.
  | "incomplete_step_limit"
  // The final-answer gate rejected the answer and allows no more corrections.
  | "final_gate_rejected"
  // The model's final answer passed the final-answer gate.
  | "final_answer"
  // A tool the model called ended the run with its terminal result.
  | "terminal_tool"
  // A tool the model called could not run or verify its action.
  | "tool_action_failed"
  // Three rounds in a row had failing tools and no successful result.
  | "repeated_tool_errors"
  // Six rounds in a row had only rejected tool inputs.
  | "repeated_input_rejections"
  // A whole segment of rounds produced no new successful tool result.
  | "segment_without_progress"
  // A long job's papers failed a page's worth in a row; it stops, resumable.
  | "page_failed"
  // The user stopped the run before its next model step was sent.
  | "cancelled_before_step"
  // The user stopped the run while a model step or tool was in flight.
  | "cancelled_in_flight"
  // A provider or runtime error escaped the loop; the run is left to recover.
  | "interrupted_by_error";
