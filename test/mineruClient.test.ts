import { assert } from "chai";
import { zipSync } from "fflate";
import {
  getMineruCloudPollDecisionForTests,
  MineruCancelledError,
  parsePdfWithMineruLocal,
  resetMineruLocalFileParseGateForTests,
  setMineruLocalBusyRetryDelaysForTests,
} from "../src/utils/mineruClient";

const MINUTE_MS = 60 * 1000;
const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function createMineruZip(markdown: string): Uint8Array {
  return zipSync({
    "full.md": bytes(markdown),
    "content_list.json": bytes("[]"),
  });
}

function setupLocalMineruClientTest(files: Record<string, string>): void {
  const fileBytes = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(files)) {
    fileBytes.set(path, bytes(value));
  }
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    isWin: false,
    version: "test",
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    getGlobal: (name: string) => {
      if (name === "fetch") return globalThis.fetch;
      if (name === "AbortController") return AbortController;
      return undefined;
    },
    log: () => {},
  };
  (globalThis as unknown as { IOUtils: unknown }).IOUtils = {
    read: async (path: string) => {
      const data = fileBytes.get(path);
      if (!data) throw new Error("missing");
      return data;
    },
  };
}

describe("mineruClient cloud poll policy", function () {
  it("times out pending jobs after the pre-processing window", function () {
    const decision = getMineruCloudPollDecisionForTests({
      state: "pending",
      nowMs: 30 * MINUTE_MS,
      pollStartMs: 0,
      lastStatusAtMs: 30 * MINUTE_MS,
      activeStartedAtMs: null,
    });

    assert.equal(decision.action, "timeout");
    if (decision.action === "timeout") {
      assert.equal(decision.reason, "pre_processing");
      assert.equal(decision.phase, "pre_processing");
    }
  });

  it("does not time out active running or converting jobs", function () {
    for (const state of ["running", "converting"]) {
      const decision = getMineruCloudPollDecisionForTests({
        state,
        nowMs: 3 * 60 * MINUTE_MS,
        pollStartMs: 0,
        lastStatusAtMs: 3 * 60 * MINUTE_MS,
        activeStartedAtMs: 5 * MINUTE_MS,
      });

      assert.equal(decision.action, "continue");
      if (decision.action === "continue") {
        assert.equal(decision.phase, "active_processing");
        assert.equal(decision.pollIntervalMs, 60 * 1000);
      }
    }
  });

  it("times out when polling stops returning usable status", function () {
    const noStatusFromStart = getMineruCloudPollDecisionForTests({
      state: null,
      nowMs: 10 * MINUTE_MS,
      pollStartMs: 0,
      lastStatusAtMs: null,
      activeStartedAtMs: null,
    });

    assert.equal(noStatusFromStart.action, "timeout");
    if (noStatusFromStart.action === "timeout") {
      assert.equal(noStatusFromStart.reason, "no_status");
    }

    const malformedAfterStatus = getMineruCloudPollDecisionForTests({
      state: "",
      nowMs: 20 * MINUTE_MS,
      pollStartMs: 0,
      lastStatusAtMs: 10 * MINUTE_MS,
      activeStartedAtMs: null,
    });

    assert.equal(malformedAfterStatus.action, "timeout");
    if (malformedAfterStatus.action === "timeout") {
      assert.equal(malformedAfterStatus.reason, "no_status");
    }
  });

  it("keeps done and failed states terminal", function () {
    for (const state of ["done", "failed"] as const) {
      const decision = getMineruCloudPollDecisionForTests({
        state,
        nowMs: 90 * MINUTE_MS,
        pollStartMs: 0,
        lastStatusAtMs: 90 * MINUTE_MS,
        activeStartedAtMs: null,
      });

      assert.equal(decision.action, "terminal");
      if (decision.action === "terminal") {
        assert.equal(decision.terminalState, state);
      }
    }
  });
});

describe("mineruClient local file_parse", function () {
  let originalFetch: typeof fetch;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    resetMineruLocalFileParseGateForTests();
    setupLocalMineruClientTest({
      "/tmp/paper.pdf": "%PDF-1.7",
      "/tmp/paper-2.pdf": "%PDF-1.7",
    });
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    resetMineruLocalFileParseGateForTests();
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
    delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
    delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
  });

  it("retries a transient local HTTP 409 and parses the successful retry", async function () {
    setMineruLocalBusyRetryDelaysForTests([1]);
    const progress: string[] = [];
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("busy", { status: 409 });
      }
      return new Response(createMineruZip("# Parsed after busy retry"), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await parsePdfWithMineruLocal(
      "/tmp/paper.pdf",
      "http://127.0.0.1:58659",
      "pipeline",
      (stage) => progress.push(stage),
    );

    assert.equal(callCount, 2);
    assert.equal(result?.mdContent, "# Parsed after busy retry");
    assert.isTrue(
      progress.some((stage) =>
        stage.includes("Local MinerU server is busy; retrying in 1s"),
      ),
    );
  });

  it("stops retrying local HTTP 409 after the bounded retry budget", async function () {
    setMineruLocalBusyRetryDelaysForTests([1, 1]);
    const progress: string[] = [];
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("still busy", { status: 409 });
    }) as typeof fetch;

    const result = await parsePdfWithMineruLocal(
      "/tmp/paper.pdf",
      "http://127.0.0.1:58659",
      "pipeline",
      (stage) => progress.push(stage),
    );

    assert.isNull(result);
    assert.equal(callCount, 3);
    assert.include(
      progress[progress.length - 1],
      "Local MinerU server is still busy after 2 retries",
    );
  });

  it("honors abort while waiting to retry local HTTP 409", async function () {
    setMineruLocalBusyRetryDelaysForTests([1000]);
    const controller = new AbortController();
    globalThis.fetch = (async () =>
      new Response("busy", { status: 409 })) as typeof fetch;

    let thrown: unknown = null;
    try {
      await parsePdfWithMineruLocal(
        "/tmp/paper.pdf",
        "http://127.0.0.1:58659",
        "pipeline",
        (stage) => {
          if (stage.includes("Local MinerU server is busy")) {
            controller.abort();
          }
        },
        controller.signal,
      );
    } catch (error) {
      thrown = error;
    }

    assert.instanceOf(thrown, MineruCancelledError);
  });

  it("serializes concurrent local file_parse submissions in this process", async function () {
    let fetchCount = 0;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    let releaseFirstFetch: (() => void) | null = null;
    let firstFetchStarted: (() => void) | null = null;
    const firstFetchStartedPromise = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });

    globalThis.fetch = (() => {
      fetchCount++;
      activeFetches++;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      const markdown = `# Parsed ${fetchCount}`;
      const finish = () => {
        activeFetches--;
        return new Response(createMineruZip(markdown), { status: 200 });
      };
      if (fetchCount === 1) {
        firstFetchStarted?.();
        return new Promise<Response>((resolve) => {
          releaseFirstFetch = () => resolve(finish());
        });
      }
      return Promise.resolve(finish());
    }) as typeof fetch;

    const firstParse = parsePdfWithMineruLocal(
      "/tmp/paper.pdf",
      "http://127.0.0.1:58659",
      "pipeline",
    );
    await firstFetchStartedPromise;

    const secondParse = parsePdfWithMineruLocal(
      "/tmp/paper-2.pdf",
      "http://127.0.0.1:58659",
      "pipeline",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(fetchCount, 1);
    releaseFirstFetch?.();
    const [firstResult, secondResult] = await Promise.all([
      firstParse,
      secondParse,
    ]);

    assert.equal(maxActiveFetches, 1);
    assert.equal(fetchCount, 2);
    assert.equal(firstResult?.mdContent, "# Parsed 1");
    assert.equal(secondResult?.mdContent, "# Parsed 2");
  });
});
