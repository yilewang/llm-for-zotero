import type { ClassifiedTurnIntent } from "../../src/agent/types";
import type { SemanticIntent } from "../../src/agent/model/semanticDecisions";

/** Explicit test configuration, independent of the request wording and tool calls. */
export function semanticFixture(
  overrides: Partial<SemanticIntent> = {},
): SemanticIntent {
  return {
    version: 1,
    id: "semantic:test",
    revision: 1,
    inputDigest: "test-context-digest",
    constraints: [],
    noteDestination: "none",
    conversationOnly: false,
    reading: { source: "document_text", coverage: "targeted" },
    literature: "none",
    bulk: false,
    continuation: "new",
    questions: [],
    ...overrides,
  };
}

export function classifiedFixture(
  overrides: Partial<ClassifiedTurnIntent> = {},
): ClassifiedTurnIntent {
  return {
    retrievalIntent: "none",
    paperTargetIntent: "active",
    externalSearchIntent: "none",
    deliverableIntent: "chat",
    wantedSections: [],
    writeDisposition: "none",
    actionInterpretationSource: "semantic",
    actionIntents: [],
    semantic: semanticFixture(),
    ...overrides,
  };
}

/** Constructs a current contract from an explicitly declared test obligation set. */
export function semanticContractFixture(
  contract: import("../../src/agent/contracts/types").AgentActionContract,
): import("../../src/agent/contracts/types").AgentActionContract {
  return {
    ...contract,
    version: 4,
    interpretationSource: "semantic",
    intent: classifiedFixture({
      writeDisposition: contract.writeDisposition,
      actionIntents: contract.obligations,
      semantic: semanticFixture({
        constraints: (contract.hardConstraints || []).filter(
          (entry) => entry.kind !== "no_write",
        ) as SemanticIntent["constraints"],
      }),
    }),
  };
}

export function semanticResponseFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskKind: "read",
    requestedScopes: ["none"],
    selections: [],
    ...classifiedFixture(),
    decisions: semanticFixture(),
    ...overrides,
  };
}

export function actionFixture(
  operation: import("../../src/agent/contracts/types").AgentActionOperation,
  parameters?: import("../../src/agent/contracts/types").AgentActionParameters,
  decisions: Partial<SemanticIntent> = {},
): ClassifiedTurnIntent {
  const details = operationCatalogEntry(operation);
  if (!details) throw new Error(`Unknown test operation: ${operation}`);
  return classifiedFixture({
    writeDisposition: operation === "read_full" ? "none" : "required",
    actionIntents: [
      {
        operation,
        ...details,
        coverage: "one",
        targetKind: "items",
        parameters,
      },
    ],
    semantic: semanticFixture(decisions),
  });
}
import { operationCatalogEntry } from "../../src/agent/contracts/operationCatalog";

export function skillReceiptFixture(
  ids: string[],
): import("../../src/agent/types").AgentRuntimeRequest["skillRoutingReceipt"] {
  return {
    routerSchemaVersion: 1,
    routerIdentityHash: "test",
    skillManifestHash: "test",
    skills: ids.map((id) => ({
      id,
      source: "automatic",
      requestedScope: "none",
      version: 1,
      instructionHash: "test",
    })),
  };
}

export function actionContractFixture(
  operation: import("../../src/agent/contracts/types").AgentActionOperation,
  parameters?: import("../../src/agent/contracts/types").AgentActionParameters,
) {
  const intent = actionFixture(operation, parameters);
  return semanticContractFixture({
    version: 4,
    id: `contract:${operation}`,
    writeDisposition: intent.writeDisposition!,
    interpretationSource: "semantic",
    obligations: [
      { ...intent.actionIntents[0], id: `obligation:${operation}` },
    ],
    intent,
  });
}

/** Declared semantic fixture transport for runtime tests; no request-language interpretation. */
export const declaredSemanticInterpreter: Pick<
  import("../../src/agent/model/semanticIntentService").SemanticIntentService,
  "interpret"
> = {
  async interpret(request) {
    const { semanticInputDigest } =
      await import("../../src/agent/model/semanticTransport");
    const classifiedIntent = request.classifiedIntent;
    if (!classifiedIntent?.semantic)
      return {
        classifiedIntent: null,
        skillIds: [],
        degraded: true,
        failureReason: "not_configured",
      };
    return {
      classifiedIntent: {
        ...classifiedIntent,
        semantic: {
          ...classifiedIntent.semantic,
          inputDigest: await semanticInputDigest(request),
        },
      },
      skillIds:
        request.skillRoutingReceipt?.skills.map((skill) => skill.id) || [],
      routingReceipt: request.skillRoutingReceipt,
      degraded: false,
    };
  },
};
