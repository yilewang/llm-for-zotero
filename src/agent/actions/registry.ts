import type { AgentAction, ActionExecutionContext, ActionResult } from "./types";
import type { PaperScopedActionProfile } from "./paperScope";

export class ActionRegistry {
  private readonly actions = new Map<string, AgentAction<any, any>>();

  register<TInput, TOutput>(action: AgentAction<TInput, TOutput>): void {
    this.actions.set(action.name, action);
  }

  unregister(name: string): boolean {
    return this.actions.delete(name);
  }

  getAction(name: string): AgentAction<any, any> | undefined {
    return this.actions.get(name);
  }

  getPaperScopedActionProfile(name: string): PaperScopedActionProfile | undefined {
    return this.actions.get(name)?.paperScopeProfile;
  }

  listActions(mode?: "paper" | "library"): Array<{ name: string; description: string; inputSchema: object }> {
    return Array.from(this.actions.values())
      .filter((a) => !mode || !a.modes || a.modes.includes(mode))
      .map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
  }

  async run(
    name: string,
    input: unknown,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<unknown>> {
    const action = this.actions.get(name);
    if (!action) {
      return { ok: false, error: `Unknown action: ${name}` };
    }
    try {
      return await action.execute(input, ctx);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
