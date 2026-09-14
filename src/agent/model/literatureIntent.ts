import type { AgentRuntimeRequest } from "../types";
type Request = Pick<AgentRuntimeRequest, "classifiedIntent">;
export function isExplicitLiteratureImport(request: Request): boolean {
  return request.classifiedIntent?.semantic?.literature === "import";
}
export function isLiteratureDiscovery(request: Request): boolean {
  const mode = request.classifiedIntent?.semantic?.literature;
  return mode === "discover" || mode === "select_then_import";
}
