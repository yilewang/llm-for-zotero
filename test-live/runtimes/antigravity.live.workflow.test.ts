import { assert } from "chai";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";
import { env } from "./runtimeLiveShared";
import type {
  AntigravityTurnResult,
  AntigravityTurnScenario,
} from "../../src/modules/contextPanel/antigravityTurnReplay";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;

/**
 * Antigravity turns against the installed agy (Phase 7), through the real
 * panel, agent engine, turn host, transport, and ACP client.
 *
 * Spends a little Antigravity quota and adds a few sessions to the local
 * agy history, so it runs only when asked for by name:
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/runtimes \
 *   LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS=antigravity \
 *     node scripts/run-workflow-tests.mjs --agent-live
 */
const enabled = env("LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS")
  .split(",")
  .includes("antigravity");
/**
 * L3 needs a Zotero that answers on its HTTP port, because agy calls the
 * Zotero MCP server over HTTP. The scaffold's test Zotero opens the port but
 * never answers (2026-11-18: even /connector/ping times out), and agy waits
 * on an unanswered MCP call without a timeout, so L3 runs only when
 * LLM_FOR_ZOTERO_LIVE_ZOTERO_HTTP=1 says the Zotero under test serves HTTP.
 */
const zoteroServesHttp = env("LLM_FOR_ZOTERO_LIVE_ZOTERO_HTTP") === "1";

describe("live: Antigravity on the installed agy", function () {
  this.timeout(300_000);

  const RED_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";

  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let panelId = "";

  before(async function () {
    if (!enabled) this.skip();
    api = (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
  });

  beforeEach(async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Antigravity live fixture: lantern harbors",
      pages: ["A disposable paper about lantern harbors for live tests."],
    });
    panelId = (await api.renderPanelForItem(fixture.parentItemId)).panelId;
  });

  afterEach(async function () {
    await api.resetAntigravityReplay();
    await api.cleanupFixture(fixture);
  });

  after(async function () {
    await api.reset();
  });

  function run(
    scenario: Omit<AntigravityTurnScenario, "createChild">,
  ): Promise<AntigravityTurnResult> {
    return api.exerciseAntigravityTurn({ panelId, scenario });
  }

  function summary(result: AntigravityTurnResult): string {
    return JSON.stringify({
      outcomeKind: result.outcomeKind,
      outcomeText: result.outcomeText,
      confirmations: result.confirmations,
      deliveredEvents: result.deliveredEvents,
    });
  }

  it("L1 answers, saves the agy session, and announces agy's commands", async function () {
    const result = await run({
      question: "Reply with exactly the word READY and nothing else.",
    });
    assert.equal(result.outcomeKind, "completed", summary(result));
    assert.match(result.outcomeText, /READY/, summary(result));
    assert.isString(result.storedSessionId);
    assert.include(result.slashCommands, "compact");
  });

  it("L2 resumes the chat's agy session in a fresh agy process", async function () {
    const first = await run({
      question:
        "Remember the code word TEAL-OTTER-31 for later. Reply with only OK.",
    });
    assert.equal(first.outcomeKind, "completed", summary(first));
    const second = await run({
      question:
        "What code word did I ask you to remember? Reply with the code word only.",
      conversationKey: first.conversationKey,
      newProcess: true,
    });
    assert.equal(second.outcomeKind, "completed", summary(second));
    assert.equal(second.processes, 2);
    assert.equal(second.storedSessionId, first.storedSessionId);
    assert.match(second.outcomeText, /TEAL-OTTER-31/, summary(second));
  });

  it("L3 reads the Zotero library through the Zotero MCP server over HTTP", async function () {
    if (!zoteroServesHttp) this.skip();
    const result = await run({
      question:
        "Use the Zotero library_search tool to search my Zotero library for 'lantern harbors'. Reply with the exact title of the item you find.",
      mcp: true,
    });
    assert.equal(result.outcomeKind, "completed", summary(result));
    assert.equal(result.confirmations, 0, summary(result));
    assert.match(result.outcomeText, /lantern harbors/i, summary(result));
  });

  it("L4 runs a picked model with a thinking level", async function () {
    const catalog = await api.loadAntigravityModelCatalogForTests();
    const model = catalog.models.find(
      (entry) => entry.thoughtLevels.length > 0,
    );
    assert.exists(model, JSON.stringify(catalog.models));
    const level = model!.thoughtLevels[0].value;
    const result = await run({
      question: "Reply with exactly the word LEVELLED and nothing else.",
      model: model!.id,
      thoughtLevel: level,
    });
    assert.equal(result.outcomeKind, "completed", summary(result));
    assert.match(result.outcomeText, /LEVELLED/, summary(result));
  });

  it("L5 sees a screenshot", async function () {
    const result = await run({
      question:
        "What single colour fills the attached image? Reply with one word.",
      images: [RED_PNG],
    });
    assert.equal(result.outcomeKind, "completed", summary(result));
    assert.match(result.outcomeText, /red/i, summary(result));
  });

  it("L6 reads an attached file without a review card", async function () {
    const dir = PathUtils.join(
      Zotero.DataDirectory.dir,
      "antigravity-live-attachments",
    );
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const path = PathUtils.join(dir, "harbor notes.txt");
    await IOUtils.writeUTF8(path, "The project codename is HARBOR-LANTERN-42.");
    const result = await run({
      question:
        "What project codename does the attached file give? Reply with the codename only.",
      attachments: [
        {
          id: "live-notes",
          name: "harbor notes.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
          category: "text",
          storedPath: path,
        },
      ],
    });
    assert.equal(result.outcomeKind, "completed", summary(result));
    assert.equal(result.confirmations, 0, summary(result));
    assert.match(result.outcomeText, /HARBOR-LANTERN-42/, summary(result));
  });

  it("L7 asks before a shell command and explains a declined one", async function () {
    const result = await run({
      question:
        "Run the shell command `echo antigravity-live` in the terminal and tell me its output.",
      approve: false,
    });
    assert.isAtLeast(result.confirmations, 1, summary(result));
    assert.notInclude(result.deliveredText, "antigravity-live\n");
  });
});
