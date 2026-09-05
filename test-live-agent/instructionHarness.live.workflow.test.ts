import { assert } from "chai";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "./liveAgentCredentials";

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const REPETITIONS = 3;

type LiveRunRecord = {
  case: "citation" | "verified-note-write";
  repetition: number;
  model: string;
  protocol: string;
  providerHost: string;
  promptHash: string;
  tokenInventory: Record<string, unknown>;
  toolCalls: string[];
  receipts: unknown[];
  outcome: string;
  answerPreview: string;
};

describe("instruction harness live smoke", function () {
  this.timeout(720000);

  const suffix = `harness-${Date.now()}`;
  const records: LiveRunRecord[] = [];
  const createdItemIds: number[] = [];
  let credentials: LiveAgentCredentials | null = null;
  let matrixStatus = "serializer-verified-only";

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  function reportPath(): string {
    const model = String(credentials?.model || "credentials-unavailable")
      .replace(/[^a-z0-9._-]+/gi, "-")
      .slice(0, 80);
    return `/tmp/llm-for-zotero-instruction-harness-${model}.json`;
  }

  function providerHost(): string {
    try {
      return new URL(credentials?.apiBase || "").hostname;
    } catch {
      return "unknown";
    }
  }

  async function writeReport(): Promise<void> {
    const payload = {
      generatedAt: new Date().toISOString(),
      status: matrixStatus,
      model: credentials?.model || "",
      protocol: credentials?.providerProtocol || "",
      providerHost: providerHost(),
      requiredRepetitions: REPETITIONS,
      records,
    };
    await Zotero.File.putContentsAsync(
      reportPath(),
      JSON.stringify(payload, null, 2),
    );
  }

  async function runTurn(params: Record<string, unknown>) {
    const api = Zotero.LLMForZotero?.api?.agent;
    assert.isOk(api, "agent API must be installed");
    const toolCalls: string[] = [];
    const receipts: unknown[] = [];
    let inventory: Record<string, unknown> = {};
    const requestedMetadata =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : {};
    const result = await api.runTurn(
      {
        conversationKey: Math.floor(Math.random() * 1_000_000) + 4_000_000,
        mode: "agent",
        libraryID: libraryID(),
        model: credentials?.model,
        apiBase: credentials?.apiBase,
        apiKey: credentials?.apiKey,
        providerProtocol: credentials?.providerProtocol,
        ...(credentials?.reasoningLevel
          ? {
              reasoning: {
                provider: "deepseek",
                level: credentials.reasoningLevel,
              },
            }
          : {}),
        ...params,
        metadata: {
          ...requestedMetadata,
          instructionHarnessInventory: true,
        },
      },
      (event: any) => {
        if (event?.type === "tool_call" && event.name) {
          toolCalls.push(String(event.name));
        }
        if (event?.type === "tool_result" && event.receipt) {
          receipts.push(event.receipt);
        }
        if (
          event?.type === "provider_event" &&
          event.providerType === "instruction_harness_inventory"
        ) {
          inventory = event.payload || {};
        }
        if (event?.type === "confirmation_required" && event.requestId) {
          void api.resolveConfirmation(event.requestId, true);
        }
      },
    );
    return { result, toolCalls, receipts, inventory };
  }

  before(async function () {
    credentials = await resolveLiveAgentCredentials();
    if (!credentials) {
      await writeReport();
      this.skip();
      return;
    }
    matrixStatus = "live-evaluation-incomplete";
    Zotero.Prefs.set(`${PREF_PREFIX}.agentLibraryWriteMode`, "yolo", true);
  });

  after(async function () {
    for (const itemId of createdItemIds) {
      try {
        const item = Zotero.Items.get(itemId);
        if (item) await item.eraseTx();
      } catch {
        // Best-effort cleanup must not hide the evaluation outcome.
      }
    }
    await writeReport();
  });

  it("passes original-language citation integrity 3/3", async function () {
    const quote = "原文证据显示，神经表征在不同会话之间发生了系统性漂移。";
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = libraryID();
    paper.setField("title", `Instruction harness citation ${suffix}`);
    paper.setField("date", "2026");
    paper.setCreators([
      { creatorType: "author", firstName: "Han", lastName: "Harness" },
    ]);
    await paper.saveTx();
    createdItemIds.push(paper.id);

    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      const { result, toolCalls, receipts, inventory } = await runTurn({
        conversationKind: "paper",
        activeItemId: paper.id,
        userText:
          "Quote the supplied Chinese source sentence exactly once as a Markdown blockquote, cite it according to the source data, and explain its meaning briefly in English. Keep the quotation in Chinese.",
        selectedTexts: [quote],
        selectedTextSources: ["pdf"],
        selectedTextPaperContexts: [
          {
            itemId: paper.id,
            contextItemId: paper.id,
            title: `Instruction harness citation ${suffix}`,
            firstCreator: "Harness",
            year: "2026",
          },
        ],
      });
      const answer =
        result?.kind === "completed" ? String(result.text || "") : "";
      records.push({
        case: "citation",
        repetition,
        model: credentials!.model,
        protocol: credentials!.providerProtocol,
        providerHost: providerHost(),
        promptHash: String(inventory.promptHash || ""),
        tokenInventory: inventory,
        toolCalls,
        receipts,
        outcome: String(result?.kind || "unknown"),
        answerPreview: answer.slice(0, 1200),
      });

      assert.equal(result?.kind, "completed");
      assert.include(answer, `> ${quote}`);
      assert.equal(answer.split(quote).length - 1, 1);
      assert.match(answer, /\[\[quote:[^\]]+\]\]|\(Harness, 2026\)/);
      assert.match(String(inventory.promptHash || ""), /^fnv1a32-[0-9a-f]{8}$/);
      assert.isAbove(Number(inventory.providerBoundTokens || 0), 0);
    }
  });

  it("passes verified Zotero note mutations 3/3", async function () {
    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      const marker = `${suffix}-note-${repetition}`;
      const { result, toolCalls, receipts, inventory } = await runTurn({
        conversationKind: "global",
        userText: `Create a new standalone Zotero note with the heading "Instruction Harness ${repetition}" and include this exact marker in its body: ${marker}`,
      });
      const allItems = await Zotero.Items.getAll(
        libraryID(),
        false,
        false,
        false,
      );
      const note = allItems.find(
        (item: any) =>
          item?.isNote?.() && String(item.getNote?.() || "").includes(marker),
      );
      if (note?.id) createdItemIds.push(note.id);
      const verifiedReceipt = receipts.find(
        (receipt: any) =>
          receipt?.capability === "zotero.notes" &&
          receipt?.verification === "verified" &&
          ["applied", "already_satisfied"].includes(receipt?.status),
      );
      const answer =
        result?.kind === "completed" ? String(result.text || "") : "";
      records.push({
        case: "verified-note-write",
        repetition,
        model: credentials!.model,
        protocol: credentials!.providerProtocol,
        providerHost: providerHost(),
        promptHash: String(inventory.promptHash || ""),
        tokenInventory: inventory,
        toolCalls,
        receipts,
        outcome: String(result?.kind || "unknown"),
        answerPreview: answer.slice(0, 1200),
      });

      assert.equal(result?.kind, "completed");
      assert.isOk(note, `note with marker ${marker} was not persisted`);
      assert.isOk(
        verifiedReceipt,
        "note write did not return a verified receipt",
      );
      assert.match(String(inventory.promptHash || ""), /^fnv1a32-[0-9a-f]{8}$/);
    }
    matrixStatus = "single-provider-live-smoke-verified";
  });
});
