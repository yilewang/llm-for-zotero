import {
  semanticWorkflow,
  ordinaryMoveWorkflow,
  createdDestinationWorkflow,
  preparedActionCases,
} from "./semanticWorkflow";
import { SemanticIntentService } from "../src/agent/model/semanticIntentService";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { getAllSkills } from "../src/agent/skills";
import type { AgentRuntimeRequestInput } from "../src/agent/types";
import { assertExact, check, type StepOutcome } from "./core";
import { catalog } from "./catalog";
import { LiveDriver, requireReceipt, type Turn, type Writer } from "./driver";
import {
  snapshot,
  onlyChanges,
  itemKey,
  collectionKey,
  exactFieldChange,
  type Fixtures,
  type NativeState,
} from "./native";
import { researchJourney } from "./research";
import {
  assertConversationSummary,
  assertHumanCitationLabels,
} from "./oracles";
import { loadPlanDocument } from "../src/agent/documents/store";
import { getRuntimeReasoningOptionsForModel } from "../src/utils/reasoningProfiles";

declare const Zotero: any;
declare const Services: any;
export type JourneyContext = {
  fixtures: Fixtures;
  driver: LiveDriver;
  write: Writer;
  harness: any;
  request: any;
  childNote?: any;
};

function paperRequest(
  item: any,
  attachment?: number,
): Partial<AgentRuntimeRequestInput> {
  return {
    conversationKey: item.id,
    conversationKind: "paper",
    scopeType: "paper",
    activeItemId: item.id,
    item,
    activePaperContext: {
      libraryID: item.libraryID,
      itemId: item.id,
      contextItemId: attachment || item.id,
      title: item.getField("title"),
    },
  };
}

async function notes(item: any) {
  await item.reload(undefined, true);
  return (item.getNotes() as number[]).map((id) => Zotero.Items.get(id));
}

function noteContent(note: any, minLength = 150) {
  const text = String(note.getNote()).replace(/<[^>]*>/g, " ");
  check(text.trim().length >= minLength, "Saved note has insufficient content");
  check(
    !/\b(placeholder|content pending|insert summary here|generating\.\.\.)\b/i.test(
      text,
    ),
    "Saved note contains a placeholder",
  );
  return text;
}

function permitNewChild(before: NativeState, after: NativeState, item: any) {
  onlyChanges(
    before,
    after,
    (row) =>
      !row.before &&
      row.after?.itemType === "note" &&
      row.after.parentItem === item.key &&
      row.after.libraryID === item.libraryID,
  );
}

export async function executeJourneyStep(
  id: string,
  ctx: JourneyContext,
): Promise<StepOutcome | void> {
  const { fixtures: f, driver, harness, write } = ctx;
  const spec = catalog.find((row) => row.id === id)!;
  const before = await snapshot();
  await write(`${id}/before.json`, before);
  const run = (
    prompt: string,
    request: Partial<AgentRuntimeRequestInput> = {},
    expected: "none" | "approval" | "cancel" | "review" = "none",
  ) => driver.turn(id, prompt, spec.mode, request, expected);
  let outcome: StepOutcome | void = undefined;
  try {
    if (id === "semantic.create-file") {
      await createdDestinationWorkflow(ctx);
    } else if (id === "semantic.action-cases") {
      await preparedActionCases(ctx);
    } else if (id === "semantic.move") {
      await ordinaryMoveWorkflow(ctx);
    } else if (
      id === "semantic.compound" ||
      id === "semantic.compound-plan" ||
      id === "semantic.compound-resume" ||
      id === "semantic.compound-revise" ||
      id === "semantic.compound-implicit" ||
      id === "semantic.compound-clarified"
    ) {
      await semanticWorkflow(id, ctx);
    } else if (id === "paper.conversation") {
      await harness.openStandaloneForItem(f.items.primary.id);
      await harness.clickStandaloneTab("paper");
      const reasoningOption = getRuntimeReasoningOptionsForModel(
        "deepseek",
        driver.creds.model,
      ).find((option) => option.level === driver.creds.reasoningLevel);
      check(
        reasoningOption,
        `No DeepSeek reasoning option for ${driver.creds.reasoningLevel}`,
      );
      await harness.clickStandaloneReasoningOption(reasoningOption.label);
      harness.enableLiveAgentSending();
      const prompts = [
        "Read this synthetic test paper. What is its hypothesis? Explain amber-readout and remember it for our discussion.",
        "What are the methods and cobalt-control? Use the paper as evidence. Also remember our discussion-only decision: I propose a follow-up called teal-extension using 23 sessions. That proposal is ours, not a result in the paper.",
        "Explain the described Figure 1, violet-trajectory. Distinguish the textual description from an actual extracted image.",
        "Explain the quantitative silver-result. Compare intact and shuffled decoding.",
        "What is the copper-limitation, and what claims are not supported? In this conversation only, remember our discussion-only caution as ochre-no-causality; keep it distinct from the paper's labels. Do not create or edit notes or files yet.",
        "What is the jade-implication? Relate it to the hypothesis and methods from our earlier discussion.",
      ];
      for (const prompt of prompts) {
        const turn = await driver.turn(
          id,
          prompt,
          "auto",
          paperRequest(f.items.primary, f.primary.pdfAttachmentId),
          "none",
          () => harness.askStandalone(prompt),
        );
        check(
          turn.events.some((event) => event.type === "tool_call") ||
            prompts.indexOf(prompt) > 0,
          "Initial paper question did not call a tool",
        );
      }
      assertExact(
        await snapshot(),
        before,
        "Read-only six-round paper conversation",
      );
      await harness.captureStandaloneScreenshot(
        `${ctx.request.reportDir}/${id}/conversation.png`,
      );
      await write(`${id}/ui.json`, await harness.getStandaloneDiagnostics());
    } else if (id === "paper.child-note") {
      const prior = (await notes(f.items.primary)).map((note) => note.id);
      const prompt =
        "Summarize our entire six-round conversation into one child note on this paper. Include six sections named Hypothesis, Methods, Figure, Results, Limitations, Implications, preserving the key facts, the paper's named concepts, and our discussion-only follow-up decision and caution. In each section include one exact quotation from the paper followed by its author-year citation. Clearly distinguish our proposals from the paper's results. Save the complete final content, not a placeholder.";
      const turn = await driver.turn(
        id,
        prompt,
        "auto",
        paperRequest(f.items.primary, f.primary.pdfAttachmentId),
        "none",
        () => harness.askStandalone(prompt),
      );
      const added = (await notes(f.items.primary)).filter(
        (note) => !prior.includes(note.id),
      );
      assertExact(added.length, 1, "Number of new child notes");
      await added[0].reload(undefined, true);
      const text = noteContent(added[0], 500);
      assertConversationSummary(text);
      requireReceipt(turn);
      permitNewChild(before, await snapshot(), f.items.primary);
      ctx.childNote = added[0];
      await write(`${id}/note.html`, added[0].getNote(), true);
    } else if (id === "paper.document-view") {
      // A new-note request must not manufacture a duplicate document. Request
      // the separate document explicitly when testing that separate surface.
      const prompt = `Write a research document from saved note ${ctx.childNote.id} and our six-round conversation. Keep its six sections, include one exact quotation from the paper with an author-year citation in each section, and preserve our discussion-only proposals as such. Publish the document in chat; do not create or edit any Zotero notes or files.`;
      await driver.turn(
        id,
        prompt,
        "auto",
        paperRequest(f.items.primary, f.primary.pdfAttachmentId),
        "none",
        () => harness.askStandalone(prompt),
      );
      const chatDoc = Zotero.LLMForZotero.data.standaloneWindow
        .document as Document;
      const card = (
        Array.from(
          chatDoc.querySelectorAll(".llm-plan-document-card"),
        ) as HTMLElement[]
      ).at(-1);
      check(
        card?.dataset.llmPlanDocumentId,
        "The final answer did not render a generated document card",
      );
      const document = await loadPlanDocument(card.dataset.llmPlanDocumentId);
      check(document, "Generated document is not durable");
      const labels = (root: Element) =>
        [...root.querySelectorAll(".llm-quote-card-citation")].map(
          (node) => node?.textContent || "",
        );
      const panel = await harness.renderPanelForItem(f.items.primary.id);
      const regular = await harness.renderAssistantForPanel(panel.panelId, {
        text: document.visibleMarkdown,
      });
      await write(`${id}/regular-chat.json`, regular);
      assertHumanCitationLabels(regular.quoteCardCitationTexts, 6);
      assertHumanCitationLabels(
        labels(card.querySelector(".llm-plan-document-content")!),
        6,
      );
      await write(`${id}/inline.html`, card.innerHTML, true);
      card
        .querySelector<HTMLButtonElement>(".llm-plan-document-action-expand")!
        .click();
      let documentWindow: Window | undefined;
      const deadline = Date.now() + 10000;
      try {
        while (Date.now() < deadline) {
          const windows = Services.wm.getEnumerator(null);
          while (windows.hasMoreElements()) {
            const win = windows.getNext() as Window;
            if (
              win.document.getElementById(
                "llmforzotero-standalone-plan-document-root",
              )
            )
              documentWindow = win;
          }
          if (documentWindow?.document.querySelector(".llm-quote-card")) break;
          await Zotero.Promise.delay(25);
        }
        check(documentWindow, "Larger document view did not open");
        const root = documentWindow.document.getElementById(
          "llmforzotero-standalone-plan-document-root",
        )!;
        assertHumanCitationLabels(labels(root), 6);
        const quote = root.querySelector<HTMLElement>(".llm-quote-card")!;
        const expanded = quote.dataset.expanded;
        quote.querySelector<HTMLElement>(".llm-quote-card-content")!.click();
        check(
          quote.dataset.expanded !== expanded,
          "Document quote expansion did not respond",
        );
        await write(`${id}/standalone.html`, root.innerHTML, true);
        assertExact(
          await snapshot(),
          before,
          "Document viewing must not mutate Zotero",
        );
      } finally {
        documentWindow?.close();
      }
    } else if (id === "paper.standalone-note") {
      const turn = await run(
        `Create exactly one standalone version of note ${ctx.childNote.id} and file it in the collection named "${f.collections.notes.name}". Preserve all six sections.`,
        paperRequest(f.items.primary, f.primary.pdfAttachmentId),
      );
      const children = f.collections.notes
        .getChildItems(false)
        .filter((item: any) => item.isNote() && !item.parentID);
      assertExact(
        children.length,
        1,
        "Standalone notes in requested collection",
      );
      noteContent(children[0], 500);
      requireReceipt(turn);
      onlyChanges(
        before,
        await snapshot(),
        (row) =>
          !row.before &&
          row.after?.itemType === "note" &&
          !row.after.parentItem &&
          row.after.collections?.includes(f.collections.notes.key),
      );
      await write(`${id}/note.html`, children[0].getNote(), true);
    } else if (id === "paper.edit-note") {
      const prior = ctx.childNote.getNote();
      check(
        prior.includes("copper-limitation"),
        "Exact edit anchor is absent from the saved note",
      );
      const turn = await run(
        `In note ${ctx.childNote.id}, replace only the exact text "copper-limitation" with "copper-limitation (reviewed)". Preserve every other character and section.`,
        paperRequest(f.items.primary, f.primary.pdfAttachmentId),
      );
      await ctx.childNote.reload(undefined, true);
      assertExact(
        ctx.childNote.getNote(),
        prior.replace("copper-limitation", "copper-limitation (reviewed)"),
        "Targeted note edit",
      );
      requireReceipt(turn);
      onlyChanges(
        before,
        await snapshot(),
        (row) => row.key === itemKey(ctx.childNote),
      );
    } else if (id === "paper.obsidian") {
      const path = `${ctx.request.reportDir}/vault/conversation.md`;
      const turn = await run(
        `Read saved note ${ctx.childNote.id} and export its complete content as Markdown to "${path}". This is the authorized disposable Obsidian vault directory. Preserve all six sections; save the actual file.`,
        paperRequest(f.items.primary, f.primary.pdfAttachmentId),
      );
      const content = await Zotero.File.getContentsAsync(path);
      check(content.length > 500, "Obsidian Markdown missing or truncated");
      for (const section of [
        "hypothesis",
        "methods",
        "figure",
        "results",
        "limitations",
        "implications",
      ])
        check(
          content.toLowerCase().includes(section),
          `Export lost ${section}`,
        );
      requireReceipt(turn);
      assertExact(await snapshot(), before, "Export must not mutate library");
    } else if (id === "paper.figures") {
      const collection = Zotero.Collections.getByLibrary(
        f.libraryID,
        true,
      ).find((c: any) => c.name === ctx.request.collection);
      const paper = collection
        ?.getChildItems(false)
        .find(
          (item: any) => item.isRegularItem() && item.getAttachments().length,
        );
      if (!paper)
        return {
          status: "BLOCKED",
          detail: `No real paper with attachment in ${ctx.request.collection}; figure extraction was not exercised.`,
        };
      const attachment = (await paper.getBestAttachment())?.id;
      const path = `${ctx.request.reportDir}/vault/figures.md`;
      const turn = await run(
        `Write a short summary of this paper including one actual cropped figure. Use the figure-analysis pipeline, save the Markdown to "${path}" and copy the cropped figure into that vault using a relative image link. Include a caption and page provenance. Do not edit Zotero or substitute a placeholder.`,
        paperRequest(paper, attachment),
      );
      check(
        turn.events.some(
          (event) =>
            event.type === "tool_call" &&
            event.name === "paper_read" &&
            JSON.stringify(event.args).includes("figures"),
        ),
        "Figure extraction tool path was not invoked",
      );
      const text = String(await Zotero.File.getContentsAsync(path));
      const links = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) =>
        match[1].replace(/^<|>$/g, ""),
      );
      check(links.length, "No Markdown figure image");
      for (const link of links) {
        check(
          !/^(\/|[a-z]+:)|(^|\/)\.\.(\/|$)/i.test(link),
          `Nonportable image link: ${link}`,
        );
        const image = Zotero.File.pathToFile(
          `${ctx.request.reportDir}/vault/${decodeURIComponent(link)}`,
        );
        check(
          image.exists() && image.fileSize > 100,
          `Missing/empty image: ${link}`,
        );
      }
      requireReceipt(turn);
      assertExact(
        await snapshot(),
        before,
        "Figure export is library-read-only",
      );
      outcome = {
        status: "REVIEW_REQUIRED",
        detail:
          "Machine checks passed. Inspect vault/figures.md and cropped images for correct figure boundaries, caption and provenance.",
      };
    } else if (id === "research.review") {
      outcome = await researchJourney(ctx);
    } else if (id === "library.tags") {
      const targets = [f.items.geometry, f.items.memory, f.items.shared];
      const tags = [
        `coding-${f.marker}`,
        `drift-${f.marker}`,
        `memory-${f.marker}`,
      ];
      const turn = await run(
        `Apply exactly these three tags to each of the papers titled ${targets.map((item) => JSON.stringify(item.getField("title"))).join(", ")}: ${tags.join(", ")}. Do not tag any other paper.`,
      );
      const after = await snapshot();
      for (const item of targets)
        assertExact(
          after[itemKey(item)].tags.map((tag: any) => tag.tag).sort(),
          [...tags].sort(),
          `Exact tags on ${item.key}`,
        );
      onlyChanges(before, after, (row) =>
        targets.some(
          (item) =>
            row.key === itemKey(item) &&
            JSON.stringify({ ...row.before, tags: row.after?.tags }) ===
              JSON.stringify(row.after),
        ),
      );
      requireReceipt(turn);
    } else if (id === "semantic.transport") {
      const item = f.items.geometry;
      const request = resolveAgentRuntimeRequest({
        conversationKey: item.id,
        mode: "agent",
        libraryID: item.libraryID,
        authMode: "api_key",
        model: driver.creds.model,
        apiBase: driver.creds.apiBase,
        apiKey: driver.creds.apiKey,
        providerProtocol: driver.creds
          .providerProtocol as AgentRuntimeRequestInput["providerProtocol"],
        reasoning: {
          provider: "deepseek",
          level: driver.creds.reasoningLevel || "high",
        } as AgentRuntimeRequestInput["reasoning"],
        userText: `Move the paper titled "${item.getField("title")}" from "${f.collections.geometry.name}" to "${f.collections.destination.name}". Preserve membership in "${f.collections.unrelated.name}".`,
      });
      const started = Date.now();
      const result = await new SemanticIntentService().interpret(
        request,
        getAllSkills(),
        { timeoutMs: 180000 },
      );
      const elapsedMs = Date.now() - started;
      await write(`${id}/transport.json`, {
        diagnostic: true,
        timeoutMs: 180000,
        elapsedMs,
        model: request.model,
        reasoning: request.reasoning,
        result,
      });
      onlyChanges(before, await snapshot(), () => false);
      return {
        status: "REVIEW_REQUIRED",
        detail: `Read-only timing diagnostic: ${result.degraded ? "unavailable" : "interpreted"} in ${elapsedMs} ms under a 180-second per-attempt limit. This is not production action acceptance.`,
      };
    } else if (id === "semantic.filing") {
      const item = f.items.geometry;
      const destination = f.collections.destination;
      const prompts = [
        `move this paper to ${destination.name} folder`,
        `move this paper to ${destination.name} collection`,
        `请把这篇论文放进 ${destination.name} 文件夹，保留它在其他集合中的归属。`,
      ];
      const membership = Array.from(
        new Set([...before[itemKey(item)].collections, destination.key]),
      ).sort();
      for (const [index, prompt] of prompts.entries()) {
        const turn = await run(prompt, {
          ...paperRequest(item),
          conversationKey: item.id + index * 1000000,
        });
        exactFieldChange(
          before,
          await snapshot(),
          item,
          "collections",
          membership,
        );
        requireReceipt(turn);
        if (index > 0)
          check(
            turn.events.some(
              (event) =>
                event.type === "tool_result" &&
                event.actionReceipts.some(
                  (receipt) =>
                    receipt.status === "already_satisfied" &&
                    receipt.verification === "verified",
                ),
            ),
            "Repeated filing needs verified already-satisfied evidence",
          );
      }
    } else if (id === "library.add" || id === "library.move") {
      const item = f.items.geometry;
      const moving = id === "library.move";
      const turn = await run(
        `${moving ? "Move" : "Add"} the paper titled "${item.getField("title")}" ${moving ? `from "${f.collections.geometry.name}" ` : ""}to "${f.collections.destination.name}". Preserve membership in "${f.collections.unrelated.name}"${moving ? "." : " and all existing collections."}`,
      );
      const membership = [
        ...before[itemKey(item)].collections,
        f.collections.destination.key,
      ]
        .filter(
          (key, i, list) =>
            list.indexOf(key) === i &&
            (!moving || key !== f.collections.geometry.key),
        )
        .sort();
      exactFieldChange(
        before,
        await snapshot(),
        item,
        "collections",
        membership,
      );
      requireReceipt(turn);
    } else if (id === "library.merge") {
      const sources = [f.collections.geometry, f.collections.memory];
      const sourceNames = sources.map((source) => source.name);
      const union = [
        ...new Set(sources.flatMap((c) => c.getChildItems(true))),
      ].sort((a, b) => Number(a) - Number(b));
      const name = `geometry_memory ${f.marker}`;
      const turn = await run(
        `Merge collections "${sources[0].name}" and "${sources[1].name}" into a single collection named "${name}" under "${f.root.name}". The new collection must contain the union of their papers. Remove the two old collection names, preserve all papers and memberships in other collections.`,
      );
      const all = Zotero.Collections.getByLibrary(f.libraryID, true);
      const destinations = all.filter((c: any) => c.name === name);
      assertExact(destinations.length, 1, "Merged collection count");
      assertExact(
        destinations[0].parentID,
        f.root.id,
        "Merged collection parent",
      );
      assertExact(
        destinations[0]
          .getChildItems(true)
          .sort((a: number, b: number) => a - b),
        union,
        "Merged collection membership",
      );
      assertExact(
        all.filter((c: any) => sourceNames.includes(c.name)).length,
        0,
        "Old collection names",
      );
      const after = await snapshot();
      const sourceKeys = sources.map((c) => c.key);
      for (const itemId of union) {
        const item = Zotero.Items.get(itemId);
        const retained = before[itemKey(item)].collections.filter(
          (key: string) => !sourceKeys.includes(key),
        );
        const actual = after[itemKey(item)].collections.filter(
          (key: string) =>
            !sourceKeys.includes(key) || key === destinations[0].key,
        );
        assertExact(
          [...new Set(actual)].sort(),
          [...new Set([...retained, destinations[0].key])].sort(),
          "Exact merged and unrelated memberships",
        );
      }
      for (const source of sources) {
        if (source.id === destinations[0].id) continue;
        const current = Zotero.Collections.get(source.id);
        check(
          !current || current.deleted,
          "Old collection must be removed or recoverably trashed",
        );
      }
      onlyChanges(
        before,
        after,
        (row) =>
          sources.some((c) => collectionKey(c) === row.key) ||
          row.key === collectionKey(destinations[0]) ||
          union.some(
            (itemId) =>
              row.before?.id === itemId &&
              row.after &&
              JSON.stringify({
                ...row.before,
                collections: row.after.collections,
              }) === JSON.stringify(row.after),
          ),
      );
      requireReceipt(turn);
    } else if (id === "library.related") {
      const [a, b] = [f.items.geometry, f.items.memory];
      const turn = await run(
        `Link "${a.getField("title")}" and "${b.getField("title")}" as Related papers in Zotero. Change no other item.`,
      );
      await snapshot();
      check(
        a.relatedItems.includes(b.key) && b.relatedItems.includes(a.key),
        "Related links are not reciprocal",
      );
      onlyChanges(
        before,
        await snapshot(),
        (row) =>
          [itemKey(a), itemKey(b)].includes(row.key) &&
          JSON.stringify({ ...row.before, relations: row.after?.relations }) ===
            JSON.stringify(row.after),
      );
      requireReceipt(turn);
    } else if (id === "library.trash" || id === "library.restore") {
      const item = f.items.metadata;
      const trash = id === "library.trash";
      const turn = await run(
        `${trash ? "Move to trash (do not permanently delete)" : "Restore from trash"} only the paper with item key ${item.key}, titled "${item.getField("title")}".`,
      );
      exactFieldChange(before, await snapshot(), item, "deleted", trash);
      requireReceipt(turn);
    } else if (id === "library.import-five") {
      const turn = await run(
        `Find and import the top five relevant papers on neural population coding and representational drift into "${f.collections.imports.name}". Import exactly five papers not already in the library, not just recommendations; skip duplicates and choose another relevant paper if needed.`,
      );
      const papers = f.collections.imports
        .getChildItems(false)
        .filter((item: any) => item.isRegularItem());
      assertExact(papers.length, 5, "Imported paper count");
      const identifiers = papers.map(
        (item: any) =>
          item.getField("DOI") || item.getField("url") || item.getField("ISBN"),
      );
      check(
        identifiers.every(Boolean) && new Set(identifiers).size === 5,
        "Imports lack five distinct identifiers",
      );
      requireReceipt(turn);
      onlyChanges(
        before,
        await snapshot(),
        (row) =>
          !row.before &&
          row.after?.libraryID === f.libraryID &&
          papers.some(
            (item: any) =>
              row.after?.key === item.key || row.after?.parentItem === item.key,
          ),
      );
      outcome = {
        status: "REVIEW_REQUIRED",
        detail:
          "Five distinct imports verified; inspect topic relevance and ranking in turn answer and native metadata.",
      };
    } else {
      const probe = id.split(".").at(-1);
      const item = f.items.metadata;
      const request = paperRequest(item);
      const expected = spec.mode === "safe" ? "approval" : "none";
      let turn: Turn;
      if (probe === "note") {
        const prior = (await notes(item)).map((note) => note.id);
        turn = await run(
          `Create exactly one child note on this paper containing the exact sentence "Mode ${spec.mode} behavior probe ${f.marker}."`,
          request,
          "none",
        );
        const added = (await notes(item)).filter(
          (note) => !prior.includes(note.id),
        );
        assertExact(added.length, 1, "Created child note count");
        const savedEvent = [...turn.events]
          .reverse()
          .find(
            (event) =>
              event.type === "tool_result" &&
              event.ok &&
              event.actionReceipts.some(
                (receipt) =>
                  receipt.operation === "note_create" &&
                  receipt.status === "applied",
              ),
          );
        check(
          savedEvent?.type === "tool_result",
          "No verified note result for the saved card",
        );
        const panel = await harness.renderPanelForItem(item.id);
        const trace = harness.renderToolResultForPanel(
          panel.panelId,
          savedEvent,
        );
        const card = trace?.querySelector(".llm-saved-note-card");
        check(
          card && card.dataset.noteId === String(added[0].id),
          "Saved card must target the exact native note",
        );
        check(
          !card.querySelector("button, textarea"),
          "New-note result must not contain approval or a draft editor",
        );
        check(
          card.querySelector("a")?.href.includes(added[0].key),
          "Saved card has no exact native note link",
        );
        await write(`${id}/saved-card.html`, card.outerHTML, true);
        check(
          added[0]
            .getNote()
            .includes(`Mode ${spec.mode} behavior probe ${f.marker}.`),
          "Saved note content mismatch",
        );
        permitNewChild(before, await snapshot(), item);
        requireReceipt(turn);
      } else if (probe === "metadata") {
        const value = `Behavior Journal ${id} ${f.marker}`;
        turn = await run(
          `Set only the publication title (journal) of this paper to "${value}". Do not change any other field.`,
          request,
          expected,
        );
        exactFieldChange(
          before,
          await snapshot(),
          item,
          "publicationTitle",
          value,
        );
        requireReceipt(turn);
      } else if (probe === "file") {
        const path = `${ctx.request.reportDir}/vault/${id}.md`;
        turn = await run(
          `Write a new UTF-8 file at "${path}" containing exactly "Mode ${spec.mode} file probe." This is an authorized disposable test output directory. Do not change Zotero.`,
          request,
          expected,
        );
        assertExact(
          String(await Zotero.File.getContentsAsync(path)).trim(),
          `Mode ${spec.mode} file probe.`,
          "File bytes",
        );
        assertExact(
          await snapshot(),
          before,
          "File probe must not change Zotero",
        );
        requireReceipt(turn);
      } else if (id === "recovery.cancel") {
        turn = await run(
          `Set this paper's title to "Cancelled probe ${f.marker}".`,
          request,
          "cancel",
        );
        assertExact(await snapshot(), before, "Cancelled mutation");
        check(
          !turn.events.some(
            (event) =>
              event.type === "tool_result" &&
              event.actionReceipts.some(
                (receipt) => receipt.status === "applied",
              ),
          ),
          "Cancellation produced applied receipt",
        );
      } else if (probe === "related-review") {
        turn = await run(
          "Find five papers relevant to the current paper.",
          request,
          "review",
        );
        const review = turn.events.find(
          (event) =>
            event.type === "confirmation_required" &&
            event.action.toolName === "literature_review",
        );
        check(
          review?.type === "confirmation_required",
          "Ranked literature review card was not shown",
        );
        if (review?.type === "confirmation_required") {
          check(
            review.action.fields.length === 1 &&
              review.action.fields[0].type === "paper_result_list",
            "Discovery card contains unrelated forms",
          );
          const papers = review.action.fields[0];
          if (papers.type === "paper_result_list") {
            check(
              papers.rows.length === 5,
              "Discovery did not present the requested five-paper shortlist",
            );
            check(
              papers.rows.every((paper) => Boolean(paper.body?.trim())),
              "A shortlisted paper lacks its relevance explanation",
            );
          }
        }
        assertExact(await snapshot(), before, "Cancelled related-paper review");
      } else {
        check(
          ["read", "no-write", "unavailable-figures"].includes(probe || ""),
          `No executor for ${id}`,
        );
        const prompt =
          probe === "no-write"
            ? "Suggest how the title could be improved. Do not edit, save, tag, import, or change anything in Zotero or on disk."
            : probe === "unavailable-figures"
              ? "Explain Figure 2 from this paper. If there is no PDF or figure available, say so; do not invent content or create files."
              : "Read this paper's metadata and report its exact title and year. Do not change anything.";
        turn = await run(prompt, request);
        assertExact(await snapshot(), before, "Read-only probe");
        if (probe === "read")
          check(
            turn.result.text.includes(item.getField("title")),
            "Wrong paper title in read-only answer",
          );
        if (probe === "unavailable-figures")
          check(
            /no |not |unavailable|cannot|can.t|missing/i.test(turn.result.text),
            "Missing figure was not disclosed",
          );
      }
    }
    return outcome;
  } finally {
    const after = await snapshot();
    await write(`${id}/after.json`, after);
    const { diff } = await import("./native");
    await write(`${id}/diff.json`, diff(before, after));
  }
}
