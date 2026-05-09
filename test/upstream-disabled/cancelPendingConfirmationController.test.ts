import { assert } from "chai";
import { describe, it } from "mocha";
import {
  cancelVisiblePendingConfirmationCards,
  type ResolvePendingConfirmation,
} from "../src/modules/contextPanel/setupHandlers/controllers/cancelPendingConfirmationController";

describe("cancelPendingConfirmationController", function () {
  it("resolves visible pending confirmation cards as cancelled and removes them", function () {
    const wrapper = {
      removed: false,
      remove() {
        this.removed = true;
      },
    };
    const wrappedCard = {
      dataset: { requestId: "req-1" },
      removed: false,
      closest: (selector: string) =>
        selector === ".llm-action-inline-card" ? wrapper : null,
      remove() {
        this.removed = true;
      },
    };
    const standaloneCard = {
      dataset: { requestId: "req-2" },
      removed: false,
      closest: () => null,
      remove() {
        this.removed = true;
      },
    };
    const root = {
      querySelectorAll: (selector: string) =>
        selector === ".llm-agent-hitl-card[data-request-id]"
          ? [wrappedCard, standaloneCard]
          : [],
    } as unknown as ParentNode;

    const calls: Array<{ requestId: string; approved: boolean; actionId?: string }> =
      [];
    const resolveConfirmation: ResolvePendingConfirmation = (
      requestId,
      resolution,
    ) => {
      calls.push({
        requestId,
        approved: resolution.approved,
        actionId: resolution.actionId,
      });
      return true;
    };

    const cancelled = cancelVisiblePendingConfirmationCards(
      root,
      resolveConfirmation,
    );

    assert.deepEqual(cancelled, ["req-1", "req-2"]);
    assert.deepEqual(calls, [
      { requestId: "req-1", approved: false, actionId: "cancel" },
      { requestId: "req-2", approved: false, actionId: "cancel" },
    ]);
    assert.isTrue(wrapper.removed);
    assert.isFalse(wrappedCard.removed);
    assert.isTrue(standaloneCard.removed);
  });
});
