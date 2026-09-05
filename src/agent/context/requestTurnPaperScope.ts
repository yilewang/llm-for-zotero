import type { ResolvedAgentRuntimeRequest } from "../types";
import {
  listTurnPaperRefs,
  listTurnPapersWithRoles,
  type TurnPaperRef,
  type TurnPaperRole,
  type TurnPaperScope,
} from "./turnPaperScope";

export function getTurnPaperScopeFromRequest(
  request: ResolvedAgentRuntimeRequest,
): TurnPaperScope {
  return request.turnPaperScope;
}

export function getTurnPapers(
  request: ResolvedAgentRuntimeRequest,
): readonly TurnPaperRef[] {
  return listTurnPaperRefs(getTurnPaperScopeFromRequest(request));
}

export function getTurnPapersWithRoles(
  request: ResolvedAgentRuntimeRequest,
  roles: readonly TurnPaperRole[],
): readonly TurnPaperRef[] {
  return listTurnPapersWithRoles(getTurnPaperScopeFromRequest(request), roles);
}
