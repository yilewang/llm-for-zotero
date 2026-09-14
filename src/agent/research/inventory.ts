import { TOKEN_ESTIMATE_CHARS_PER_TOKEN } from "../../utils/modelInputCap";
import type { ZoteroGateway } from "../services/zoteroGateway";
import {
  buildReadingManifest,
  selectPreferredReadingAttachment,
  type ReadingManifestEntry,
} from "./reading";
import { getResearchItemFingerprints } from "./scopeSnapshot";
import { assertResearchCorpusUnchanged, commitResearchRecords } from "./stages";
import {
  listPaperFindings,
  listResearchCorpusItems,
  saveResearchCorpusItem,
} from "./store";
import type { ResearchCorpusItem, ResearchJob } from "./types";

import type { ResearchContract, ResearchScopeSnapshotItem } from "./types";
import type { CompleteResearchWorkItem } from "./work";

export async function inventoryResearchScope(params: {
  resumesAdaptiveInventory: boolean;
  job: ResearchJob;
  corpus: ResearchCorpusItem[];
  investigation: ResearchContract;
  snapshotByKey: Map<string, ResearchScopeSnapshotItem>;
  completeWorkItem: CompleteResearchWorkItem;
  gateway: ZoteroGateway;
}) {
  const {
    resumesAdaptiveInventory,
    job,
    corpus,
    investigation,
    snapshotByKey,
    completeWorkItem,
    gateway,
  } = params;
  let inventoriedItems: number | undefined;
  let readingManifest: ReadingManifestEntry[] | undefined;

  if (resumesAdaptiveInventory) {
    const findings = await listPaperFindings(job.researchJobId);
    const recordedIdentities = new Set(
      findings.map((finding) => `${finding.libraryID}:${finding.itemKey}`),
    );
    readingManifest = await buildReadingManifest({
      corpus: corpus.filter(
        (entry) =>
          entry.screeningStatus !== "missing" &&
          !recordedIdentities.has(`${entry.libraryID}:${entry.itemKey}`),
      ),
      gateway,
      requiredEvidenceDepth: investigation.requiredEvidenceDepth,
    });
    inventoriedItems = corpus.filter((entry) => entry.inventoryRecorded).length;
  } else {
    let recorded = 0;
    const preferredReadingContextIds = new Map<string, number>();
    for (const current of corpus) {
      const identity = `${current.libraryID}:${current.itemKey}`;
      const approvedSource = snapshotByKey.get(identity);
      if (!approvedSource) {
        throw new Error(`Paper ${identity} is outside the frozen corpus`);
      }
      const liveItem = Zotero.Items.getByLibraryAndKey(
        current.libraryID,
        current.itemKey,
      );
      if (!liveItem || liveItem.deleted) {
        await commitResearchRecords(job, async () => {
          await assertResearchCorpusUnchanged(job, [current]);
          await saveResearchCorpusItem({
            ...current,
            screeningStatus: "missing",
            inventoryRecorded: true,
            hasAbstract: false,
            attachmentItemKeys: [],
            duplicateAttachmentKeys: [],
            readable: false,
            indexed: false,
            decisionReason:
              "Item is missing from the approved library snapshot",
            updatedAt: Date.now(),
          });
          await completeWorkItem({
            libraryID: current.libraryID,
            itemKey: current.itemKey,
            stage: "inventory",
          });
        });
        recorded += 1;
        continue;
      }
      const attachmentInfos = await gateway.getAllChildAttachmentInfos(
        liveItem.id,
      );
      const preferredReadingAttachment =
        selectPreferredReadingAttachment(attachmentInfos);
      if (preferredReadingAttachment) {
        preferredReadingContextIds.set(
          identity,
          preferredReadingAttachment.contextItemId,
        );
      }
      const attachmentItems = attachmentInfos
        .map((attachment) => gateway.getItem(attachment.contextItemId))
        .filter((attachment): attachment is Zotero.Item => Boolean(attachment));
      const attachmentItemKeys = attachmentItems
        .map((attachment) => String(attachment.key || "").trim())
        .filter(Boolean);
      const seenHashes = new Set<string>();
      const duplicateAttachmentKeys: string[] = [];
      for (const attachment of attachmentItems) {
        const attachmentWithHash = attachment as Zotero.Item & {
          attachmentHash?: string;
          attachmentSyncedHash?: string;
        };
        const hash = String(
          attachmentWithHash.attachmentHash ||
            attachmentWithHash.attachmentSyncedHash ||
            "",
        ).trim();
        if (!hash) continue;
        if (seenHashes.has(hash)) {
          const key = String(attachment.key || "").trim();
          if (key) duplicateAttachmentKeys.push(key);
        } else {
          seenHashes.add(hash);
        }
      }
      let hasLocalReadableAttachment = false;
      for (const attachment of attachmentItems) {
        if (
          !attachmentInfos.some(
            (info) =>
              info.contextItemId === attachment.id &&
              selectPreferredReadingAttachment([info]),
          )
        ) {
          continue;
        }
        try {
          const path = await (
            attachment as Zotero.Item & {
              getFilePathAsync?: () => Promise<string | false>;
            }
          ).getFilePathAsync?.();
          if (
            path &&
            (await (
              globalThis as unknown as {
                IOUtils?: { exists?: (path: string) => Promise<boolean> };
              }
            ).IOUtils?.exists?.(path))
          ) {
            hasLocalReadableAttachment = true;
            break;
          }
        } catch {
          // Remote or missing attachments remain represented by their
          // Zotero index/cache state below.
        }
      }
      const indexed = attachmentInfos.some((attachment) =>
        ["indexed", "partial"].includes(String(attachment.indexingState || "")),
      );
      const readable =
        hasLocalReadableAttachment ||
        indexed ||
        attachmentInfos.some((attachment) =>
          Boolean(attachment.mineruCacheDir),
        );
      const measuredChars = preferredReadingAttachment?.readableTextChars;
      const textTokens =
        measuredChars && measuredChars > 0
          ? Math.ceil(measuredChars / TOKEN_ESTIMATE_CHARS_PER_TOKEN)
          : undefined;
      const liveFingerprints = await getResearchItemFingerprints(
        gateway,
        liveItem.id,
      );
      await commitResearchRecords(job, async () => {
        await assertResearchCorpusUnchanged(job, [current]);
        await saveResearchCorpusItem({
          ...current,
          screeningStatus: "pending",
          inventoryRecorded: true,
          hasAbstract: Boolean(
            String(liveItem.getField?.("abstractNote") || "").trim(),
          ),
          attachmentItemKeys: [...new Set(attachmentItemKeys)],
          duplicateAttachmentKeys: [...new Set(duplicateAttachmentKeys)],
          readable,
          indexed,
          sourceFingerprint:
            liveFingerprints.attachmentFingerprint ||
            liveFingerprints.metadataFingerprint,
          ...(textTokens !== undefined ? { version: 2, textTokens } : {}),
          updatedAt: Date.now(),
        });
        await completeWorkItem({
          libraryID: current.libraryID,
          itemKey: current.itemKey,
          stage: "inventory",
        });
      });
      recorded += 1;
    }
    inventoriedItems = recorded;
    const inventoriedCorpus = await listResearchCorpusItems({
      researchJobId: job.researchJobId,
    });
    readingManifest = await buildReadingManifest({
      corpus: inventoriedCorpus,
      gateway,
      requiredEvidenceDepth: investigation.requiredEvidenceDepth,
      preferredContextItemIds: preferredReadingContextIds,
    });
  }

  return { inventoriedItems, readingManifest };
}
