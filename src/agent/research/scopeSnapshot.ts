import type { ZoteroGateway } from "../services/zoteroGateway";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { RESEARCH_POLICY_VERSION } from "./policy";
import { saveScopeSnapshot } from "./store";
import type {
  ResearchScopeSnapshotItem,
  ResearchScopeSnapshotRef,
  ResearchScopeSpec,
} from "./types";
import type { TagContextRef } from "../../shared/types";

function itemByLibraryAndKey(
  libraryID: number,
  itemKey: string,
): Zotero.Item | null {
  const items = Zotero.Items as unknown as {
    getByLibraryAndKey?: (
      libraryID: number,
      itemKey: string,
    ) => Zotero.Item | false | undefined;
  };
  return items.getByLibraryAndKey?.(libraryID, itemKey) || null;
}

export async function getResearchItemFingerprints(
  gateway: ZoteroGateway,
  itemId: number,
): Promise<{
  metadataFingerprint: string;
  attachmentFingerprint?: string;
}> {
  const item = gateway.getItem(itemId);
  if (!item) {
    return { metadataFingerprint: "missing" };
  }
  const target = gateway.getBibliographicItemTargetsByItemIds([itemId])[0];
  const metadataFingerprint = `sha256:${await sha256Text(
    canonicalJson({
      key: String(item.key || ""),
      version: Number(
        (item as Zotero.Item & { version?: number }).version || 0,
      ),
      dateModified: String(item.getField?.("dateModified") || ""),
      title: target?.title || "",
      creators: item.getCreators?.() || [],
      tags: target?.tags || [],
    }),
  )}`;
  const attachments = await Promise.all(
    (target?.attachments || []).map(async (attachment) => {
      const attachmentItem = gateway.getItem(attachment.contextItemId) as
        | (Zotero.Item & {
            attachmentModificationTime?: number;
            attachmentSyncedModificationTime?: number;
            attachmentSyncedHash?: string;
            attachmentContentType?: string;
            getFilePathAsync?: () => Promise<string | false>;
          })
        | null;
      let fileState: { size?: number; lastModified?: number } | undefined;
      try {
        const path = await attachmentItem?.getFilePathAsync?.();
        const stat = path
          ? await (globalThis as unknown as { IOUtils?: any }).IOUtils?.stat?.(
              path,
            )
          : undefined;
        if (stat) {
          fileState = {
            size: Number.isFinite(Number(stat.size))
              ? Number(stat.size)
              : undefined,
            lastModified: Number.isFinite(Number(stat.lastModified))
              ? Number(stat.lastModified)
              : undefined,
          };
        }
      } catch {
        // Some linked or remote attachments have no local file. Zotero's own
        // attachment sync fingerprint remains part of the source identity.
      }
      return {
        key: String(attachmentItem?.key || ""),
        modified: Number(attachmentItem?.attachmentModificationTime || 0),
        syncedModified: Number(
          attachmentItem?.attachmentSyncedModificationTime || 0,
        ),
        syncedHash: String(attachmentItem?.attachmentSyncedHash || ""),
        contentType: String(attachmentItem?.attachmentContentType || ""),
        fileState,
      };
    }),
  );
  return {
    metadataFingerprint,
    attachmentFingerprint: attachments.length
      ? `sha256:${await sha256Text(canonicalJson(attachments))}`
      : undefined,
  };
}

export async function resolveResearchScopeItemIds(
  gateway: ZoteroGateway,
  scope: ResearchScopeSpec,
): Promise<number[]> {
  const itemKeys = "itemKeys" in scope ? scope.itemKeys || [] : [];
  const collectionIds =
    "collectionIds" in scope ? scope.collectionIds || [] : [];
  const tagNames = "tagNames" in scope ? scope.tagNames || [] : [];
  if (
    scope.kind === "library" &&
    ("itemKeys" in scope ||
      "collectionIds" in scope ||
      "tagNames" in scope ||
      "includeAutomaticTags" in scope)
  ) {
    throw new Error("Whole-library research scope does not accept filters");
  }
  if (scope.kind === "items" && !itemKeys.length) {
    throw new Error("Item research scope requires nonempty item keys");
  }
  if (scope.kind === "collections" && !collectionIds.length) {
    throw new Error("Collection research scope requires collection filters");
  }
  if (scope.kind === "tags" && !tagNames.length) {
    throw new Error("Tag research scope requires tag filters");
  }
  if (
    scope.kind === "mixed" &&
    !itemKeys.length &&
    !collectionIds.length &&
    !tagNames.length
  ) {
    throw new Error("Mixed research scope requires at least one filter");
  }
  const resolvedKeys = itemKeys.map((itemKey) => ({
    itemKey,
    itemId: itemByLibraryAndKey(scope.libraryID, itemKey)?.id || 0,
  }));
  const missingKeys = resolvedKeys
    .filter((entry) => entry.itemId <= 0)
    .map((entry) => entry.itemKey);
  if (missingKeys.length) {
    throw new Error(
      `Research scope contains unresolved item keys: ${missingKeys.join(", ")}`,
    );
  }
  const explicitIds = resolvedKeys.map((entry) => entry.itemId);
  if (scope.kind === "library") {
    const listed = await gateway.listBibliographicItemTargets({
      libraryID: scope.libraryID,
    });
    return listed.items.map((item) => item.itemId);
  }
  const tagContexts: TagContextRef[] = tagNames.map((name) => ({
    name,
    normalizedName: name.trim().toLowerCase(),
    libraryID: scope.libraryID,
    includeAutomatic:
      "includeAutomaticTags" in scope && scope.includeAutomaticTags === true,
  }));
  const resolved = await gateway.resolveLibraryScopeItemIds({
    libraryID: scope.libraryID,
    itemIds: explicitIds,
    collectionIds: [...collectionIds],
    tagContexts,
  });
  if (!resolved.itemIds.length) {
    throw new Error(
      `Explicit research scope resolved to zero items${
        itemKeys.length ? `; requested item keys: ${itemKeys.join(", ")}` : ""
      }`,
    );
  }
  return resolved.itemIds;
}

export function assertResearchScopeTargets(params: {
  scope: ResearchScopeSpec;
  targetItemIds: readonly number[];
}): void {
  if (params.scope.kind === "library") return;
  const bibliographicIds = new Set(params.targetItemIds);
  const explicitItemKeys =
    "itemKeys" in params.scope ? params.scope.itemKeys || [] : [];
  const nonBibliographicKeys = explicitItemKeys.filter((itemKey) => {
    const item = itemByLibraryAndKey(params.scope.libraryID, itemKey);
    return !item || !bibliographicIds.has(item.id);
  });
  if (nonBibliographicKeys.length) {
    throw new Error(
      `Research scope item keys are not bibliographic corpus items: ${nonBibliographicKeys.join(", ")}`,
    );
  }
  if (!params.targetItemIds.length) {
    throw new Error(
      "Explicit research scope resolved to zero bibliographic items",
    );
  }
}

export async function materializeResearchScopeSnapshot(params: {
  gateway: ZoteroGateway;
  planId: string;
  revision: number;
  conversationKey: number;
  scope: ResearchScopeSpec;
  now?: number;
}): Promise<{
  ref: ResearchScopeSnapshotRef;
  items: ResearchScopeSnapshotItem[];
}> {
  const createdAt = params.now ?? Date.now();
  const snapshotId = `${params.planId}:r${params.revision}:scope`;
  const resolvedItemIds = await resolveResearchScopeItemIds(
    params.gateway,
    params.scope,
  );
  const targets =
    params.gateway.getBibliographicItemTargetsByItemIds(resolvedItemIds);
  assertResearchScopeTargets({
    scope: params.scope,
    targetItemIds: targets.map((target) => target.itemId),
  });
  const items: ResearchScopeSnapshotItem[] = [];
  for (let ordinal = 0; ordinal < targets.length; ordinal += 1) {
    const target = targets[ordinal];
    const item = params.gateway.getItem(target.itemId);
    const itemKey = String(item?.key || "").trim();
    if (!itemKey) continue;
    const fingerprints = await getResearchItemFingerprints(
      params.gateway,
      target.itemId,
    );
    items.push({
      snapshotId,
      libraryID: params.scope.libraryID,
      itemKey,
      localItemId: target.itemId,
      title: target.title,
      firstCreator: target.firstCreator,
      year: target.year,
      ...fingerprints,
      ordinal: items.length,
    });
  }
  if (params.scope.kind !== "library" && !items.length) {
    throw new Error("Explicit research scope resolved to zero usable items");
  }
  const digest = `sha256:${await sha256Text(
    canonicalJson(
      items.map(
        ({
          libraryID,
          itemKey,
          title,
          firstCreator,
          year,
          metadataFingerprint,
          attachmentFingerprint,
        }) => ({
          libraryID,
          itemKey,
          title,
          firstCreator,
          year,
          metadataFingerprint,
          attachmentFingerprint,
        }),
      ),
    ),
  )}`;
  const ref: ResearchScopeSnapshotRef = {
    snapshotId,
    digest,
    itemCount: items.length,
    createdAt,
    policyVersion: RESEARCH_POLICY_VERSION,
  };
  await saveScopeSnapshot({
    planId: params.planId,
    revision: params.revision,
    conversationKey: params.conversationKey,
    ref,
    items,
  });
  return { ref, items };
}

export async function buildResearchScopeSuccessorSnapshot(params: {
  gateway: ZoteroGateway;
  planId: string;
  revision: number;
  priorRef: ResearchScopeSnapshotRef;
  priorItems: readonly ResearchScopeSnapshotItem[];
  scope: ResearchScopeSpec;
  addedTargets: readonly Readonly<{ libraryID: number; itemKey: string }>[];
  priorLineageDigest: string;
  now?: number;
}): Promise<{
  ref: ResearchScopeSnapshotRef;
  items: ResearchScopeSnapshotItem[];
  addedItems: ResearchScopeSnapshotItem[];
}> {
  if (!params.addedTargets.length) {
    throw new Error("A research-scope amendment requires at least one target");
  }
  const duplicateInput = params.addedTargets.find(
    (target, index) =>
      params.addedTargets.findIndex(
        (candidate) =>
          candidate.libraryID === target.libraryID &&
          candidate.itemKey === target.itemKey,
      ) !== index,
  );
  if (duplicateInput) {
    throw new Error(
      `Research-scope amendment repeats target ${duplicateInput.libraryID}:${duplicateInput.itemKey}`,
    );
  }
  if (
    params.addedTargets.some(
      (target) => target.libraryID !== params.scope.libraryID,
    )
  ) {
    throw new Error(
      "Research-scope amendment crosses the approved Zotero library",
    );
  }
  const priorKeys = new Set(
    params.priorItems.map((item) => `${item.libraryID}:${item.itemKey}`),
  );
  const duplicateExisting = params.addedTargets.find((target) =>
    priorKeys.has(`${target.libraryID}:${target.itemKey}`),
  );
  if (duplicateExisting) {
    throw new Error(
      `Research target ${duplicateExisting.libraryID}:${duplicateExisting.itemKey} is already in the effective snapshot`,
    );
  }
  const currentSourceIds = new Set(
    await resolveResearchScopeItemIds(params.gateway, params.scope),
  );
  const resolved = params.addedTargets.map((target) => ({
    ...target,
    item: itemByLibraryAndKey(target.libraryID, target.itemKey),
  }));
  const invalid = resolved.find(
    ({ item }) => !item || !currentSourceIds.has(item.id),
  );
  if (invalid) {
    throw new Error(
      `Research target ${invalid.libraryID}:${invalid.itemKey} is missing, nonbibliographic, or outside the approved source`,
    );
  }
  const targets = params.gateway.getBibliographicItemTargetsByItemIds(
    resolved.map(({ item }) => item!.id),
  );
  const targetById = new Map(targets.map((target) => [target.itemId, target]));
  if (targetById.size !== resolved.length) {
    throw new Error(
      "Every research-scope amendment target must be a bibliographic Zotero item",
    );
  }
  const createdAt = params.now ?? Date.now();
  const provisionalAdded: Omit<ResearchScopeSnapshotItem, "snapshotId">[] = [];
  for (const { item, libraryID, itemKey } of resolved) {
    const target = targetById.get(item!.id)!;
    provisionalAdded.push({
      libraryID,
      itemKey,
      localItemId: item!.id,
      title: target.title,
      firstCreator: target.firstCreator,
      year: target.year,
      ...(await getResearchItemFingerprints(params.gateway, item!.id)),
      ordinal: params.priorItems.length + provisionalAdded.length,
    });
  }
  const digestPayload = [
    ...params.priorItems.map(
      ({
        libraryID,
        itemKey,
        title,
        firstCreator,
        year,
        metadataFingerprint,
        attachmentFingerprint,
      }) => ({
        libraryID,
        itemKey,
        title,
        firstCreator,
        year,
        metadataFingerprint,
        attachmentFingerprint,
      }),
    ),
    ...provisionalAdded.map(
      ({
        libraryID,
        itemKey,
        title,
        firstCreator,
        year,
        metadataFingerprint,
        attachmentFingerprint,
      }) => ({
        libraryID,
        itemKey,
        title,
        firstCreator,
        year,
        metadataFingerprint,
        attachmentFingerprint,
      }),
    ),
  ];
  const digest = `sha256:${await sha256Text(canonicalJson(digestPayload))}`;
  const snapshotId = `${params.planId}:r${params.revision}:scope:${digest.slice(-16)}`;
  const items = [
    ...params.priorItems.map((item) => ({ ...item, snapshotId })),
    ...provisionalAdded.map((item) => ({ ...item, snapshotId })),
  ];
  const addedItems = items.slice(params.priorItems.length);
  const scopeLineageDigest = `sha256:${await sha256Text(
    canonicalJson({
      priorLineageDigest: params.priorLineageDigest,
      parentSnapshotId: params.priorRef.snapshotId,
      snapshotId,
      digest,
      addedTargets: params.addedTargets,
    }),
  )}`;
  return {
    ref: {
      snapshotId,
      digest,
      itemCount: items.length,
      createdAt,
      policyVersion: RESEARCH_POLICY_VERSION,
      parentSnapshotId: params.priorRef.snapshotId,
      scopeLineageDigest,
    },
    items,
    addedItems,
  };
}
