import { assert } from "chai";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "./liveAgentCredentials";

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";

/**
 * The six acceptance scenarios, run against a real library with a real model.
 *
 * These are the maintainer's own yardstick and the reason the capability work
 * happened at all. Each one asserts Zotero's database, never the agent's
 * prose, and each reports what actually landed rather than pass/fail alone —
 * a scenario that half-works is the interesting case.
 *
 * Scenario 2 (highlight a PDF title in red and annotate it) is deliberately
 * absent: annotations were deferred, and nothing turns "the title on page 1"
 * into PDF rectangles yet.
 */
describe("acceptance scenarios, live", function () {
  this.timeout(600000);

  const SUFFIX = `acc${Date.now()}`;
  const created = {
    items: [] as number[],
    collections: [] as number[],
    tags: [] as string[],
  };
  const report: string[] = [];
  const traces: string[] = [];
  let creds: LiveAgentCredentials | null = null;

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  async function ensureCredentials(): Promise<boolean> {
    creds = await resolveLiveAgentCredentials();
    return Boolean(creds);
  }

  async function runTurn(userText: string) {
    const api = Zotero.LLMForZotero?.api?.agent;
    assert.isOk(api, "agent API must be installed");
    const toolCalls: string[] = [];
    const contractStates: string[] = [];
    const receipts: string[] = [];
    const conversationKey = Math.floor(Math.random() * 1_000_000) + 700_000;

    const result = await api.runTurn(
      {
        conversationKey,
        mode: "agent",
        conversationKind: "global",
        userText,
        libraryID: libraryID(),
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
      },
      (event: any) => {
        if (event?.type === "tool_call" && event.name)
          toolCalls.push(event.name);
        if (
          event?.type === "provider_event" &&
          event.providerType === "agent_action_contract"
        ) {
          contractStates.push(JSON.stringify(event.payload || {}));
        }
        if (event?.type === "tool_result" && event.receipt) {
          receipts.push(JSON.stringify(event.receipt));
        }
        if (event?.type === "confirmation_required" && event.requestId) {
          void api.resolveConfirmation(event.requestId, true);
        }
      },
    );
    const answer =
      result?.kind === "completed" ? String(result.text || "") : "";
    traces.push(
      `PROMPT: ${userText}\n  TOOLS: ${toolCalls.join(" → ") || "(none)"}\n  OUTCOME: ${result?.kind}\n  CONTRACT: ${contractStates.join(" → ") || "(none)"}\n  RECEIPTS: ${receipts.join(" → ") || "(none)"}\n  ANSWER: ${answer.slice(0, 1200) || "(empty)"}`,
    );
    return { result, toolCalls };
  }

  function note(scenario: string, verdict: string, detail: string) {
    report.push(`${scenario}\n  VERDICT: ${verdict}\n  ${detail}`);
  }

  async function seedPaper(title: string, opts: { year?: string } = {}) {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID();
    item.setField("title", title);
    item.setField("date", opts.year || "2023");
    item.setCreators([
      { creatorType: "author", firstName: "A", lastName: "Author" },
    ]);
    await item.saveTx();
    created.items.push(item.id);
    return item;
  }

  async function collectionsNamed(prefix: string) {
    return Zotero.Collections.getByLibrary(libraryID()).filter((c: any) =>
      String(c.name).includes(prefix),
    );
  }

  before(async function () {
    if (!(await ensureCredentials())) this.skip();
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
    try {
      await Zotero.File.putContentsAsync(
        "/tmp/llm-for-zotero-acceptance-report.txt",
        report.join("\n\n"),
      );
      await Zotero.File.putContentsAsync(
        "/tmp/llm-for-zotero-acceptance-transcript.txt",
        traces.join("\n\n"),
      );
    } catch {
      /* best effort */
    }
  });

  // ── Scenario 1: issue #374 ────────────────────────────────────────────────

  it("1. saves an answer as a note into a named collection, and files matching papers there", async function () {
    const folder = `Acc1-${SUFFIX}`;
    const match = await seedPaper(`Hippocampal replay ${SUFFIX}`);
    const other = await seedPaper(`Unrelated turbine study ${SUFFIX}`);

    const { toolCalls } = await runTurn(
      `Create a collection called "${folder}". Write a short standalone note into it summarising what replay is. Then find papers in my library whose title contains "${SUFFIX}" and are about hippocampal replay, and file those into "${folder}" as well.`,
    );

    const [collection] = await collectionsNamed(folder);
    assert.isOk(
      collection,
      `collection missing. Tools: ${toolCalls.join(", ")}`,
    );
    created.collections.push(collection.id);

    const memberIds: number[] = collection.getChildItems(true) || [];
    for (const id of memberIds) created.items.push(id);
    const members = memberIds.map((id: number) => Zotero.Items.get(id));
    const notes = members.filter((i: any) => i?.isNote?.());
    const papers = members.filter((i: any) => i?.isRegularItem?.());

    note(
      "Scenario 1 — note into a named collection, plus filing",
      notes.length >= 1 && papers.length >= 1 ? "PASS" : "PARTIAL",
      `collection created; ${notes.length} note(s), ${papers.length} paper(s) filed. Tools: ${toolCalls.join(" → ")}`,
    );

    // The core of #374: a note the agent wrote actually lives in the folder.
    assert.isAtLeast(
      notes.length,
      1,
      `no note in the collection. Tools: ${toolCalls.join(", ")}`,
    );
    assert.isAtLeast(
      papers.length,
      1,
      `no paper filed. Tools: ${toolCalls.join(", ")}`,
    );
    assert.include(
      papers.map((p: any) => Number(p.id)),
      match.id,
      "the matching paper should be the one filed",
    );
    void other;
  });

  // ── Scenario 3: a frozen tag vocabulary applied across papers ─────────────

  it("3. derives a small tag vocabulary and applies it across every paper", async function () {
    const marker = `Acc3-${SUFFIX}`;
    const papers = [];
    for (const topic of [
      "Place cells and spatial coding",
      "Synaptic plasticity in cortex",
      "Reinforcement learning in basal ganglia",
      "Working memory maintenance",
      "Sleep replay consolidation",
    ]) {
      papers.push(await seedPaper(`${topic} [${marker}]`));
    }

    const { toolCalls } = await runTurn(
      `Look at the papers whose title contains "${marker}". Decide on exactly 3 topic tags that describe this set, then tag every one of those papers with the tags that apply. Use the same 3 tags across the whole set — do not invent extra tags per paper.`,
    );

    const tagSets = papers.map((paper) => {
      const fresh = Zotero.Items.get(paper.id);
      return (fresh.getTags() || []).map((t: { tag: string }) => t.tag);
    });
    const distinct = new Set(tagSets.flat());
    for (const tag of distinct) created.tags.push(tag);
    const taggedCount = tagSets.filter((tags) => tags.length > 0).length;

    note(
      "Scenario 3 — a frozen tag vocabulary applied library-wide",
      taggedCount === papers.length && distinct.size <= 5 ? "PASS" : "PARTIAL",
      `${taggedCount}/${papers.length} papers tagged with ${distinct.size} distinct tags: ${[...distinct].join(", ")}. Tools: ${toolCalls.join(" → ")}`,
    );

    assert.isAtLeast(
      taggedCount,
      Math.ceil(papers.length * 0.6),
      `most papers must be tagged. Got ${taggedCount}/${papers.length}. Tools: ${toolCalls.join(", ")}`,
    );
    // The old failure was drift: each batch inventing its own tags.
    assert.isAtMost(
      distinct.size,
      6,
      `the vocabulary must stay small, got ${distinct.size}: ${[...distinct].join(", ")}`,
    );
  });

  // ── Scenario 4: reorganize into topic collections, TRUE move ─────────────

  it("4. reorganizes papers into topic collections, actually moving them", async function () {
    const marker = `Acc4-${SUFFIX}`;
    const origin = new Zotero.Collection();
    origin.libraryID = libraryID();
    origin.name = `Acc4-Origin-${SUFFIX}`;
    await origin.saveTx();
    created.collections.push(origin.id);

    const papers = [];
    for (const topic of [
      "Deep learning for image segmentation",
      "Convolutional networks for vision",
      "Hippocampal place field remapping",
      "Grid cells in entorhinal cortex",
    ]) {
      const paper = await seedPaper(`${topic} [${marker}]`);
      paper.addToCollection(origin.id);
      await paper.saveTx();
      papers.push(paper);
    }

    const { toolCalls } = await runTurn(
      `The collection "Acc4-Origin-${SUFFIX}" contains 4 papers. Sort them into exactly 2 new topic collections by subject, named "Acc4-Vision-${SUFFIX}" and "Acc4-Navigation-${SUFFIX}". MOVE each paper into its topic collection so it is no longer in "Acc4-Origin-${SUFFIX}".`,
    );

    for (const c of await collectionsNamed(`Acc4-`)) {
      if (!created.collections.includes(c.id)) created.collections.push(c.id);
    }

    const stillInOrigin: number[] = origin.getChildItems(true) || [];
    const placed = papers.filter((paper) => {
      const ids: number[] = Zotero.Items.get(paper.id).getCollections() || [];
      return ids.some((id) => id !== origin.id);
    });

    note(
      "Scenario 4 — topic collections with true move",
      placed.length === papers.length && stillInOrigin.length === 0
        ? "PASS"
        : "PARTIAL",
      `${placed.length}/${papers.length} papers placed in a topic collection; ${stillInOrigin.length} still left in the origin. Tools: ${toolCalls.join(" → ")}`,
    );

    assert.isAtLeast(
      placed.length,
      Math.ceil(papers.length * 0.75),
      `most papers must be placed. Tools: ${toolCalls.join(", ")}`,
    );
    // This is the whole point of Stage 0g: a move must empty the source.
    assert.equal(
      stillInOrigin.length,
      0,
      `a move must leave the origin empty; ${stillInOrigin.length} remain. Tools: ${toolCalls.join(", ")}`,
    );
  });

  // ── Scenario 5: import from OpenAlex into a new collection ───────────────

  it("5. imports papers found online into a new collection", async function () {
    const folder = `Acc5-${SUFFIX}`;
    const { toolCalls } = await runTurn(
      `Search the literature online for papers about hippocampal replay, then import the 3 most relevant into a new Zotero collection called "${folder}".`,
    );

    const [collection] = await collectionsNamed(folder);
    const memberIds: number[] = collection
      ? collection.getChildItems(true) || []
      : [];
    if (collection) created.collections.push(collection.id);
    for (const id of memberIds) created.items.push(id);

    note(
      "Scenario 5 — import from an online search into a new collection",
      collection && memberIds.length >= 1 ? "PASS" : "PARTIAL",
      collection
        ? `collection created with ${memberIds.length} imported item(s). Tools: ${toolCalls.join(" → ")}`
        : `collection was not created. Tools: ${toolCalls.join(" → ")}`,
    );

    assert.isOk(
      collection,
      `collection missing. Tools: ${toolCalls.join(", ")}`,
    );
    assert.isAtLeast(
      memberIds.length,
      1,
      `nothing was imported. Tools: ${toolCalls.join(", ")}`,
    );
  });

  // ── Scenario 6: a summary note on each of N recent papers ────────────────

  it("6. writes a summary note onto each of several recent papers", async function () {
    const marker = `Acc6-${SUFFIX}`;
    const papers = [];
    for (let index = 1; index <= 5; index += 1) {
      papers.push(await seedPaper(`Recent study ${index} [${marker}]`));
    }

    const { toolCalls } = await runTurn(
      `Find the 5 papers whose title contains "${marker}" and write a one-sentence summary note on each of them. Write them all in one batch rather than one paper at a time.`,
    );

    let withNotes = 0;
    for (const paper of papers) {
      const fresh = Zotero.Items.get(paper.id);
      const noteIds: number[] = fresh.getNotes() || [];
      for (const id of noteIds) created.items.push(id);
      if (noteIds.length > 0) withNotes += 1;
    }
    const usedBatch = toolCalls.includes("note_write_batch");

    note(
      "Scenario 6 — a summary note on each of N papers",
      withNotes === papers.length ? "PASS" : "PARTIAL",
      `${withNotes}/${papers.length} papers gained a note; batch tool used: ${usedBatch}. Tools: ${toolCalls.join(" → ")}`,
    );

    assert.isAtLeast(
      withNotes,
      Math.ceil(papers.length * 0.8),
      `most papers must gain a note. Got ${withNotes}/${papers.length}. Tools: ${toolCalls.join(", ")}`,
    );
  });
});
