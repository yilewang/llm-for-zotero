import { assert } from "chai";
import {
  tryBeginRequest,
  finishRequest,
  recordLivePlanExecution,
  getLivePlanExecution,
} from "../src/modules/contextPanel/state";
import type { PlanExecutionLedger } from "../src/agent/plans/types";

describe("live plan execution ownership", function () {
  const key = 908172;
  const ledger = (status: PlanExecutionLedger["status"], updatedAt = 1) =>
    ({
      executionId: "execution",
      conversationKey: key,
      status,
      updatedAt,
    }) as PlanExecutionLedger;
  afterEach(function () {
    finishRequest(key, 1);
    finishRequest(key, 2);
  });

  it("requires the exact live request and run rather than history", function () {
    recordLivePlanExecution(key, 1, "run", ledger("running"));
    assert.isNull(getLivePlanExecution(key));
    assert.isTrue(tryBeginRequest(key, 1, null));
    recordLivePlanExecution(key, 2, "stale-run", ledger("running"));
    assert.isNull(getLivePlanExecution(key));
    recordLivePlanExecution(key, 1, "run", ledger("running"));
    assert.equal(getLivePlanExecution(key)?.runId, "run");
    finishRequest(key, 1);
    assert.isNull(getLivePlanExecution(key));
    tryBeginRequest(key, 2, null);
    recordLivePlanExecution(key, 1, "run", ledger("running", 3));
    assert.isNull(getLivePlanExecution(key));
  });

  for (const status of [
    "completed",
    "completed_with_exceptions",
    "failed",
    "cancelled",
    "superseded",
  ] as const) {
    it(`cannot revive ${status} with a late running event`, function () {
      tryBeginRequest(key, 1, null);
      recordLivePlanExecution(key, 1, "run", ledger("running"));
      recordLivePlanExecution(key, 1, "run", ledger(status, 2));
      recordLivePlanExecution(key, 1, "run", ledger("running", 3));
      assert.isNull(getLivePlanExecution(key));
      finishRequest(key, 1);
      tryBeginRequest(key, 2, null);
      recordLivePlanExecution(key, 2, "new-run", {
        ...ledger("running", 4),
        executionId: "new-execution",
      });
      assert.equal(
        getLivePlanExecution(key)?.ledger.executionId,
        "new-execution",
      );
    });
  }

  for (const status of [
    "waiting_for_user",
    "blocked",
    "interrupted",
  ] as const) {
    it(`hides ${status} and permits a real resume`, function () {
      tryBeginRequest(key, 1, null);
      recordLivePlanExecution(key, 1, "run", ledger("running"));
      recordLivePlanExecution(key, 1, "run", ledger(status, 2));
      assert.isNull(getLivePlanExecution(key));
      recordLivePlanExecution(key, 1, "run", ledger("running", 1));
      assert.isNull(getLivePlanExecution(key));
      recordLivePlanExecution(key, 1, "run", ledger("running", 3));
      assert.isNotNull(getLivePlanExecution(key));
    });
  }
});
