export const MAX_AGENT_ROUNDS = 6;
export const MAX_AGENT_TOOL_CALLS_PER_ROUND = 4;

export const MAX_BULK_AGENT_ROUNDS = 12;
export const MAX_BULK_TOOL_CALLS_PER_ROUND = 6;

/**
 * Returns agent loop limits scaled to whether the request is a bulk
 * library-wide operation (tagging all papers, reorganising entire library, etc).
 * Bulk operations get double the rounds so they can process larger item sets
 * without hitting the cap prematurely.
 */
export function resolveAgentLimits(isBulkOperation: boolean): {
  maxRounds: number;
  maxToolCallsPerRound: number;
} {
  if (isBulkOperation) {
    return {
      maxRounds: MAX_BULK_AGENT_ROUNDS,
      maxToolCallsPerRound: MAX_BULK_TOOL_CALLS_PER_ROUND,
    };
  }
  return {
    maxRounds: MAX_AGENT_ROUNDS,
    maxToolCallsPerRound: MAX_AGENT_TOOL_CALLS_PER_ROUND,
  };
}
