import { getAllSkills, setUserSkills, parseSkill } from "../src/agent/skills";
import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { semanticInputDigest } from "../src/agent/model/semanticTransport";
import {
  classifiedFixture,
  semanticContractFixture,
} from "./helpers/semanticIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("prepared semantic authority lifetime", function () {
  let originalZotero: unknown;
  beforeEach(function () {
    originalZotero = globalThis.Zotero;
    globalThis.Zotero = { DB: { queryAsync: async () => [] } } as any;
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero as any;
  });
  it("reinterprets a reused request when the selected context or source turn changes", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "File this paper",
      activeItemId: 41,
      libraryID: 1,
      metadata: { sourceMessageTimestamp: 100 },
    });
    request.classifiedIntent = classifiedFixture();
    request.classifiedIntent.semantic!.inputDigest =
      await semanticInputDigest(request);
    request.actionContract = semanticContractFixture({
      version: 4,
      id: "old-contract",
      writeDisposition: "none",
      interpretationSource: "semantic",
      intent: request.classifiedIntent,
      obligations: [],
    });
    request.actionContract.intent = request.classifiedIntent;
    request.metadata = { sourceMessageTimestamp: 200 };
    let interpretations = 0;
    const runtime = new AgentRuntime({
      registry: new AgentToolRegistry(),
      adapterFactory: () => {
        throw new Error("Execution is not part of preparation");
      },
      semanticInterpreter: {
        interpret: async (current) => {
          interpretations++;
          const intent = classifiedFixture();
          intent.semantic!.inputDigest = await semanticInputDigest(current);
          return { classifiedIntent: intent, skillIds: [], degraded: false };
        },
      },
    });
    await runtime.prepareSemanticRequest(request);
    assert.equal(interpretations, 1);
    assert.notEqual(request.actionContract?.id, "old-contract");
    assert.equal(
      request.classifiedIntent.semantic!.inputDigest,
      await semanticInputDigest(request),
    );
  });

  it("preserves a current prepared contract and its verified progress", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "File this paper",
    });
    request.classifiedIntent = classifiedFixture();
    request.classifiedIntent.semantic!.inputDigest =
      await semanticInputDigest(request);
    request.actionContract = semanticContractFixture({
      version: 4,
      id: "prepared",
      writeDisposition: "none",
      interpretationSource: "semantic",
      obligations: [],
    });
    request.actionContract.intent = request.classifiedIntent;
    const registry = new AgentToolRegistry();
    request.actionProgress = registry.createActionProgress(
      request.actionContract,
    );
    request.actionPreparation = { state: "ready", issues: [] };
    const contract = request.actionContract;
    const progress = request.actionProgress;
    const runtime = new AgentRuntime({
      registry,
      semanticInterpreter: {
        interpret: async () => {
          throw new Error("Already interpreted");
        },
      },
    });
    await runtime.prepareSemanticRequest(request);
    assert.strictEqual(request.actionContract, contract);
    assert.strictEqual(request.actionProgress, progress);
  });

  it("invalidates interpretations when attached evidence, configured instructions, or skill meaning changes", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Use this context",
      screenshots: ["data:image/png;base64,AAAA"],
      customInstructions: "Preserve other memberships",
    });
    const skills = getAllSkills();
    try {
      setUserSkills([
        parseSkill(
          "---\nid: inspect\ndescription: Inspect source evidence\n---\nRead the source.",
        ),
      ]);
      const initial = await semanticInputDigest(request);
      assert.notEqual(
        initial,
        await semanticInputDigest({
          ...request,
          screenshots: ["data:image/png;base64,BBBB"],
        }),
      );
      assert.notEqual(
        initial,
        await semanticInputDigest({
          ...request,
          customInstructions: "Do not use the network",
        }),
      );
      setUserSkills([
        parseSkill(
          "---\nid: inspect\ndescription: Inspect source evidence\n---\nRead every source and compare it.",
        ),
      ]);
      assert.notEqual(initial, await semanticInputDigest(request));
    } finally {
      setUserSkills(skills);
    }
  });

  it("binds the exact source message and selected-text provenance in the context digest", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "File this paper",
      metadata: { sourceMessageTimestamp: 1 },
      selectedTexts: ["quoted text"],
    });
    const before = await semanticInputDigest(request);
    assert.notEqual(
      before,
      await semanticInputDigest({
        ...request,
        metadata: { sourceMessageTimestamp: 2 },
      }),
    );
    assert.notEqual(
      before,
      await semanticInputDigest({
        ...request,
        selectedTextSources: ["note"],
      } as any),
    );
  });
});
