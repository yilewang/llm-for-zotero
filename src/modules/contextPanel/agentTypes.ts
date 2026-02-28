export type AgentPlannerAction =
  | "skip"
  | "active-paper"
  | "existing-paper-contexts"
  | "library-overview"
  | "library-search";

export type AgentQueryPlan = {
  action: AgentPlannerAction;
  searchQuery?: string;
  maxPapersToRead: number;
  traceLines: string[];
};
