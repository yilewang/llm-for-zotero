import { renderMarkdownForNote } from "../../utils/markdown";
import { updatePlanTask } from "../plans/taskUpdates";
import type { TaskEvidence } from "../plans/types";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  formatDocumentCitations,
  type DocumentCitationEvidence,
} from "./citationService";
import {
  buildVerificationSummary,
  ensureCoverageSection,
} from "./coverageSection";
import { assertDocumentDraftValid, collectHeadings } from "./draftValidation";
import {
  auditCrossPaperSupport,
  describeUnsupportedParagraphs,
  type SupportAuditEdge,
  type SupportAuditResult,
} from "./supportAudit";
import type { ResearchQualityReport } from "../research/types";
import {
  utf8Bytes,
  validateAssets,
  validateVisibleDocumentPrivacy,
} from "./finalizationValidation";
import {
  materializePlanDocumentAssets,
  savePlanDocumentInTransaction,
} from "./store";
import {
  PLAN_DOCUMENT_MARKDOWN_MAX_BYTES,
  type DocumentArtifactV2,
  type DocumentSpec,
  type PlanDocumentOutboxRecord,
  type SubmitPlanDocumentInput,
} from "./types";
import { resolveVerifiedQuotes } from "./verifiedQuotes";
import { ToolInputRejection } from "../tools/execution/failure";

type DocumentFinalizationContext = Pick<
  DocumentArtifactV2,
  | "documentId"
  | "documentVersion"
  | "conversationKey"
  | "origin"
  | "integrityPolicy"
  | "coverageStatus"
  | "coverageItems"
> & {
  spec: DocumentSpec;
  corpus: readonly { libraryID: number; itemKey: string }[];
  evidence: readonly DocumentCitationEvidence[];
  quoteCorpusKeys: ReadonlySet<string>;
  /** Source owners attest figures against their native observations or research ledger. */
  validateAssetProvenance: () => void | Promise<void>;
  /**
   * The research network behind a research-grounded document: the edges the
   * support audit checks and the rubric the calibration paragraph reports.
   */
  researchGraph?: Readonly<{
    edges: readonly SupportAuditEdge[];
    qualityReport?: ResearchQualityReport;
  }>;
};

type FinalizedDocument = {
  document: DocumentArtifactV2;
  outbox: PlanDocumentOutboxRecord;
  supportAudit?: SupportAuditResult;
};

/** One integrity pipeline for every origin; source acquisition stays with its owner. */
export async function finalizeDocument(params: {
  gateway: ZoteroGateway;
  input: SubmitPlanDocumentInput;
  context: DocumentFinalizationContext;
  now: number;
}): Promise<FinalizedDocument> {
  const { input, context, now } = params;
  const { spec, origin } = context;
  const planned = origin.kind === "planned";
  const researchGrounded = context.integrityPolicy === "research_grounded";
  // Plans retain their approved evidence requirements, including authored plans.
  const requireEvidence = planned || researchGrounded;
  const submittedTitle = input.title.trim();
  if (!submittedTitle)
    throw new ToolInputRejection("Document title is required");
  // The approved spec owns the title. A differing submission is a format
  // problem the host repairs (title and leading H1), not a reason to discard a
  // finished document.
  const title = spec.title;
  const titledMarkdown =
    submittedTitle === title
      ? input.markdown
      : input.markdown.replace(
          /^([ \t]*#[ \t]+)(.+?)[ \t]*$/m,
          (line, hashes: string, heading: string) =>
            heading.trim() === submittedTitle ? `${hashes}${title}` : line,
        );
  if (!spec.allowFigures && input.assets.length)
    throw new ToolInputRejection(
      "The approved document spec does not allow figures",
    );
  if (utf8Bytes(titledMarkdown) > PLAN_DOCUMENT_MARKDOWN_MAX_BYTES)
    throw new ToolInputRejection("Document Markdown exceeds the 2 MiB limit");
  // A valid citation is not a supported claim: every synthesis paragraph that
  // cites two or more papers must rest on recorded relationships. The repair
  // is to record the missing edge (still allowed while the document task is
  // active) or to rewrite the sentence as separate claims.
  const supportAudit = context.researchGraph
    ? auditCrossPaperSupport({
        markdown: titledMarkdown,
        clusters: input.citations,
        edges: context.researchGraph.edges,
      })
    : undefined;
  if (supportAudit?.unsupported.length) {
    throw new ToolInputRejection(
      `Document support audit failed: ${supportAudit.unsupported.length} cross-paper paragraph${
        supportAudit.unsupported.length === 1 ? "" : "s"
      } cite papers with no recorded relationship between them.\n${describeUnsupportedParagraphs(
        supportAudit.unsupported,
      )}\nRecord the relationship with research_update record_edges (source, target, type, statement, confidence) and resubmit, or rewrite those sentences as separate per-paper claims.`,
    );
  }
  // Calibration is host data: what was read, how deeply, what was verified.
  // It joins the model's scope-and-limitations section, or becomes that
  // section when the model omitted it, instead of rejecting the document.
  const calibratedMarkdown =
    context.researchGraph && spec.requiresCoverageSection
      ? ensureCoverageSection({
          markdown: titledMarkdown,
          summary: buildVerificationSummary({
            coverageItems: context.coverageItems,
            report: context.researchGraph?.qualityReport,
          }),
        })
      : titledMarkdown;
  assertDocumentDraftValid({
    markdown: calibratedMarkdown,
    requiredSections: spec.requiredSections,
    requiresCoverageSection: spec.requiresCoverageSection,
    validateQuotes: planned,
  });
  if (
    !planned &&
    !researchGrounded &&
    collectHeadings(calibratedMarkdown).size === 0
  )
    throw new ToolInputRejection(
      "A document must contain at least one Markdown heading",
    );
  validateVisibleDocumentPrivacy(calibratedMarkdown);
  validateAssets(input.assets, requireEvidence);
  if (
    input.groundingReviewed === "passed_with_limitations" &&
    !input.groundingIssues.length
  )
    throw new ToolInputRejection(
      "A grounding review with limitations must record the detected issues",
    );
  const resolvedQuotes = await resolveVerifiedQuotes({
    markdown: calibratedMarkdown,
    quotes: input.quotes,
    corpusKeys: context.quoteCorpusKeys,
    evidenceByRef: new Map(
      context.evidence.map((entry) => [entry.evidenceRef, entry]),
    ),
  });
  validateVisibleDocumentPrivacy(resolvedQuotes.markdown);
  await context.validateAssetProvenance();
  const formatted = await formatDocumentCitations({
    gateway: params.gateway,
    draftMarkdown: resolvedQuotes.markdown,
    clusters: input.citations,
    corpus: context.corpus,
    evidence: context.evidence,
    spec,
    requireEvidence,
  });
  if (utf8Bytes(formatted.visibleMarkdown) > PLAN_DOCUMENT_MARKDOWN_MAX_BYTES)
    throw new ToolInputRejection("Finalized document exceeds the 2 MiB limit");
  // Check the complete visible payload before copying any assets or publishing it.
  const assets = await materializePlanDocumentAssets(input.assets);
  const validation: DocumentArtifactV2["validation"] = {
    integrityValidated: true,
    groundingReviewed: requireEvidence ? input.groundingReviewed : "not_run",
    quoteVerified: resolvedQuotes.verifiedQuotes.length
      ? "verified"
      : "not_applicable",
    issues: [...input.groundingIssues],
  };
  const contentHash = `sha256:${await sha256Text(
    canonicalJson({
      title,
      markdown: formatted.visibleMarkdown,
      citations: formatted.citationBundle,
      verifiedQuotes: resolvedQuotes.verifiedQuotes,
      assets,
      coverageItems: context.coverageItems,
      // Preserve the existing per-origin content identity for durable retries.
      ...(origin.kind === "planned"
        ? {
            coverageStatus: context.coverageStatus,
            scopeLineageDigest: origin.scopeLineageDigest,
          }
        : {}),
      validation,
    }),
  )}`;
  const document: DocumentArtifactV2 = {
    version: 2,
    documentId: context.documentId,
    documentVersion: context.documentVersion,
    documentKind: spec.kind,
    integrityPolicy: context.integrityPolicy,
    origin,
    conversationKey: context.conversationKey,
    title,
    visibleMarkdown: formatted.visibleMarkdown,
    visibleHtml: renderMarkdownForNote(formatted.visibleMarkdown),
    citationBundle: formatted.citationBundle,
    verifiedQuotes: resolvedQuotes.verifiedQuotes,
    assets,
    coverageStatus: context.coverageStatus,
    coverageItems: context.coverageItems,
    validation,
    contentHash,
    createdAt: now,
  };
  return {
    document,
    ...(supportAudit ? { supportAudit } : {}),
    outbox: {
      version: 1,
      outboxId: `${document.documentId}:message`,
      documentId: document.documentId,
      conversationKey: document.conversationKey,
      messageTimestamp: now,
      visibleMarkdown: document.visibleMarkdown,
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** Persist the document, pending outbox, and any Plan integrity evidence together. */
export async function persistFinalizedDocument(
  finalized: FinalizedDocument,
  evidence?: TaskEvidence,
): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await savePlanDocumentInTransaction(finalized);
    if (evidence)
      await updatePlanTask({
        kind: "evidence",
        executionId: evidence.executionId,
        taskId: evidence.taskId,
        evidence: [evidence],
        now: evidence.createdAt,
        alreadyInTransaction: true,
      });
  });
}
