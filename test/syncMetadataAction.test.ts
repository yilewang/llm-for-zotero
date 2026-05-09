import { assert } from "chai";
import { syncMetadataAction } from "../src/agent/actions/syncMetadata";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type {
  ActionExecutionContext,
  ActionProgressEvent,
} from "../src/agent/actions/types";
import type {
  AgentPendingAction,
  AgentToolDefinition,
} from "../src/agent/types";

function createStubTool<TInput extends Record<string, unknown>, TResult>(
  spec: AgentToolDefinition<TInput, TResult>["spec"],
  validate: AgentToolDefinition<TInput, TResult>["validate"],
  execute: AgentToolDefinition<TInput, TResult>["execute"],
  extras: Partial<AgentToolDefinition<TInput, TResult>> = {},
): AgentToolDefinition<TInput, TResult> {
  return {
    spec,
    validate,
    execute,
    ...extras,
  };
}

describe("sync_metadata action", function () {
  it("reads DOI from metadata snapshots and sends canonical metadata updates", async function () {
    const registry = new AgentToolRegistry();
    let mutateInput: Record<string, unknown> | null = null;

    registry.register(
      createStubTool(
        {
          name: "query_library",
          description: "query",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          results: [
            {
              itemId: 101,
              metadata: {
                title: "Existing Paper",
                fields: {
                  DOI: "https://doi.org/10.1000/example",
                  abstractNote: "",
                  date: "",
                  publicationTitle: "",
                },
                creators: [],
              },
            },
          ],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "search_literature_online",
          description: "search",
          inputSchema: { type: "object" },
          mutability: "read",
          requiresConfirmation: false,
        },
        (args) => ({ ok: true, value: args as Record<string, unknown> }),
        async () => ({
          results: [
            {
              source: "CrossRef",
              displayTitle: "Existing Paper",
              patch: {
                title: "Existing Paper",
                abstractNote: "Remote abstract",
                date: "2024",
                publicationTitle: "Journal of Tests",
                creators: [
                  {
                    creatorType: "author",
                    name: "Alice Example",
                    fieldMode: 1,
                  },
                  { creatorType: "author", name: "Bob Example", fieldMode: 1 },
                ],
              },
            },
          ],
        }),
      ),
    );

    registry.register(
      createStubTool(
        {
          name: "update_metadata",
          description: "mutate",
          inputSchema: { type: "object" },
          mutability: "write",
          requiresConfirmation: true,
        },
        (args) => {
          const operations =
            args &&
            typeof args === "object" &&
            Array.isArray((args as { operations?: unknown[] }).operations)
              ? (args as { operations: Array<Record<string, unknown>> })
                  .operations
              : [];
          const op = operations[0];
          const metadata =
            op &&
            typeof op === "object" &&
            op.metadata &&
            typeof op.metadata === "object" &&
            !Array.isArray(op.metadata)
              ? (op.metadata as Record<string, unknown>)
              : null;
          if (
            operations.length !== 1 ||
            op?.type !== "update_metadata" ||
            op.itemId !== 101 ||
            metadata?.abstractNote !== "Remote abstract" ||
            metadata?.date !== "2024" ||
            metadata?.publicationTitle !== "Journal of Tests" ||
            !Array.isArray(metadata?.creators) ||
            metadata.creators.length !== 2
          ) {
            return { ok: false, error: "unexpected mutate payload" };
          }
          return { ok: true, value: args as Record<string, unknown> };
        },
        async (input) => {
          mutateInput = input;
          return {
            results: [{ itemId: 101 }],
          };
        },
        {
          createPendingAction: async () =>
            ({
              toolName: "update_metadata",
              title: "Review 1 library change",
              confirmLabel: "Apply changes",
              cancelLabel: "Cancel",
              fields: [],
            }) satisfies AgentPendingAction,
        },
      ),
    );

    const progress: ActionProgressEvent[] = [];
    const ctx: ActionExecutionContext = {
      registry,
      zoteroGateway: {} as never,
      services: {} as never,
      libraryID: 1,
      confirmationMode: "auto_approve",
      onProgress: (event) => {
        progress.push(event);
      },
      requestConfirmation: async () => ({ approved: true }),
    };

    const result = await syncMetadataAction.execute({}, ctx);

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.output, {
      scanned: 1,
      withIdentifier: 1,
      updated: 1,
      skipped: 0,
      errors: 0,
    });
    assert.exists(mutateInput);
    assert.include(
      progress
        .filter((event) => event.type === "step_done")
        .map((event) => ("summary" in event ? event.summary : "")),
      "1 items have updatable fields",
    );
  });
});
