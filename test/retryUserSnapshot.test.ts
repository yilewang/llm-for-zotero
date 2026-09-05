import { assert } from "chai";
import { describe, it } from "mocha";

import type { Message } from "../src/modules/contextPanel/types";
import {
  restoreRetryUserSnapshot,
  takeRetryUserSnapshot,
} from "../src/modules/contextPanel/retryUserSnapshot";

function userMessage(): Message {
  return {
    role: "user",
    text: "compare the methods",
    timestamp: 100,
    agentRunId: "run-old",
    selectedTextContexts: [{ text: "old selection" } as never],
    screenshotImages: ["data:image/png;base64,old"],
    paperContexts: [{ itemId: 1, title: "Old paper" } as never],
    pdfPaperContexts: [{ itemId: 2, title: "Old pdf" } as never],
    fullTextPaperContexts: [{ itemId: 3, title: "Old full" } as never],
    citationPaperContexts: [{ itemId: 4, title: "Old cite" } as never],
    selectedCollectionContexts: [{ id: 9, name: "Old coll" } as never],
    modelAttachments: [{ id: "att-old" } as never],
    modelName: "model-a",
    modelEntryId: "entry-a",
    modelProviderLabel: "Provider A",
  };
}

describe("retryUserSnapshot", function () {
  it("restores every retry-mutated field to its pre-retry value", function () {
    const message = userMessage();
    const snapshot = takeRetryUserSnapshot(message);

    message.agentRunId = "run-new";
    message.selectedTextContexts = undefined;
    message.screenshotImages = undefined;
    message.paperContexts = [{ itemId: 10, title: "New paper" } as never];
    message.pdfPaperContexts = undefined;
    message.fullTextPaperContexts = undefined;
    message.citationPaperContexts = undefined;
    message.selectedCollectionContexts = undefined;
    message.modelAttachments = [{ id: "att-new" } as never];
    message.modelName = "model-b";
    message.modelEntryId = "entry-b";
    message.modelProviderLabel = "Provider B";

    restoreRetryUserSnapshot(message, snapshot);

    assert.deepEqual(message, userMessage());
  });

  it("is immune to in-place mutation of the original arrays", function () {
    const message = userMessage();
    const snapshot = takeRetryUserSnapshot(message);

    // A streaming tool round may push into the live array rather than
    // replacing it; the snapshot must keep the pre-retry contents.
    message.citationPaperContexts!.push({
      itemId: 99,
      title: "Merged during retry",
    } as never);

    restoreRetryUserSnapshot(message, snapshot);

    assert.deepEqual(message.citationPaperContexts, [
      { itemId: 4, title: "Old cite" },
    ]);
  });

  it("restores undefined fields as undefined rather than empty arrays", function () {
    const message: Message = {
      role: "user",
      text: "plain question",
      timestamp: 100,
    };
    const snapshot = takeRetryUserSnapshot(message);

    message.paperContexts = [{ itemId: 10 } as never];
    message.modelName = "model-b";

    restoreRetryUserSnapshot(message, snapshot);

    assert.isUndefined(message.paperContexts);
    assert.isUndefined(message.modelName);
  });
});
