import { assert } from "chai";
import {
  getWorkflowTestFinalRequestInterceptor,
  setWorkflowTestFinalRequestInterceptor,
} from "../src/modules/contextPanel/workflowTestHooks";

describe("workflowTestHooks", function () {
  afterEach(function () {
    setWorkflowTestFinalRequestInterceptor(null);
  });

  it("stores a final request interceptor for cap-aware harness diagnostics", async function () {
    const calls: unknown[] = [];
    setWorkflowTestFinalRequestInterceptor((snapshot) => {
      calls.push(snapshot);
    });

    const interceptor = getWorkflowTestFinalRequestInterceptor();
    assert.isFunction(interceptor);
    await interceptor?.({
      combinedContext: "Reading receipt:\n- Planned papers: 2",
      strategy: "general-retrieval",
      systemMessages: ["Reading receipt:\n- Planned papers: 2"],
      inputCapEffects: {
        documentContextTrimmed: false,
        documentContextDropped: false,
        promptTrimmed: false,
        historyDropped: false,
      },
      readStrategy: {
        resolvedStrategy: "deep_synthesis",
        answerStyle: "concise_overview",
        strategyReason: "Bounded multi-paper synthesis.",
        papersPlanned: 2,
        papersBodyRead: 2,
        papersMetadataOnly: 0,
        unreadableReasons: [],
        stopReason: "enough_evidence",
        coverageFrontier: [],
      },
      coverageReceipt: {
        text: "Reading receipt:\n- Planned papers: 2",
        resolvedStrategy: "deep_synthesis",
        papersPlanned: 2,
        papersBodyRead: 2,
        papersMetadataOnly: 0,
        stopReason: "enough_evidence",
        coverageFrontier: [],
      },
    });

    assert.lengthOf(calls, 1);
    assert.deepInclude(calls[0] as Record<string, unknown>, {
      strategy: "general-retrieval",
    });
  });
});
