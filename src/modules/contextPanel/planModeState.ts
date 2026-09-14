import type {
  PlanExecutionLedger,
  PlanProvider,
  PlanRuntimeContext,
} from "../../agent/plans/types";
import { loadLatestResumablePlanExecutionForConversation } from "../../agent/plans/store";

export const PLAN_APPROVED_EVENT = "llm-plan-approved";
export const PLAN_REVISE_EVENT = "llm-plan-revise";
export const PLAN_CANCEL_EVENT = "llm-plan-cancel";

type ComposePlanState = {
  enabled: boolean;
  planId: string;
  revision: number;
  provider: PlanProvider;
  submitted: boolean;
};

const composeStates = new Map<number, ComposePlanState>();
const pendingExecutions = new Map<number, PlanRuntimeContext>();

function createPlanId(conversationKey: number): string {
  return `plan-${conversationKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getComposePlanState(
  conversationKey: number,
): Readonly<ComposePlanState> | null {
  return composeStates.get(conversationKey) || null;
}

export function enableComposePlanMode(params: {
  conversationKey: number;
  provider: PlanProvider;
  planId?: string;
  revision?: number;
}): Readonly<ComposePlanState> {
  const existing = composeStates.get(params.conversationKey);
  const state: ComposePlanState = {
    enabled: true,
    planId:
      params.planId || existing?.planId || createPlanId(params.conversationKey),
    revision: params.revision || existing?.revision || 1,
    provider: params.provider,
    submitted: false,
  };
  composeStates.set(params.conversationKey, state);
  return state;
}

export function disableComposePlanMode(conversationKey: number): void {
  composeStates.delete(conversationKey);
}

export function toggleComposePlanMode(params: {
  conversationKey: number;
  provider: PlanProvider;
}): boolean {
  if (composeStates.get(params.conversationKey)?.enabled) {
    disableComposePlanMode(params.conversationKey);
    return false;
  }
  enableComposePlanMode(params);
  return true;
}

export function getPlanningRuntimeContext(
  conversationKey: number,
): PlanRuntimeContext | undefined {
  const state = composeStates.get(conversationKey);
  if (!state?.enabled) return undefined;
  state.submitted = true;
  return {
    phase: "planning",
    planId: state.planId,
    revision: state.revision,
    provider: state.provider,
  };
}

export function beginPlanRevision(params: {
  conversationKey: number;
  planId: string;
  revision: number;
  provider: PlanProvider;
}): void {
  enableComposePlanMode({
    conversationKey: params.conversationKey,
    planId: params.planId,
    revision: params.revision,
    provider: params.provider,
  });
}

export function stageApprovedPlanExecution(ledger: PlanExecutionLedger): void {
  pendingExecutions.set(ledger.conversationKey, {
    phase: "executing",
    planId: ledger.planId,
    revision: ledger.revision,
    executionId: ledger.executionId,
    approvedDigest: ledger.planDigest,
    activeTaskId: ledger.activeTaskId,
    provider: ledger.provider,
  });
  disableComposePlanMode(ledger.conversationKey);
}

export async function takePendingPlanExecution(
  conversationKey: number,
): Promise<PlanRuntimeContext | undefined> {
  const context = pendingExecutions.get(conversationKey);
  if (context) pendingExecutions.delete(conversationKey);
  if (context) return context;
  const ledger =
    await loadLatestResumablePlanExecutionForConversation(conversationKey);
  if (!ledger) return undefined;
  return {
    phase: "executing",
    planId: ledger.planId,
    revision: ledger.revision,
    executionId: ledger.executionId,
    approvedDigest: ledger.planDigest,
    activeTaskId: ledger.activeTaskId,
    provider: ledger.provider,
  };
}

export function restorePendingPlanExecution(
  conversationKey: number,
  context: PlanRuntimeContext | undefined,
): void {
  if (context?.phase === "executing")
    pendingExecutions.set(conversationKey, context);
}

export function clearPlanModeState(conversationKey: number): void {
  composeStates.delete(conversationKey);
  pendingExecutions.delete(conversationKey);
}
