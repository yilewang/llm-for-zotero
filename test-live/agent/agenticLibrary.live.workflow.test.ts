import { assert } from "chai";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "./liveAgentCredentials";

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";

/**
 * Does the agent actually *behave* agentically against a real library?
 *
 * The workflow suite proves each capability works when called directly. This
 * one proves the model can find the right tool, fill it in correctly, and
 * chain one call into the next — with a real model, a real library, and
 * assertions that read Zotero's database rather than the agent's prose.
 *
 * Credentials come from the active Zotero profile, or from the prefs.js path
 * explicitly supplied through LLM_FOR_ZOTERO_LIVE_PROFILE_PATH. They are never
 * written into the repo or logged.
 */
describe("live agentic library operations", function () {
  // Long enough for several real model round trips, short enough that a hung
  // turn is reported rather than swallowing the whole run.
  this.timeout(180000);

  const SUFFIX = `live${Date.now()}`;
  const created = {
    items: [] as number[],
    collections: [] as number[],
    tags: [] as string[],
  };
  let credentialsReady = false;
  // Held only in memory for the duration of the run, and never logged.
  let creds: LiveAgentCredentials | null = null;
  const transcript: string[] = [];

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  /**
   * Finds model credentials in the active profile or in an explicitly supplied
   * profile prefs file. Returns only a boolean; nothing about the key is logged.
   */
  async function ensureCredentials(): Promise<boolean> {
    creds = await resolveLiveAgentCredentials();
    return Boolean(creds);
  }

  /** Runs one real agent turn and returns what it did. */
  async function runTurn(
    userText: string,
    extra: Record<string, unknown> = {},
  ) {
    const api = Zotero.LLMForZotero?.api?.agent;
    assert.isOk(api, "agent API must be installed");
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    const confirmations: string[] = [];
    const contractStates: string[] = [];
    const receipts: string[] = [];
    let finalText = "";
    const conversationKey = Math.floor(Math.random() * 1_000_000) + 900_000;

    assert.isOk(creds, "model credentials must be resolved before a live turn");
    const result = await api.runTurn(
      {
        conversationKey,
        mode: "agent",
        conversationKind: "global",
        userText,
        libraryID: libraryID(),
        // The panel normally fills these from prefs; a direct runTurn has to
        // supply them or the runtime finds no tool-capable adapter and falls
        // back to a plain chat completion.
        model: creds?.model,
        apiBase: creds?.apiBase,
        apiKey: creds?.apiKey,
        providerProtocol: creds?.providerProtocol,
        ...(creds?.reasoningLevel
          ? {
              reasoning: {
                provider: "deepseek",
                level: creds.reasoningLevel,
              },
            }
          : {}),
        ...extra,
      },
      (event: any) => {
        if (event?.type === "tool_call" && event.name) {
          toolCalls.push({
            name: event.name,
            args: event.arguments ?? event.args,
          });
        }
        // Write tools raise a confirmation card and then WAIT. In the panel a
        // human clicks it; driving runTurn directly there is nobody to, so the
        // turn blocks until the test times out. Approve automatically, which
        // is what this harness is standing in for.
        if (event?.type === "confirmation_required" && event.requestId) {
          confirmations.push(event.action?.title || event.requestId);
          void api.resolveConfirmation(event.requestId, true);
        }
        if (
          event?.type === "provider_event" &&
          event.providerType === "agent_action_contract"
        ) {
          contractStates.push(JSON.stringify(event.payload || {}));
        }
        if (event?.type === "tool_result" && event.receipt) {
          receipts.push(JSON.stringify(event.receipt));
        }
        if (event?.type === "message_delta" && typeof event.text === "string") {
          finalText += event.text;
        }
      },
    );

    const names = toolCalls.map((call) => call.name);
    // The runtime returns the whole answer; deltas are only for streaming UI.
    const answer =
      result?.kind === "completed" ? String(result.text || "") : finalText;
    transcript.push(
      `PROMPT: ${userText}\n  TOOLS: ${names.join(" → ") || "(none)"}\n  CARDS: ${confirmations.join(" | ") || "(none)"}\n  OUTCOME: ${result?.kind}${
        result?.kind === "fallback" ? ` (${result.reason})` : ""
      }\n  CONTRACT: ${contractStates.join(" → ") || "(none)"}\n  RECEIPTS: ${receipts.join(" → ") || "(none)"}\n  ANSWER: ${answer.slice(0, 1200) || "(empty)"}`,
    );
    // A fallback means the agent loop never really ran, so every downstream
    // assertion would be measuring the wrong thing.
    assert.notEqual(
      result?.kind,
      "fallback",
      `agent fell back instead of running: ${result?.kind === "fallback" ? result.reason : ""}`,
    );
    return { result, toolCalls, names, finalText: answer, confirmations };
  }

  before(async function () {
    credentialsReady = await ensureCredentials();
    if (!credentialsReady) {
      // Skipping loudly beats a green run that tested nothing.
      this.skip();
    }
    // The agent must be allowed to write without a human clicking each card.
    Zotero.Prefs.set(`${PREF_PREFIX}.agentLibraryWriteMode`, "yolo", true);
  });

  after(async function () {
    for (const id of created.items) {
      try {
        const item = Zotero.Items.get(id);
        if (item) await item.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const id of created.collections) {
      try {
        const c = Zotero.Collections.get(id);
        if (c) await c.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const tag of created.tags) {
      try {
        const tagID = Zotero.Tags.getID(tag);
        if (tagID) await Zotero.Tags.removeFromLibrary(libraryID(), [tagID]);
      } catch {
        /* best effort */
      }
    }
    if (transcript.length) {
      Zotero.debug(`[live-agent] tool usage\n${transcript.join("\n")}`);
      // Also write it out: what the model *chose* is the actual evidence of
      // agentic behaviour, and Zotero.debug does not reach the test runner.
      try {
        await Zotero.File.putContentsAsync(
          "/tmp/llm-for-zotero-live-agent-transcript.txt",
          transcript.join("\n\n"),
        );
      } catch {
        /* best effort */
      }
    }
  });

  async function seedPaper(title: string, year = "2021") {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID();
    item.setField("title", `${title}-${SUFFIX}`);
    item.setField("date", year);
    item.setCreators([
      { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
    ]);
    await item.saveTx();
    created.items.push(item.id);
    return item;
  }

  // ── 1. Can it create a folder and file a paper into it? ───────────────────

  it("creates a collection and files a paper into it, unprompted about tools", async function () {
    const paper = await seedPaper("AgenticFiling");
    const folderName = `AgenticFolder-${SUFFIX}`;

    const { names } = await runTurn(
      `Create a new collection called "${folderName}" and put the paper titled "AgenticFiling-${SUFFIX}" into it.`,
    );

    const collection = Zotero.Collections.getByLibrary(libraryID()).find(
      (c: any) => c.name === folderName,
    );
    assert.isOk(
      collection,
      `the agent had to create "${folderName}". Tools used: ${names.join(", ")}`,
    );
    created.collections.push(collection.id);

    const rows = await Zotero.DB.columnQueryAsync(
      "SELECT collectionID FROM collectionItems WHERE itemID=?",
      [paper.id],
    );
    assert.include(
      (rows || []).map(Number),
      collection.id,
      `the paper must actually be filed. Tools used: ${names.join(", ")}`,
    );
  });

  // ── 2. Chaining: the second step depends on the first ─────────────────────

  it("chains a search into a write without being told the ids", async function () {
    await seedPaper("ChainTarget", "2021");
    const tag = `chain-tag-${SUFFIX}`;
    created.tags.push(tag);

    const { names } = await runTurn(
      `Find the paper whose title contains "ChainTarget-${SUFFIX}" and add the tag "${tag}" to it. Do not ask me for the item ID; look it up yourself.`,
    );

    const tagged = await Zotero.DB.columnQueryAsync(
      `SELECT i.itemID FROM items i
         JOIN itemTags it ON it.itemID = i.itemID
         JOIN tags t ON t.tagID = it.tagID
        WHERE t.name = ?`,
      [tag],
    );
    assert.isAtLeast(
      (tagged || []).length,
      1,
      `the agent had to search then write. Tools used: ${names.join(", ")}`,
    );
  });

  // ── 3. The capability that did not exist: real citations ──────────────────

  it("formats a citation through Zotero rather than inventing one", async function () {
    const paper = await seedPaper("CitationSubject", "1843");

    const { names, finalText } = await runTurn(
      `Give me the APA reference for the paper titled "CitationSubject-${SUFFIX}". Use Zotero's own citation formatting.`,
      { activeItemId: paper.id },
    );

    // The real test is whether it used the tool. A fabricated citation would
    // also contain "Lovelace", so prose alone proves nothing.
    assert.include(
      names,
      "library_cite",
      `the agent must format via Zotero, not from memory. Tools used: ${names.join(", ")}`,
    );
    assert.include(finalText, "Lovelace");
  });

  // ── 4. Item creation from nothing ─────────────────────────────────────────

  it("creates a book by hand, choosing the right item type and fields", async function () {
    const title = `AgenticBook-${SUFFIX}`;
    const { names } = await runTurn(
      `Add a book to my library by hand. Title: "${title}". Author: Marvin Minsky. Publisher: MIT Press. Year: 1969. It has no DOI, so create it manually rather than looking it up.`,
    );

    // Search on a substring, not the exact string: the model chooses the
    // title text, and an exact match would fail on a stray space rather than
    // on the thing under test. If it is missing entirely, report what the
    // model actually produced instead of a bare "expected 0 to be at least 1".
    const search = new Zotero.Search({ libraryID: libraryID() });
    search.addCondition("title", "contains", "AgenticBook");
    const ids: number[] = await search.search();
    const titles = (ids || []).map((id: number) =>
      String(Zotero.Items.get(id)?.getField("title") || ""),
    );
    const mine = (ids || []).filter((id: number) =>
      String(Zotero.Items.get(id)?.getField("title") || "").includes(SUFFIX),
    );

    assert.isAtLeast(
      mine.length,
      1,
      `the book must exist. Tools used: ${names.join(", ")}. Titles found containing "AgenticBook": ${JSON.stringify(titles)}`,
    );
    const item = Zotero.Items.get(mine[0]);
    created.items.push(item.id);
    assert.equal(
      Zotero.ItemTypes.getName(item.itemTypeID),
      "book",
      `it had to choose the book item type. Tools used: ${names.join(", ")}`,
    );
    assert.equal(item.getField("publisher"), "MIT Press");
  });

  // ── 5. True move, the acceptance-scenario-4 shape ─────────────────────────

  it("moves a paper between collections instead of copying it", async function () {
    const from = new Zotero.Collection();
    from.libraryID = libraryID();
    from.name = `MoveFrom-${SUFFIX}`;
    await from.saveTx();
    created.collections.push(from.id);

    const to = new Zotero.Collection();
    to.libraryID = libraryID();
    to.name = `MoveTo-${SUFFIX}`;
    await to.saveTx();
    created.collections.push(to.id);

    const paper = await seedPaper("MoveSubject");
    paper.addToCollection(from.id);
    await paper.saveTx();

    const { names } = await runTurn(
      `Move the paper titled "MoveSubject-${SUFFIX}" out of the collection "MoveFrom-${SUFFIX}" and into "MoveTo-${SUFFIX}". It should end up only in the destination.`,
    );

    const rows = (
      (await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID=?",
        [paper.id],
      )) || []
    ).map(Number);

    assert.include(
      rows,
      to.id,
      `must land in the destination. Tools: ${names.join(", ")}`,
    );
    assert.notInclude(
      rows,
      from.id,
      `a move must not leave it in the source. Tools: ${names.join(", ")}`,
    );
  });

  // ── 6. Batch notes: acceptance scenario 6, in miniature ───────────────────

  it("writes a note onto several papers in one batch", async function () {
    const papers = [];
    for (const name of ["BatchNoteA", "BatchNoteB", "BatchNoteC"]) {
      papers.push(await seedPaper(name));
    }

    const { names } = await runTurn(
      `Write a one-sentence summary note on each of these three papers: "BatchNoteA-${SUFFIX}", "BatchNoteB-${SUFFIX}", "BatchNoteC-${SUFFIX}". Write all of them in one batch rather than one at a time.`,
    );

    let withNotes = 0;
    for (const paper of papers) {
      const fresh = Zotero.Items.get(paper.id);
      const noteIds = fresh.getNotes() || [];
      for (const id of noteIds) created.items.push(id);
      if (noteIds.length > 0) withNotes += 1;
    }
    assert.isAtLeast(
      withNotes,
      2,
      `at least most papers must gain a note. Tools used: ${names.join(", ")}`,
    );
  });

  // ── 7. Does it use the search vocabulary it now has? ──────────────────────

  it("answers a full-text-shaped question with an advanced search", async function () {
    await seedPaper("AdvancedSearchSubject", "2015");

    const { names } = await runTurn(
      `How many items in my library were added to Zotero in the last 30 days? Use an advanced search condition rather than listing everything.`,
    );

    assert.include(
      names,
      "library_search",
      `it must search rather than guess. Tools used: ${names.join(", ")}`,
    );
  });
});
