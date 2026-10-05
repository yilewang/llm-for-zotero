import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";

import type { BlockStreamFlushReason } from "../src/modules/contextPanel/blockStreamCoalescer";

/**
 * Integration guards for the retry and send flows in chat.ts.
 *
 * Streaming behavior is exercised directly in streamingResponse.test.ts and
 * blockStreamCoalescer.test.ts. These source checks keep the distinct flow
 * wiring and the two finalization orders that no behaviour test can observe:
 * the cancel flush before finalize, and the streamed-text read before dispose.
 *
 * Both flows run their turn through the assistant-turn owner
 * (assistantTurn.ts), so the ordering pins that used to read each flow read
 * the owner's steps instead, and each flow is pinned to call them.
 * assistantTurn.test.ts drives the same orderings behaviorally, and
 * test-workflows/chatTurnLifecycle.workflow.test.ts drives both live flows
 * through completion, cancellation, interruption, and retry restoration.
 */

const CHAT_SOURCE_PATH = "src/modules/contextPanel/chat.ts";
const OWNER_SOURCE_PATH = "src/modules/contextPanel/assistantTurn.ts";

/** A flush of the streaming response, whatever object owns it today. */
const FLUSH_CALL = (reason: BlockStreamFlushReason) =>
  new RegExp(`(?:flushResponseStream|\\w+\\.flush)\\("${reason}"\\)`);
/** Reading everything the model streamed, flushed or not. */
const READ_STREAMED_TEXT = /\.(?:getFullText|getStreamedText)\(\)/;
/** Dropping the buffer and refusing later deltas. */
const DISCARD_STREAM = /\.(?:cancel|dispose|rollback)\(\)/;
/** Constructing the per-turn streaming response. */
const CREATE_STREAM =
  /create(?:BlockStreamCoalescer|StreamingResponse)(?:Owner)?\(/;

function readChatSource(): string {
  return readFileSync(CHAT_SOURCE_PATH, "utf8");
}

function readOwnerSource(): string {
  return readFileSync(OWNER_SOURCE_PATH, "utf8");
}

/** One step of the owner, from its method to the next one. */
function ownerStep(startMarker: string, endMarker: string): string {
  return sliceBetween(readOwnerSource(), startMarker, endMarker);
}

function sliceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  assert.isAtLeast(start, 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.isAtLeast(end, 0, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

function retryFlowSource(source: string): string {
  return sliceBetween(
    source,
    "export async function retryLatestAssistantResponse(",
    "async function detachProviderForEdit(",
  );
}

function sendFlowSource(source: string): string {
  return sliceBetween(
    source,
    "export async function sendQuestion(",
    "function buildInlineEditWidget(",
  );
}

function matchIndex(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

describe("chat streaming-response wiring", function () {
  describe("flow order", function () {
    it("wires a streaming response in both the retry and the send flow", function () {
      const source = readChatSource();

      // Each flow builds the turn owner, which composes the stream; neither
      // flow builds a stream of its own.
      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        assert.include(flow, "createAssistantTurn(");
        assert.notMatch(flow, CREATE_STREAM);
      }
      assert.match(readOwnerSource(), CREATE_STREAM);
    });

    it("hands the streaming repaint to the native trace controller in both flows", function () {
      const source = readChatSource();

      // Each flow attaches the trace through the owner, which builds the
      // real controller with the stream's own repaint.
      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        assert.include(flow, "assistantTurn.attachCodexTrace(");
        assert.notInclude(flow, "createCodexNativeActivityTraceController(");
      }
      const attach = ownerStep("attachCodexTrace(", "persistTrace(");
      assert.include(
        readOwnerSource(),
        "deps.createCodexTrace || createCodexNativeActivityTraceController",
      );
      assert.include(attach, "createCodexTrace(message, stream.queueRefresh)");
    });

    it("flushes the streamed text before the cancelled turn is finalized", function () {
      const source = readChatSource();

      // Each flow cancels only through the owner's cancel step, in its own
      // order: the retry persists the trace first, the send repaints first.
      const retry = retryFlowSource(source);
      const send = sendFlowSource(source);
      for (const flow of [retry, send]) {
        assert.include(flow, "assistantTurn.cancel({");
        assert.notInclude(flow, "finalizeCancelledAssistantMessage(");
      }
      assert.include(retry, 'order: "trace-first"');
      assert.include(send, 'order: "refresh-first"');
      const cancel = ownerStep("async cancel(", "beginCompletion(");
      const flush = matchIndex(cancel, FLUSH_CALL("cancel"));
      const traceFlush = cancel.indexOf('flushBufferedProgress("cancel")');
      const finalize = cancel.indexOf("finalizeCancelledAssistantMessage(");

      assert.isAtLeast(flush, 0);
      assert.isAtLeast(traceFlush, 0);
      assert.isAtLeast(finalize, 0);
      assert.isBelow(flush, traceFlush);
      assert.isBelow(traceFlush, finalize);
    });

    it("flushes the streamed text before the completed turn is written", function () {
      const source = readChatSource();

      // The owner flushes when the completion begins and stamps the status
      // when it is recorded; each flow begins before it records.
      const owner = ownerStep("beginCompletion(outcome", "readInterruption(");
      const ownerFlush = matchIndex(owner, FLUSH_CALL("final"));
      const ownerCompletion = owner.indexOf(
        "message.completionStatus = outcome.completion.status;",
      );
      assert.isAtLeast(ownerFlush, 0);
      assert.isAtLeast(ownerCompletion, 0);
      assert.isBelow(ownerFlush, ownerCompletion);
      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        const begin = flow.indexOf("assistantTurn.beginCompletion(");
        const record = flow.indexOf("assistantTurn.recordCompletion(");
        assert.isAtLeast(begin, 0);
        assert.isAtLeast(record, 0);
        assert.isBelow(begin, record);
        assert.notInclude(flow, "completionStatus = modelOutcome.completion");
      }
    });

    it("reads the streamed text before discarding it on the error path", function () {
      const source = readChatSource();

      // Each flow reads its interruption through the owner.
      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        assert.include(flow, "assistantTurn.readInterruption(err,");
        assert.notInclude(flow, "const partialText =");
      }
      const owner = ownerStep("readInterruption(error", "end(): void");
      assert.include(owner, "const partialText =");
      const catchBlock = owner.slice(owner.indexOf("const partialText ="));
      const read = matchIndex(catchBlock, READ_STREAMED_TEXT);
      const discard = matchIndex(catchBlock, DISCARD_STREAM);

      assert.isAtLeast(read, 0);
      assert.isAtLeast(discard, 0);
      assert.isBelow(read, discard);
    });

    it("drops the retry stream before the original turn is restored", function () {
      const source = readChatSource();
      const restore = sliceBetween(
        retryFlowSource(source),
        "const restoreOriginalTurn = () => {",
        "const stopRetryPreparation = () => {",
      );

      const discard = matchIndex(restore, DISCARD_STREAM);
      const snapshot = restore.indexOf("restoreAssistantSnapshot(");

      assert.isAtLeast(discard, 0);
      assert.isAtLeast(snapshot, 0);
      assert.isBelow(discard, snapshot);
    });
  });
});
