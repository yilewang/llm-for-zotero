import { assert } from "chai";
import type { AgentActionSummaryResultCard } from "../src/agent/types";
import { renderActionSummaryCard } from "../src/modules/contextPanel/agentTrace/actionSummaryCard";
import {
  clearChatScrollSnapshotsForTests,
  getChatScrollSnapshot,
  setFollowBottomChatScrollSnapshot,
} from "../src/modules/contextPanel/chatScrollSnapshots";
import { fakeDocument, FakeElement } from "./helpers/fakeDom";

describe("action summary disclosure scroll wiring", function () {
  const key = 928402;
  const entry: AgentActionSummaryResultCard["entries"][number] = {
    targets: [],
    effects: [
      {
        receiptId: "command-1",
        operation: "command_execute",
        verb: {},
        label: "Ran command",
        objects: [],
        command: "echo result",
      },
    ],
    verification: "verified",
    badges: [],
    rejected: [],
  };
  function fixture(count: number) {
    clearChatScrollSnapshotsForTests();
    const root = { dataset: { itemId: String(key) } };
    const box = {
      scrollTop: 600,
      scrollHeight: 800,
      clientHeight: 200,
      closest: (selector: string) => (selector === "#llm-main" ? root : null),
    } as unknown as HTMLDivElement;
    const card = renderActionSummaryCard(fakeDocument, {
      kind: "action_summary",
      actionCount: count,
      entries: Array.from({ length: count }, () => entry),
    }) as unknown as FakeElement;
    const controls = [
      ...card.findAllByTag("summary"),
      ...card.findAllByClass("llm-agent-action-summary-toggle"),
    ];
    for (const control of controls) {
      const closest = control.closest.bind(control);
      control.closest = (selector) =>
        selector === "#llm-chat-box"
          ? (box as unknown as FakeElement)
          : closest(selector);
    }
    setFollowBottomChatScrollSnapshot(key, box);
    return { card, box };
  }

  it("wires each rendered row to save manual reading intent before expansion", function () {
    const { card, box } = fixture(2);
    for (const summary of card.findAllByTag("summary")) {
      setFollowBottomChatScrollSnapshot(key, box);
      summary.dispatchFakeEvent("click");
      assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
      assert.equal(getChatScrollSnapshot(key, box)?.scrollTop, 600);
    }
  });

  it("wires the rendered show/hide control before its height-changing handler", function () {
    const { card, box } = fixture(5);
    const toggle = card.findByClass("llm-agent-action-summary-toggle")!;
    const list = card.findByClass("llm-agent-action-summary-list")!;
    assert.isTrue(list.hidden);
    toggle.dispatchFakeEvent("click");
    assert.isFalse(list.hidden);
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
    assert.equal(getChatScrollSnapshot(key, box)?.scrollTop, 600);
  });

  it("leaves automatic expansion and object navigation in follow-bottom mode", function () {
    const { card, box } = fixture(1);
    const details = card.findAllByTag("details")[0];
    details.open = true;
    details.dispatchFakeEvent("toggle");
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "followBottom");
    const link = new FakeElement("span");
    link.className = "llm-agent-action-link";
    card
      .findAllByTag("summary")[0]
      .dispatchFakeEvent("click", { target: link });
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "followBottom");
  });
});
