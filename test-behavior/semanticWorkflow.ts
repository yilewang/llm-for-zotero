import { prepareDocumentMarkdownExport } from "../src/agent/documents/exportBundle";
import { getAgentRuntime } from "../src/agent";
import {
  loadPlanDocument,
  loadPlanDocumentOutbox,
  loadDocumentActionState,
} from "../src/agent/documents/store";
import { stripZoteroNoteWrapper } from "../src/modules/contextPanel/notePersistence";
import { assertExact, check } from "./core";
import { snapshot, itemKey, collectionKey, onlyChanges } from "./native";
import type { JourneyContext } from "./journeys";
import {
  enableComposePlanMode,
  getPlanningRuntimeContext,
  stageApprovedPlanExecution,
} from "../src/modules/contextPanel/planModeState";
import {
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../src/agent/plans/store";
import { planExecutionCoordinator } from "../src/agent/plans/coordinator";
import { getConversationWriteGeneration } from "../src/shared/conversationWriteFence";

declare const Zotero: any;
declare const IOUtils: any;

/** A real composer-to-native-state journey; no model answers or effects are supplied by the driver. */
export async function semanticWorkflow(id: string, ctx: JourneyContext) {
  const { fixtures: f, harness, driver, write } = ctx;
  const planned = id === "semantic.compound-plan";
  const revised = id === "semantic.compound-revise";
  const recovery = id === "semantic.compound-resume" || revised;
  const clarified = id === "semantic.compound-clarified";
  const implicit = id === "semantic.compound-implicit" || clarified;
  const destination = implicit
    ? Zotero.Collections.getByLibrary(
        Zotero.Libraries.userLibraryID,
        true,
      ).find((entry: any) => entry.name === "Learning")
    : f.collections.destination;
  check(destination, "The requested native destination exists");
  const fixture = await harness.createPaperWithPdfFixture({
    title: `Semantic workflow population coding ${f.marker} ${planned ? "plan" : "direct"}`,
    pdfTitle: "Synthetic semantic workflow acceptance paper",
    pages: [
      "SYNTHETIC TEST PAPER. Hypothesis: a stable population readout can coexist with representational drift. This is a synthetic experiment, not a published biological result.",
      "Methods: simulated neural population recordings across twelve sessions. A linear decoder was fitted on session one and tested on the remaining sessions. The control shuffled neuron identities.",
      "Results: intact decoding accuracy was 0.83, compared with 0.51 after shuffling identities. The intact readout remained stable despite changing individual tuning.",
      "Limitations: only simulated data and linear decoders were studied. The findings do not establish biological causality or invariance for nonlinear readouts.",
    ],
  });
  const paper = Zotero.Items.get(fixture.parentItemId);
  paper.setCollections([
    f.collections.geometry.id,
    ...(implicit && !clarified ? [] : [f.collections.unrelated.id]),
  ]);
  await paper.saveTx();
  await harness.openStandaloneForItem(paper.id);
  await harness.clickStandaloneTab("paper");
  harness.enableLiveAgentSending();
  const before = await snapshot();
  await write(`${id}/execution-before.json`, before);
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/before.png`,
  );

  await write(`${id}/targets.json`, {
    paperId: paper.id,
    paperKey: paper.key,
    attachmentId: fixture.pdfAttachmentId,
    source: f.collections.geometry.id,
    destination: destination.id,
    preserved: f.collections.unrelated.id,
  });
  const prompt = implicit
    ? "Help me move this current paper into learning folder, then summarize this paper, then save the summary as a note attached to that paper. Include the methods, quantitative result, and limitations in the summary."
    : `Move this current paper from folder "${f.collections.geometry.name}" into folder "${destination.name}", then summarize this paper, then save the summary as a note attached to that paper. Preserve its membership in "${f.collections.unrelated.name}". Include the methods, quantitative result, and limitations in the summary.`;
  const request = { conversationKey: paper.id, activeItemId: paper.id };
  let executionId: string | undefined;
  let executionPrompt = prompt;
  if (planned) {
    const planning = enableComposePlanMode({
      conversationKey: paper.id,
      provider: "original",
    });
    await driver.turn(
      id,
      prompt,
      "auto",
      { ...request, planContext: getPlanningRuntimeContext(paper.id) },
      "none",
      () => harness.askStandalone(prompt),
    );
    assertExact(
      await snapshot(),
      before,
      "Planning must not mutate native Zotero state",
    );
    const artifact = await loadPlanArtifact(planning.planId, planning.revision);
    check(
      artifact?.status === "awaiting_approval",
      "The complete workflow must produce an approvable plan",
    );
    await write(`${id}/plan.json`, artifact);
    await harness.captureStandaloneScreenshot(
      `${ctx.request.reportDir}/${id}/plan-ready.png`,
    );
    const ledger = await planExecutionCoordinator.approve({
      planId: artifact.planId,
      revision: artifact.revision,
      conversationGeneration: getConversationWriteGeneration(paper.id),
      actionContract: artifact.actionContract,
    });
    executionId = ledger.executionId;
    await write(`${id}/approval.json`, {
      approvedBy: "explicit manual behavior-suite invocation",
      ledger,
    });
    stageApprovedPlanExecution(ledger);
    executionPrompt = "Execute the approved workflow to completion.";
  }
  const startedAt = Date.now();
  const noteTool = recovery
    ? getAgentRuntime().getToolDefinition("note_write")
    : undefined;
  const originalSave = noteTool?.execute;
  let injected = false;
  if (noteTool && originalSave)
    noteTool.execute = async (input, context) => {
      if (revised && !injected) {
        injected = true;
        throw new Error(
          "Behavior fixture: interruption before note persistence",
        );
      }
      const result = await originalSave(input, context);
      if (!injected) {
        injected = true;
        throw new Error(
          "Behavior fixture: lost response after native note persistence",
        );
      }
      return result;
    };
  let turn: Awaited<ReturnType<typeof driver.turn>>;
  try {
    turn = await driver.turn(
      id,
      executionPrompt,
      "auto",
      request,
      clarified ? "review" : "none",
      () => harness.askStandalone(executionPrompt),
      async (action) => {
        await harness.captureStandaloneScreenshot(
          `${ctx.request.reportDir}/${id}/source-question.png`,
        );
        return Object.fromEntries(
          action.fields.map((field) => [
            field.id,
            { kind: "option", optionId: `source:${f.collections.geometry.id}` },
          ]),
        );
      },
    );
  } finally {
    if (noteTool && originalSave) noteTool.execute = originalSave;
  }
  if (recovery) {
    check(injected, "The failure must occur after the actual note save");
    await paper.reload(undefined, true);
    const firstNotes = paper.getNotes();
    assertExact(
      firstNotes.length,
      revised ? 0 : 1,
      "The failure boundary must match the expected native note persistence",
    );
    const persistedBeforeResume = await snapshot();
    const revisedPath = `${ctx.request.reportDir}/vault/revised-summary.md`;
    const resumePrompt = revised
      ? `Continue, but save the already finalized summary as a file at "${revisedPath}" instead of creating an attached note. Keep the completed move and the existing summary.`
      : "Continue the unfinished workflow.";
    const resumed = await driver.turn(
      id,
      resumePrompt,
      "auto",
      request,
      "none",
      () => harness.askStandalone(resumePrompt),
    );
    assertExact(
      await snapshot(),
      persistedBeforeResume,
      "Resuming a persisted save creates no duplicate or collateral change",
    );
    const resumedCalls = resumed.events.filter(
      (event) => event.type === "tool_call",
    );
    assertExact(
      resumedCalls.map((event) =>
        event.type === "tool_call" ? event.name : "",
      ),
      [revised ? "file_io" : "note_write"],
      "Resume only the requested save without model tool detours",
    );
    check(
      resumedCalls.every(
        (event) =>
          event.type === "tool_call" && event.callId.startsWith("workflow:"),
      ),
      "The host resumes the exact saved material",
    );
    await write(`${id}/resume.json`, {
      noteId: firstNotes[0],
      result: resumed.result,
      events: resumed.events,
    });
    if (revised) {
      const submission = turn.events.find(
        (event) =>
          event.type === "tool_result" &&
          event.name === "submit_document" &&
          event.ok,
      );
      const documentId =
        submission?.type === "tool_result"
          ? String((submission.content as any).documentId)
          : "";
      const document = await loadPlanDocument(documentId);
      check(document, "The original summary remains durable");
      const exported = await prepareDocumentMarkdownExport(
        document,
        revisedPath,
      );
      assertExact(
        Array.from(await IOUtils.read(revisedPath)),
        Array.from(exported.bytes),
        "The revised file contains the exact canonical export of the retained summary",
      );
      assertExact(
        resumed.result.documentId,
        document.documentId,
        "Revision reuses the exact document identity",
      );
      onlyChanges(
        before,
        persistedBeforeResume,
        (row) => row.key === itemKey(paper),
      );
      assertExact(
        persistedBeforeResume[itemKey(paper)],
        {
          ...before[itemKey(paper)],
          collections: [destination.key, f.collections.unrelated.key].sort(),
        },
        "Revision preserves the already completed move and unrelated membership",
      );
      check(
        resumed.events.some(
          (event) =>
            event.type === "tool_result" &&
            event.actionReceipts?.some(
              (receipt) =>
                receipt.operation === "file_write" &&
                receipt.verification === "verified",
            ),
        ),
        "The revised file has a verified persistence receipt",
      );
      await write(`${id}/revised-material.json`, {
        document,
        path: revisedPath,
        result: resumed.result,
      });
      const chatBox =
        Zotero.LLMForZotero.data.standaloneWindow?.document.querySelector(
          "#llm-chat-box",
        );
      if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
      await Zotero.Promise.delay(100);
      await harness.captureStandaloneScreenshot(
        `${ctx.request.reportDir}/${id}/completed.png`,
      );
      return;
    }
    turn = { ...resumed, events: [...turn.events, ...resumed.events] };
  }
  await paper.reload(undefined, true);
  const after = await snapshot();
  const expectedPaper = {
    ...before[itemKey(paper)],
    collections: [
      destination.key,
      ...(implicit && !clarified ? [] : [f.collections.unrelated.key]),
    ].sort(),
  };
  assertExact(
    after[itemKey(paper)],
    expectedPaper,
    "The intended paper moved while all other fields and memberships were preserved",
  );
  const newNotes = paper
    .getNotes()
    .map((noteId: number) => Zotero.Items.get(noteId))
    .filter((note: any) => !before[itemKey(note)]);
  assertExact(
    newNotes.length,
    1,
    "Exactly one summary note must be attached to the same paper",
  );
  const note = newNotes[0];
  await note.reload(undefined, true);
  assertExact(note.parentID, paper.id, "Native summary-note parent");
  const text = String(note.getNote()).replace(/<[^>]*>/g, " ");
  check(
    text.trim().length >= 250,
    "The saved summary must contain substantive content",
  );
  check(
    /0\.83|83\s*%/.test(text) && /0\.51|51\s*%/.test(text),
    "The summary must retain the paper's quantitative result",
  );
  check(
    /simulat|synthetic/i.test(text) && /linear/i.test(text),
    "The summary must retain the source's methods and evidence limitations",
  );
  check(
    !/placeholder|insert summary here|content pending/i.test(text),
    "The saved note must be finalized",
  );
  onlyChanges(
    before,
    after,
    (row) =>
      row.key === itemKey(paper) || (row.key === itemKey(note) && !row.before),
  );
  const compoundMutations = turn.events.filter(
    (event) =>
      event.type === "tool_call" &&
      ["library_update", "note_write"].includes(event.name),
  );
  assertExact(
    compoundMutations.length,
    recovery ? 3 : 2,
    "The compound workflow performs only its requested move and note save",
  );
  check(
    compoundMutations.every(
      (event) =>
        event.type === "tool_call" && event.callId.startsWith("workflow:"),
    ),
    "The shared host runner owns both compound mutations",
  );
  const receipts = turn.events.flatMap((event) =>
    event.type === "tool_result" ? event.actionReceipts || [] : [],
  );
  for (const operation of ["move_to_collection", "note_create"])
    check(
      receipts.some(
        (receipt) =>
          receipt.operation === operation &&
          receipt.verification === "verified" &&
          ["applied", "already_satisfied"].includes(receipt.status),
      ),
      `Missing verified ${operation} receipt`,
    );
  const submissions = turn.events.filter(
    (event) =>
      event.type === "tool_result" &&
      event.name === "submit_document" &&
      event.ok,
  );
  assertExact(submissions.length, 1, "Generate and persist the summary once");
  const submission = submissions[0];
  const documentId =
    submission.type === "tool_result"
      ? String((submission.content as any)?.documentId || "")
      : "";
  check(
    documentId,
    "The generated summary must have a durable document identity",
  );
  const document = await loadPlanDocument(documentId);
  check(
    document?.validation.integrityValidated,
    "The exact summary document must pass integrity validation",
  );
  assertExact(
    stripZoteroNoteWrapper(note.getNote()),
    stripZoteroNoteWrapper(document.visibleHtml),
    "The native note must contain the exact finalized summary",
  );
  assertExact(
    turn.result.text,
    document.visibleMarkdown,
    "The published answer must retain the exact immutable summary",
  );
  const publication = await loadPlanDocumentOutbox(documentId);
  assertExact(
    publication?.status,
    "delivered",
    "The completed document must be published, not left in Publishing document state",
  );
  const association = await loadDocumentActionState(documentId);
  assertExact(
    association?.savedNote?.itemKey,
    note.key,
    "Durable document-to-note association",
  );
  assertExact(
    association?.savedNote?.parentItemId,
    paper.id,
    "Durable exact parent binding",
  );
  assertExact(
    association?.savedNote?.contentHash,
    document.contentHash,
    "Durable content identity",
  );
  const moveIndex = turn.events.findIndex(
    (event) =>
      event.type === "tool_result" &&
      event.ok &&
      event.actionReceipts?.some(
        (receipt) =>
          receipt.operation === "move_to_collection" &&
          receipt.verification === "verified",
      ),
  );
  const submitIndex = turn.events.indexOf(submission);
  const saveIndex = turn.events.findIndex(
    (event) =>
      event.type === "tool_result" &&
      event.ok &&
      event.actionReceipts?.some(
        (receipt) =>
          receipt.operation === "note_create" &&
          receipt.verification === "verified",
      ),
  );
  check(
    moveIndex >= 0 && moveIndex < submitIndex && submitIndex < saveIndex,
    "Native evidence must establish move, generate, and save in the requested order",
  );
  await write(`${id}/material.json`, {
    document,
    association,
    moveIndex,
    submitIndex,
    saveIndex,
  });
  if (executionId) {
    assertExact(
      turn.events.filter(
        (event) => event.type === "tool_call" && event.name === "task_update",
      ).length,
      0,
      "Host-verifiable Plan tasks require no model status mirroring",
    );
    const ledger = await loadPlanExecutionLedger(executionId);
    await write(`${id}/final-ledger.json`, ledger);
    check(
      ledger?.tasks.every((task) => task.status === "completed"),
      "Every required plan task must complete from evidence",
    );
  }
  await write(`${id}/summary-note.html`, note.getNote(), true);
  await write(`${id}/execution-after.json`, after);
  await write(`${id}/timing.json`, {
    executionElapsedMs: Date.now() - startedAt,
    toolCalls: turn.events.filter((event) => event.type === "tool_call").length,
  });
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/completed.png`,
  );
  await write(`${id}/ui.json`, await harness.getStandaloneDiagnostics());
}

/** Exact user reproduction with disposable paper state and a real provider. */
export async function ordinaryMoveWorkflow(ctx: JourneyContext) {
  const { fixtures: f, harness, driver, write } = ctx;
  const id = "semantic.move";
  const destinations = Zotero.Collections.getByLibrary(
    Zotero.Libraries.userLibraryID,
    true,
  ).filter((entry: any) => entry.name.toLowerCase() === "learning");
  check(
    destinations.length === 1,
    "The dev fixture requires one native Learning collection",
  );
  const destination = destinations[0];
  const paper = new Zotero.Item("journalArticle");
  paper.libraryID = Zotero.Libraries.userLibraryID;
  paper.setField("title", `Ordinary action reproduction ${f.marker}`);
  paper.setCollections([f.collections.geometry.id]);
  await paper.saveTx();
  await harness.openStandaloneForItem(paper.id);
  await harness.clickStandaloneTab("paper");
  harness.enableLiveAgentSending();
  const before = await snapshot();
  await write(`${id}/execution-before.json`, before);
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/before.png`,
  );
  const started = Date.now();
  const turn = await driver.turn(
    id,
    "move this paper to learning folder",
    "auto",
    { conversationKey: paper.id, activeItemId: paper.id },
    "none",
    () => harness.askStandalone("move this paper to learning folder"),
  );
  await paper.reload(undefined, true);
  const after = await snapshot();
  assertExact(
    after[itemKey(paper)],
    { ...before[itemKey(paper)], collections: [destination.key] },
    "The exact paper leaves its source and enters Learning",
  );
  onlyChanges(before, after, (row) => row.key === itemKey(paper));
  const calls = turn.events.filter((event) => event.type === "tool_call");
  const results = turn.events.filter((event) => event.type === "tool_result");
  check(
    results.every((event) => event.type !== "tool_result" || event.ok),
    "No rejected or failed calls in a simple move",
  );
  assertExact(calls.length, 1, "Exactly one complete action call");
  assertExact(
    turn.events.filter((event) => event.type === "usage").length,
    0,
    "No execution-model rounds after semantic preparation",
  );
  check(
    results.some(
      (event) =>
        event.type === "tool_result" &&
        event.actionReceipts.some(
          (receipt) =>
            receipt.verification === "verified" &&
            receipt.operation === "move_to_collection",
        ),
    ),
    "Native move verification receipt",
  );
  await write(`${id}/performance.json`, {
    elapsedMs: Date.now() - started,
    calls,
    finalText: turn.result.text,
  });
  await write(`${id}/execution-after.json`, after);
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/completed.png`,
  );
}

export async function preparedActionCases(ctx: JourneyContext) {
  const { fixtures: f, harness, driver, write } = ctx;
  const id = "semantic.action-cases";
  const destination = Zotero.Collections.getByLibrary(
    Zotero.Libraries.userLibraryID,
    true,
  ).find((entry: any) => entry.name === "Learning");
  check(destination, "Native Learning collection is available");
  for (const [label, prompt, ambiguous, additive] of [
    [
      "paraphrase",
      "Please relocate the current paper to the Learning collection.",
      false,
      false,
    ],
    ["multilingual", "请把当前论文移到 Learning 文件夹。", false, false],
    [
      "additive",
      "Add this paper to Learning and keep all its existing collection memberships.",
      false,
      true,
    ],
    ["clarification", "move this paper to learning folder", true, false],
  ] as const) {
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", `Prepared action ${label} ${f.marker}`);
    paper.setCollections(
      ambiguous || additive
        ? [f.collections.geometry.id, f.collections.unrelated.id]
        : [f.collections.geometry.id],
    );
    await paper.saveTx();
    await harness.openStandaloneForItem(paper.id);
    await harness.clickStandaloneTab("paper");
    harness.enableLiveAgentSending();
    const before = await snapshot();
    const started = Date.now();
    const turn = await driver.turn(
      id,
      prompt,
      "auto",
      { conversationKey: paper.id, activeItemId: paper.id },
      ambiguous ? "review" : "none",
      () => harness.askStandalone(prompt),
      (action) =>
        Object.fromEntries(
          action.fields.map((field) => [
            field.id,
            field.type === "choice"
              ? {
                  kind: "option",
                  optionId: `source:${f.collections.geometry.id}`,
                }
              : f.collections.geometry.name,
          ]),
        ),
    );
    await paper.reload(undefined, true);
    const after = await snapshot();
    assertExact(
      after[itemKey(paper)],
      {
        ...before[itemKey(paper)],
        collections: [
          destination.key,
          ...(ambiguous || additive ? [f.collections.unrelated.key] : []),
          ...(additive ? [f.collections.geometry.key] : []),
        ].sort(),
      },
      `${label}: exact membership effect`,
    );
    onlyChanges(before, after, (row) => row.key === itemKey(paper));
    assertExact(
      turn.events.filter((event) => event.type === "usage").length,
      0,
      `${label}: no execution-model round`,
    );
    const calls = turn.events.filter((event) => event.type === "tool_call");
    assertExact(
      calls.length,
      ambiguous ? 2 : 1,
      `${label}: only required clarification and effect`,
    );
    check(
      turn.events.every((event) => event.type !== "tool_result" || event.ok),
      `${label}: no rejected calls`,
    );
    await write(`${id}/${label}.json`, {
      elapsedMs: Date.now() - started,
      before: before[itemKey(paper)],
      after: after[itemKey(paper)],
      calls,
      text: turn.result.text,
    });
    await harness.captureStandaloneScreenshot(
      `${ctx.request.reportDir}/${id}/${label}.png`,
    );
  }
  const folder = new Zotero.Collection();
  folder.libraryID = Zotero.Libraries.userLibraryID;
  folder.name = `Temporary action folder ${f.marker}`;
  folder.parentID = f.collections.geometry.id;
  await folder.saveTx();
  const before = await snapshot();
  const turn = await driver.turn(
    id,
    `Delete the folder "${folder.name}" and keep its papers.`,
    "auto",
  );
  const after = await snapshot();
  check(
    !Zotero.Collections.get(folder.id) ||
      Zotero.Collections.get(folder.id).deleted,
    "The requested collection was deleted",
  );
  onlyChanges(
    before,
    after,
    (row) => row.key === `collection:${folder.libraryID}:${folder.key}`,
  );
  assertExact(
    turn.events.filter((event) => event.type === "usage").length,
    0,
    "Collection deletion needs no execution-model round",
  );
  check(
    turn.events.some(
      (event) =>
        event.type === "tool_result" &&
        event.actionReceipts.some(
          (receipt) =>
            receipt.operation === "delete_collection" &&
            receipt.verification === "verified",
        ),
    ),
    "Native collection deletion verification",
  );
}

/** Natural language creates a destination and then consumes its verified native identity. */
export async function createdDestinationWorkflow(ctx: JourneyContext) {
  const { fixtures: f, harness, driver, write } = ctx;
  const id = "semantic.create-file";
  const paper = new Zotero.Item("journalArticle");
  paper.libraryID = Zotero.Libraries.userLibraryID;
  paper.setField("title", `Created destination acceptance ${f.marker}`);
  paper.setCollections([f.collections.geometry.id, f.collections.unrelated.id]);
  await paper.saveTx();
  await harness.openStandaloneForItem(paper.id);
  await harness.clickStandaloneTab("paper");
  harness.enableLiveAgentSending();
  const before = await snapshot();
  await write(`${id}/execution-before.json`, before);
  const name = `Created workflow destination ${f.marker}`;
  const prompt = `Create a new collection named "${name}" inside "${f.collections.destination.name}", then move this current paper from "${f.collections.geometry.name}" into that new collection. Preserve its membership in "${f.collections.unrelated.name}".`;
  const turn = await driver.turn(
    id,
    prompt,
    "auto",
    { conversationKey: paper.id, activeItemId: paper.id },
    "none",
    () => harness.askStandalone(prompt),
  );
  const destinations = Zotero.Collections.getByLibrary(
    paper.libraryID,
    true,
  ).filter((collection: any) => collection.name === name);
  assertExact(
    destinations.length,
    1,
    "Create exactly one requested destination",
  );
  const destination = destinations[0];
  assertExact(
    destination.parentID,
    f.collections.destination.id,
    "Requested parent collection",
  );
  await paper.reload(undefined, true);
  const after = await snapshot();
  assertExact(
    after[itemKey(paper)],
    {
      ...before[itemKey(paper)],
      collections: [destination.key, f.collections.unrelated.key].sort(),
    },
    "File the exact paper while retaining unrelated membership and fields",
  );
  onlyChanges(
    before,
    after,
    (row) =>
      row.key === itemKey(paper) ||
      (row.key === collectionKey(destination) && !row.before),
  );
  const calls = turn.events.filter((event) => event.type === "tool_call");
  assertExact(
    calls.length,
    2,
    "Only collection creation and filing are required",
  );
  check(
    calls.every(
      (event) =>
        event.type === "tool_call" && event.callId.startsWith("workflow:"),
    ),
    "Both steps are dispatched by the shared host runner",
  );
  assertExact(
    turn.events.filter((event) => event.type === "usage").length,
    0,
    "No execution-model round is needed after interpretation",
  );
  for (const operation of ["create_collection", "move_to_collection"])
    check(
      turn.events.some(
        (event) =>
          event.type === "tool_result" &&
          event.ok &&
          event.actionReceipts.some(
            (receipt) =>
              receipt.operation === operation &&
              receipt.verification === "verified",
          ),
      ),
      `Verified ${operation} receipt`,
    );
  await write(`${id}/execution-after.json`, after);
  await write(`${id}/targets.json`, {
    paperId: paper.id,
    destinationId: destination.id,
  });
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/completed.png`,
  );
}
