import { DatabaseSync } from "node:sqlite";
import { initPlanDocumentStore } from "../../src/agent/documents/store";
import { PlanExecutionCoordinator } from "../../src/agent/plans/coordinator";
import {
  initAgentPlanStore,
  loadPlanExecutionLedger,
} from "../../src/agent/plans/store";
import type {
  ExecutionTask,
  PlanExecutionLedger,
  TaskEvidence,
  TrustedReadObservation,
} from "../../src/agent/plans/types";
import { initResearchStore } from "../../src/agent/research/store";
import type { ResearchContract } from "../../src/agent/research/types";
import { createResearchUpdateTool } from "../../src/agent/tools/plan/researchUpdate";
import { resolvePlanContract } from "../../src/agent/tools/plan/updatePlan";
import type { AgentToolContext } from "../../src/agent/types";
import { resolvedAgentRequest } from "./resolvedAgentRequest";

/**
 * In-memory Zotero for the research loop: a sqlite database behind
 * `Zotero.DB`, fixture papers with PDF attachments, the gateway surface the
 * research tools touch, and helpers that approve a research plan, attach
 * host-verified reads, and run `research_update` operations the way the
 * runtime does.
 */

export type HarnessPaper = {
  itemId: number;
  key: string;
  title: string;
  abstract: string;
  year: string;
  firstCreator: string;
  attachmentId: number;
  attachmentKey: string;
  /** Approximate extracted text size; drives capacity and grouping. */
  textChars: number;
  tags?: string[];
};

type FixtureItem = {
  id: number;
  key: string;
  libraryID: number;
  version: number;
  deleted: boolean;
  parentID?: number;
  attachmentHash?: string;
  attachmentContentType?: string;
  getField: (name: string) => string;
  getCreators: () => Array<{ firstName: string; lastName: string }>;
  getDisplayTitle: () => string;
};

export type ResearchHarness = {
  db: DatabaseSync;
  gateway: unknown;
  papers: HarnessPaper[];
  libraryID: number;
  conversationKey: number;
  planId: string;
  /** Approve the plan and start its first task. */
  approve: (
    overrides?: Partial<ResearchContract> & { deliverable?: unknown },
  ) => Promise<PlanExecutionLedger>;
  ledger: () => Promise<PlanExecutionLedger>;
  activeTask: () => Promise<ExecutionTask>;
  /** Run one research_update operation with a validated input. */
  run: (
    args: Record<string, unknown>,
    options?: {
      runtimeContextBudget?: {
        contextWindowTokens: number;
        usedContextTokens: number;
      };
      model?: string;
    },
  ) => Promise<any>;
  /** Attach a host-verified read of the given papers at the given depth. */
  verifiedRead: (
    keys: string[],
    depth: "metadata" | "abstract" | "body",
    options?: { pageIndex?: number; toolName?: string; mode?: string },
  ) => Promise<string>;
  close: () => void;
};

export function paperFixtures(count: number): HarnessPaper[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      itemId: 100 + n,
      key: `PAPER${String(n).padStart(3, "0")}`,
      // Odd papers speak to the harness question; even papers are peripheral
      // methods work, so host relevance ranking has something to separate.
      title:
        n % 2
          ? `Paper ${n} on latent state inference`
          : `Paper ${n}: a Poisson generalized additive model for tuning`,
      abstract:
        n % 2
          ? `Abstract ${n}: recurrent dynamics implement latent state inference in area ${n}.`
          : `Abstract ${n}: spline regularization estimates neural tuning curves.`,
      year: String(2015 + n),
      firstCreator: `Author${n}`,
      attachmentId: 500 + n,
      attachmentKey: `PDF${String(n).padStart(5, "0")}`,
      textChars: 40_000,
    };
  });
}

function fixtureItem(paper: HarnessPaper, libraryID: number): FixtureItem {
  const fields: Record<string, string> = {
    title: paper.title,
    abstractNote: paper.abstract,
    date: paper.year,
    year: paper.year,
    firstCreator: paper.firstCreator,
    dateModified: "2026-01-01 00:00:00",
  };
  return {
    id: paper.itemId,
    key: paper.key,
    libraryID,
    version: 1,
    deleted: false,
    getField: (name) => fields[name] || "",
    getCreators: () => [{ firstName: "A", lastName: paper.firstCreator }],
    getDisplayTitle: () => paper.title,
  };
}

function attachmentItem(paper: HarnessPaper, libraryID: number): FixtureItem {
  return {
    id: paper.attachmentId,
    key: paper.attachmentKey,
    libraryID,
    version: 1,
    deleted: false,
    parentID: paper.itemId,
    attachmentHash: `hash-${paper.key}`,
    attachmentContentType: "application/pdf",
    getField: () => "",
    getCreators: () => [],
    getDisplayTitle: () => `${paper.title}.pdf`,
  };
}

export function installResearchHarness(
  options: {
    papers?: HarnessPaper[];
    libraryID?: number;
    conversationKey?: number;
    collectionId?: number;
    planId?: string;
  } = {},
): ResearchHarness {
  const papers = options.papers || paperFixtures(3);
  const libraryID = options.libraryID ?? 1;
  const conversationKey = options.conversationKey ?? 9;
  const collectionId = options.collectionId ?? 11;
  const planId = options.planId || "review";
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (params || []).map((value) => (value === undefined ? null : value));
  const items = new Map<number, FixtureItem>();
  for (const paper of papers) {
    items.set(paper.itemId, fixtureItem(paper, libraryID));
    items.set(paper.attachmentId, attachmentItem(paper, libraryID));
  }
  const byKey = (itemKey: string) =>
    [...items.values()].find((item) => item.key === itemKey) || false;
  (globalThis as any).Zotero = {
    DB: {
      queryAsync: async (sql: string, params?: unknown[]) => {
        const statement = db.prepare(sql);
        const normalized = sql.trimStart().toUpperCase();
        if (
          normalized.startsWith("SELECT") ||
          normalized.startsWith("PRAGMA") ||
          normalized.startsWith("WITH")
        ) {
          return statement.all(...(bindable(params) as never[]));
        }
        statement.run(...(bindable(params) as never[]));
        return [];
      },
      executeTransaction: async (task: () => Promise<unknown>) => {
        db.exec("BEGIN");
        try {
          const result = await task();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    Items: {
      getByLibraryAndKey: (library: number, itemKey: string) =>
        library === libraryID ? byKey(itemKey) : false,
      get: (id: number) => items.get(Number(id)) || false,
    },
    Prefs: { get: () => undefined },
    Libraries: { userLibraryID: libraryID },
    Promise: { delay: (ms: number) => new Promise((r) => setTimeout(r, ms)) },
  };
  const paperById = new Map(papers.map((paper) => [paper.itemId, paper]));
  const target = (paper: HarnessPaper) => ({
    itemId: paper.itemId,
    title: paper.title,
    firstCreator: paper.firstCreator,
    year: paper.year,
    tags: (paper.tags || []).map((name) => ({ name })),
    attachments: [
      {
        contextItemId: paper.attachmentId,
        title: `${paper.title}.pdf`,
        contentType: "application/pdf",
        indexingState: "indexed",
        readableTextChars: paper.textChars,
      },
    ],
  });
  const gateway = {
    resolveLibraryScopeItemIds: async () => ({
      itemIds: papers.map((paper) => paper.itemId),
    }),
    listBibliographicItemTargets: async () => ({
      items: papers.map(target),
    }),
    getBibliographicItemTargetsByItemIds: (ids: number[]) =>
      ids
        .map((id) => paperById.get(id))
        .filter((paper): paper is HarnessPaper => Boolean(paper))
        .map(target),
    getItem: (id: number) => items.get(Number(id)) || null,
    getAllChildAttachmentInfos: async (itemId: number) => {
      const paper = paperById.get(itemId);
      return paper ? target(paper).attachments : [];
    },
    /** Minimal author-year formatter standing in for Zotero's CSL engine. */
    formatStructuredCitations: (params: {
      clusters: Array<{ citationId: string; items: Array<{ itemId: number }> }>;
      styleId?: string;
      locale?: string;
    }) => {
      const label = (itemId: number) => {
        const paper = paperById.get(itemId);
        return paper
          ? `${paper.firstCreator}, ${paper.year}`
          : `Item ${itemId}`;
      };
      const cited = new Map<number, string>();
      for (const cluster of params.clusters)
        for (const item of cluster.items)
          cited.set(item.itemId, label(item.itemId));
      return {
        styleId: params.styleId || "apa",
        styleTitle: "APA",
        locale: params.locale || "en-US",
        clusters: params.clusters.map((cluster) => ({
          citationId: cluster.citationId,
          text: `(${cluster.items.map((item) => label(item.itemId)).join("; ")})`,
          html: `(${cluster.items.map((item) => label(item.itemId)).join("; ")})`,
        })),
        bibliographyEntries: [...cited.entries()].map(([itemId, text]) => ({
          itemId,
          text,
          html: text,
        })),
      };
    },
  };
  const coordinator = new PlanExecutionCoordinator();
  let executionId = "";
  const stepsFor = (document: boolean) => [
    {
      planStepId: `${planId}:r1:read`,
      content: "Read every paper in the collection",
      activeForm: "Reading every paper in the collection",
      acceptanceCriteria: [
        {
          criterionId: "read",
          description: "Every paper is read at body depth",
          verifier: "verified_read" as const,
        },
      ],
      expectedEffect: "read" as const,
    },
    {
      planStepId: `${planId}:r1:synthesize`,
      content: "Discover cross-paper relationships",
      activeForm: "Discovering cross-paper relationships",
      acceptanceCriteria: [
        {
          criterionId: "coverage",
          description: "Research coverage is terminal",
          verifier: "research_coverage" as const,
        },
      ],
      expectedEffect: "reasoning" as const,
    },
    document
      ? {
          planStepId: `${planId}:r1:document`,
          content: "Publish the review",
          activeForm: "Publishing the review",
          acceptanceCriteria: [
            {
              criterionId: "published",
              description: "The review is published",
              verifier: "document_published" as const,
            },
          ],
          expectedEffect: "artifact" as const,
        }
      : {
          planStepId: `${planId}:r1:answer`,
          content: "Write the answer",
          activeForm: "Writing the answer",
          acceptanceCriteria: [
            {
              criterionId: "answer",
              description: "The answer is complete",
              verifier: "bounded_reasoning" as const,
            },
          ],
          expectedEffect: "reasoning" as const,
        },
  ];
  const tool = createResearchUpdateTool(gateway as never);
  let readCounter = 0;
  const harness: ResearchHarness = {
    db,
    gateway,
    papers,
    libraryID,
    conversationKey,
    planId,
    async approve(overrides = {}) {
      await initAgentPlanStore();
      await initResearchStore();
      await initPlanDocumentStore();
      const { deliverable, ...investigationOverrides } = overrides;
      const steps = stepsFor(
        Boolean(
          deliverable &&
          typeof deliverable === "object" &&
          (deliverable as { kind?: string }).kind === "document",
        ),
      );
      const contract = await resolvePlanContract({
        raw: {
          version: 1,
          deliverable: deliverable || { kind: "answer" },
          investigation: {
            question: "How do these papers explain latent state inference?",
            subquestions: [
              {
                id: "sq1",
                question: "Which computational frameworks are used?",
              },
              {
                id: "sq2",
                question: "What empirical findings and contradictions emerge?",
              },
            ],
            criteria: [],
            reviewMode: "narrative",
            readingStrategy: "adaptive",
            scope: {
              libraryID,
              kind: "collections",
              collectionIds: [collectionId],
            },
            requiredEvidenceDepth: "body",
            estimatedDeepReadPapers: 0,
            approvedLargeCorpus: false,
            ...investigationOverrides,
          },
        },
        steps,
        ready: true,
        gateway: gateway as never,
        planId,
        revision: 1,
        conversationKey,
      });
      await coordinator.updateDraft({
        planId,
        conversationKey,
        provider: "original",
        revision: 1,
        steps,
        contract,
        ready: true,
        now: 1,
      });
      const approved = await coordinator.approve({
        planId,
        revision: 1,
        conversationGeneration: 1,
        now: 2,
      });
      executionId = approved.executionId;
      return coordinator.startNextTask(executionId, 3);
    },
    async ledger() {
      const ledger = await loadPlanExecutionLedger(executionId);
      if (!ledger) throw new Error("ledger missing");
      return ledger;
    },
    async activeTask() {
      const ledger = await harness.ledger();
      const task = ledger.tasks.find(
        (entry) => entry.taskId === ledger.activeTaskId,
      );
      if (!task) throw new Error("no active task");
      return task;
    },
    async run(args, runOptions = {}) {
      const validation = tool.validate(args);
      if (!validation.ok) throw new Error(`invalid input: ${validation.error}`);
      const ledger = await harness.ledger();
      const request = resolvedAgentRequest({
        conversationKey,
        mode: "agent",
        userText: "Execute the approved plan",
        model: runOptions.model || "test-model",
        libraryID,
        planContext: {
          phase: "executing",
          planId,
          revision: 1,
          executionId,
          approvedDigest: ledger.planDigest,
          activeTaskId: ledger.activeTaskId,
          provider: "original",
        },
      });
      if (runOptions.runtimeContextBudget)
        (request as any).runtimeContextBudget = runOptions.runtimeContextBudget;
      const context = {
        request,
        runId: "run-1",
        item: null,
        currentAnswerText: "",
        modelName: request.model || "test-model",
        publishPlanEvent: async () => undefined,
      } as unknown as AgentToolContext;
      return tool.execute(validation.value, context);
    },
    async verifiedRead(keys, depth, readOptions = {}) {
      readCounter += 1;
      const task = await harness.activeTask();
      const requirement = task.completionRequirements?.find(
        (entry) => entry.kind === "verified_read",
      );
      const reference = `run-1:read-${readCounter}`;
      const observations: TrustedReadObservation[] = keys.map((key, index) => {
        const paper = papers.find((entry) => entry.key === key);
        if (!paper) throw new Error(`unknown paper ${key}`);
        const capabilities =
          depth === "body"
            ? (["body"] as const)
            : depth === "abstract"
              ? (["metadata", "abstract"] as const)
              : (["metadata"] as const);
        return {
          version: 1,
          observationId: `${reference}:obs:${index + 1}`,
          issuer: "zotero_host",
          toolName: readOptions.toolName || "paper_read",
          callDigest: `sha256:${reference}:call`,
          inputDigest: `sha256:${reference}:input:${readOptions.mode || "overview"}`,
          resultDigest: `sha256:${reference}:result`,
          libraryID,
          itemKey: key,
          capabilities: [...capabilities],
          readMode: readOptions.mode || "overview",
          ...(depth === "body"
            ? {
                attachmentItemKey: paper.attachmentKey,
                ...(readOptions.pageIndex !== undefined
                  ? { pageIndex: readOptions.pageIndex }
                  : {}),
              }
            : {}),
          certificateDigest: `sha256:${reference}:certificate:${index + 1}`,
        };
      });
      const evidence: TaskEvidence = {
        version: requirement ? 3 : 1,
        evidenceId: `${task.executionId}:${task.taskId}:verified_read:${reference}`,
        executionId: task.executionId,
        taskId: task.taskId,
        kind: "verified_read",
        verified: true,
        requirementId: requirement?.requirementId,
        criterionIds: requirement?.criterionIds,
        contractDigest: requirement?.contractDigest,
        payload: {
          type: "verified_read",
          reference,
          sources: observations.map((observation) => ({
            libraryID: observation.libraryID,
            itemKey: observation.itemKey,
            attachmentItemKey: observation.attachmentItemKey,
            pageIndex: observation.pageIndex,
          })),
          observations,
        },
        reference,
        summary: `Verified result from ${readOptions.toolName || "paper_read"}`,
        createdAt: Date.now() + readCounter,
      };
      await coordinator.attachEvidence(evidence);
      return reference;
    },
    close() {
      db.close();
    },
  };
  return harness;
}

/** A version-1 style adaptive finding that satisfies the legacy validator. */
export function legacyFinding(overrides: Record<string, unknown> = {}) {
  return {
    mainMessage: "Recurrent dynamics implement inference.",
    researchQuestion: "How is latent state computed?",
    method: "Recordings and a model.",
    findings: ["Latent state is decodable."],
    limitations: ["Correlational."],
    relevance: "Central to the review question.",
    confidence: "high",
    ...overrides,
  };
}

/** A claim-based core node that satisfies the default harness frame. */
export function nodeFinding(overrides: Record<string, unknown> = {}) {
  return {
    mainMessage: "Recurrent dynamics implement inference.",
    relevance: "Central to the review question.",
    confidence: "high",
    frameSlots: {
      question: "How is latent state computed?",
      approach: "Recordings and a model.",
      system: "Macaques in a navigation task.",
      sq1: "Bayesian observer.",
      sq2: "Latent state is decodable.",
    },
    claims: [
      {
        statement: "Latent state is decodable.",
        kind: "finding",
        subquestionIds: ["sq2"],
        evidence: { sourceKind: "body" },
      },
      {
        statement: "Recurrent coupling carries the state.",
        kind: "mechanism",
        subquestionIds: ["sq1"],
        evidence: { sourceKind: "body" },
      },
      {
        statement: "Correlational.",
        kind: "limitation",
        subquestionIds: [],
        evidence: { sourceKind: "body" },
      },
    ],
    noLinkSeen: "First paper recorded; no other node to relate yet.",
    ...overrides,
  };
}
