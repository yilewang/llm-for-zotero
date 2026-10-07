import { assert } from "chai";
import {
  configureContextSelectionBridge,
  getSelectedContextAttachment,
  resolveSelectedContextItem,
} from "../src/services/context/contextSelectionBridge";
import {
  configureAssistantNoteWriter,
  writeAssistantItemNote,
  writeAssistantStandaloneNote,
} from "../src/services/notes/assistantNoteWriterBridge";
import {
  configureRetrievalCandidateInvalidator,
  invalidateRetrievalCandidates,
} from "../src/services/retrieval/cacheInvalidation";
import { composeHostSurfaces } from "../src/modules/contextPanel/hostSurfaces";

const UNCOMPOSED = /adapter is not configured for this application surface/;

/**
 * A composed bridge reaches the panel implementation, which is free to fail on
 * the stub inputs used here. Only the bridge's own "nothing is configured"
 * error means the surface was never composed.
 */
function captureFailure(call: () => void): string {
  try {
    call();
    return "";
  } catch (error) {
    return String(error);
  }
}

async function captureAsyncFailure(
  call: () => Promise<unknown>,
): Promise<string> {
  try {
    await call();
    return "";
  } catch (error) {
    return String(error);
  }
}

describe("application surface bridges", function () {
  it("fails loudly when an uncomposed UI surface is asked for the selected context", function () {
    const restore = configureContextSelectionBridge(null);
    try {
      assert.throws(
        () => getSelectedContextAttachment(),
        "The context selection adapter is not configured for this application surface.",
      );
      assert.throws(
        () => resolveSelectedContextItem({ id: 4 } as Zotero.Item),
        "The context selection adapter is not configured for this application surface.",
      );
    } finally {
      restore();
    }
  });

  it("fails loudly when an uncomposed UI surface invalidates retrieval candidates", function () {
    const restore = configureRetrievalCandidateInvalidator(null);
    try {
      assert.throws(
        () => invalidateRetrievalCandidates(7),
        "The retrieval candidate invalidator adapter is not configured for this application surface.",
      );
    } finally {
      restore();
    }
  });

  it("exposes panel-selected context through a narrow runtime contract", function () {
    const attachment = { id: 9 } as Zotero.Item;
    const reset = configureContextSelectionBridge({
      getActiveAttachment: () => attachment,
      resolveContextItem: (item) => (item.id === 4 ? attachment : null),
    });
    try {
      assert.equal(getSelectedContextAttachment(), attachment);
      assert.equal(
        resolveSelectedContextItem({ id: 4 } as Zotero.Item),
        attachment,
      );
    } finally {
      reset();
    }
  });

  it("routes formatted assistant-note writes through the composed writer", async function () {
    const reset = configureAssistantNoteWriter({
      writeItemNote: async () => ({ status: "created", noteId: 11 }),
      writeStandaloneNote: async (params) => ({
        status: "standalone_created",
        noteId: 12,
        collections: params.collections,
      }),
    });
    try {
      assert.deepEqual(
        await writeAssistantItemNote({
          item: { id: 4 } as Zotero.Item,
          content: "answer",
          modelName: "model",
        }),
        { status: "created", noteId: 11 },
      );
      assert.deepEqual(
        await writeAssistantStandaloneNote({
          libraryID: 1,
          content: "answer",
          modelName: "model",
          collections: [3],
        }),
        { status: "standalone_created", noteId: 12, collections: [3] },
      );
    } finally {
      reset();
    }
  });
});

describe("host surface composition", function () {
  it("composes every services bridge at startup and clears them all on shutdown", async function () {
    const dispose = composeHostSurfaces();
    try {
      assert.notMatch(
        captureFailure(() => getSelectedContextAttachment()),
        UNCOMPOSED,
      );
      assert.notMatch(
        captureFailure(() =>
          resolveSelectedContextItem({ id: 4 } as Zotero.Item),
        ),
        UNCOMPOSED,
      );
      assert.notMatch(
        captureFailure(() => invalidateRetrievalCandidates(4)),
        UNCOMPOSED,
      );
      assert.notMatch(
        await captureAsyncFailure(() =>
          writeAssistantItemNote({
            item: {} as Zotero.Item,
            content: "answer",
            modelName: "model",
          }),
        ),
        UNCOMPOSED,
      );
      assert.notMatch(
        await captureAsyncFailure(() =>
          writeAssistantStandaloneNote({
            libraryID: 1,
            content: "answer",
            modelName: "model",
          }),
        ),
        UNCOMPOSED,
      );
    } finally {
      dispose();
    }

    assert.match(
      captureFailure(() => getSelectedContextAttachment()),
      UNCOMPOSED,
    );
    assert.match(
      captureFailure(() =>
        resolveSelectedContextItem({ id: 4 } as Zotero.Item),
      ),
      UNCOMPOSED,
    );
    assert.match(
      captureFailure(() => invalidateRetrievalCandidates(4)),
      UNCOMPOSED,
    );
    assert.match(
      await captureAsyncFailure(() =>
        writeAssistantItemNote({
          item: {} as Zotero.Item,
          content: "answer",
          modelName: "model",
        }),
      ),
      UNCOMPOSED,
    );
  });

  it("restores the surface that was configured before composition", function () {
    const probe = { id: 7 } as Zotero.Item;
    const restoreProbe = configureContextSelectionBridge({
      getActiveAttachment: () => probe,
      resolveContextItem: () => probe,
    });
    const disposeComposition = composeHostSurfaces();
    try {
      disposeComposition();
      assert.equal(getSelectedContextAttachment(), probe);
    } finally {
      restoreProbe();
    }
  });
});
