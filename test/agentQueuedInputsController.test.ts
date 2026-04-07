import { assert } from "chai";
import {
  createAgentQueuedInputsController,
} from "../src/modules/contextPanel/setupHandlers/controllers/agentQueuedInputsController";

describe("agentQueuedInputsController", function () {
  it("enqueues trimmed inputs and preserves order", function () {
    const ctl = createAgentQueuedInputsController();

    const first = ctl.enqueue("  first  ");
    const second = ctl.enqueue("second");

    assert.isTrue(first.enqueued);
    assert.isTrue(second.enqueued);
    assert.deepEqual(
      ctl.list().map((entry) => ({
        text: entry.text,
        status: entry.status,
      })),
      [
        { text: "first", status: "queued" },
        { text: "second", status: "queued" },
      ],
    );
  });

  it("rejects empty inputs", function () {
    const ctl = createAgentQueuedInputsController();
    const result = ctl.enqueue("   ");

    assert.isFalse(result.enqueued);
    assert.equal(ctl.size(), 0);
  });

  it("removes queued input by id", function () {
    const ctl = createAgentQueuedInputsController();
    const first = ctl.enqueue("first");
    const second = ctl.enqueue("second");

    assert.isTrue(first.enqueued);
    assert.isTrue(second.enqueued);
    assert.isTrue(ctl.remove(second.id));
    assert.deepEqual(
      ctl.list().map((entry) => entry.text),
      ["first"],
    );
  });

  it("moves selected entry to front when steering", function () {
    const ctl = createAgentQueuedInputsController();
    const first = ctl.enqueue("first");
    const second = ctl.enqueue("second");
    const third = ctl.enqueue("third");

    assert.isTrue(first.enqueued);
    assert.isTrue(second.enqueued);
    assert.isTrue(third.enqueued);

    assert.isTrue(ctl.steerToFront(third.id));
    assert.deepEqual(
      ctl.list().map((entry) => entry.text),
      ["third", "first", "second"],
    );
  });

  it("dequeues in FIFO order", function () {
    const ctl = createAgentQueuedInputsController();
    ctl.enqueue("first");
    ctl.enqueue("second");

    assert.equal(ctl.dequeue()?.text, "first");
    assert.equal(ctl.dequeue()?.text, "second");
    assert.isUndefined(ctl.dequeue());
  });

  it("marks the next queued entry as sending before dispatch", function () {
    const ctl = createAgentQueuedInputsController();
    ctl.enqueue("first");
    ctl.enqueue("second");

    const next = ctl.takeNextForSend();

    assert.equal(next?.text, "first");
    assert.deepEqual(
      ctl.list().map((entry) => ({
        text: entry.text,
        status: entry.status,
      })),
      [
        { text: "first", status: "sending" },
        { text: "second", status: "queued" },
      ],
    );
  });
});
