declare const Zotero: any;

import {
  buildDefaultClaudeGlobalConversationKey,
  buildDefaultClaudePaperConversationKey,
} from "../../claudeCode/constants";
import {
  buildDefaultCodexGlobalConversationKey,
  buildDefaultCodexPaperConversationKey,
} from "../../codexAppServer/constants";
import { buildDefaultUpstreamGlobalConversationKey } from "../../shared/conversationKeySpace";
import {
  getConversationKeyLedgerEntry,
  initConversationKeyLedgerStore,
  isConversationKeyLedgerStoreInitialized,
} from "../../shared/conversationKeyLedger";
import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "../../core/conversations/repository";
import { resolveConversationStorageSystem } from "../../shared/conversationStorageRouting";
import type { ConversationSystem } from "../../shared/types";
import {
  bindProvisionedConversationKey,
  getConversationKey,
} from "./conversationIdentity";
import {
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "./state";
import {
  buildPaperStateKey,
  getLastUsedPaperConversationKey,
  getLastUsedUpstreamGlobalConversationKey,
  setLastUsedPaperConversationKey,
  setLastUsedUpstreamGlobalConversationKey,
} from "./prefHelpers";
import {
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../../claudeCode/state";
import {
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  setLastUsedClaudeGlobalConversationKey,
  setLastUsedClaudePaperConversationKey,
} from "../../claudeCode/prefs";
import {
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../codexAppServer/state";
import {
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "../../codexAppServer/prefs";
import {
  resolveActiveNoteSession,
  resolveConversationBaseItem,
  resolveConversationKeyForNoteFocus,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
  resolvePreferredConversationSystem,
} from "./portalScope";

type ConversationKind = "global" | "paper";

// A full item-pane render intentionally starts conversation loading from both
// the deferred onRender path and onAsyncRender.  Provisioning performs several
// read-then-create decisions, including replacement of a retired deterministic
// key, so coalesce the whole identity decision.  Each caller still binds the
// shared result to its own item object after this promise resolves.
const inFlightConversationProvisions = new Map<
  string,
  Promise<ConversationCatalogEntry | null>
>();

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function sameRuntimeScope(
  summary: ConversationCatalogEntry | null,
  params: {
    kind: ConversationKind;
    libraryID: number;
    paperItemID?: number | null;
  },
): summary is ConversationCatalogEntry {
  if (!summary) return false;
  if (summary.kind !== params.kind) return false;
  if (summary.libraryID !== params.libraryID) return false;
  if (params.kind === "paper") {
    return (summary.paperItemID || null) === (params.paperItemID || null);
  }
  return true;
}

function bindSyntheticPortalItemToEntry(
  item: Zotero.Item,
  entry: ConversationCatalogEntry | null,
): void {
  if (!entry || !item || typeof item !== "object") return;
  const candidate = item as Zotero.Item & {
    __llmGlobalPortalItem?: boolean;
    __llmPaperPortalItem?: boolean;
    __llmClaudeGlobalPortalItem?: boolean;
    __llmClaudePaperPortalItem?: boolean;
    __llmCodexGlobalPortalItem?: boolean;
    __llmCodexPaperPortalItem?: boolean;
    id: number;
  };
  if (
    candidate.__llmGlobalPortalItem ||
    candidate.__llmPaperPortalItem ||
    candidate.__llmClaudeGlobalPortalItem ||
    candidate.__llmClaudePaperPortalItem ||
    candidate.__llmCodexGlobalPortalItem ||
    candidate.__llmCodexPaperPortalItem
  ) {
    candidate.id = entry.conversationKey;
  }
}

function resolveProvisionScope(
  item: Zotero.Item,
  system: ConversationSystem,
): {
  conversationKey: number;
  kind: ConversationKind;
  libraryID: number;
  paperItemID?: number;
} | null {
  const noteScope = resolveActiveNoteSession(item);
  const conversationKey = normalizePositiveInt(
    noteScope
      ? resolveConversationKeyForNoteFocus(item, { conversationSystem: system })
      : getConversationKey(item),
  );
  const kind = resolveDisplayConversationKind(item);
  if (!conversationKey || !kind) return null;
  if (kind === "global") {
    const libraryID = normalizePositiveInt(item?.libraryID);
    return libraryID
      ? {
          conversationKey,
          kind,
          libraryID,
        }
      : null;
  }
  const baseItem = resolveConversationBaseItem(item);
  const paperItemID = normalizePositiveInt(baseItem?.id);
  const libraryID = normalizePositiveInt(
    baseItem?.libraryID || item?.libraryID,
  );
  if (!libraryID || !paperItemID) return null;
  return {
    conversationKey,
    kind,
    libraryID,
    paperItemID,
  };
}

function isRememberedScopeKey(
  system: ConversationSystem,
  scope: {
    kind: ConversationKind;
    libraryID: number;
    paperItemID?: number;
    conversationKey: number;
  },
): boolean {
  if (scope.kind === "global") {
    if (system === "upstream") {
      return (
        activeGlobalConversationByLibrary.get(scope.libraryID) ===
          scope.conversationKey ||
        getLastUsedUpstreamGlobalConversationKey(scope.libraryID) ===
          scope.conversationKey
      );
    }
    if (system === "claude_code") {
      return (
        activeClaudeGlobalConversationByLibrary.get(
          buildClaudeLibraryStateKey(scope.libraryID),
        ) === scope.conversationKey ||
        getLastUsedClaudeGlobalConversationKey(scope.libraryID) ===
          scope.conversationKey
      );
    }
    return (
      activeCodexGlobalConversationByLibrary.get(
        buildCodexLibraryStateKey(scope.libraryID),
      ) === scope.conversationKey ||
      getLastUsedCodexGlobalConversationKey(scope.libraryID) ===
        scope.conversationKey
    );
  }
  if (!scope.paperItemID) return false;
  if (system === "upstream") {
    return (
      activePaperConversationByPaper.get(
        buildPaperStateKey(scope.libraryID, scope.paperItemID),
      ) === scope.conversationKey ||
      getLastUsedPaperConversationKey(scope.libraryID, scope.paperItemID) ===
        scope.conversationKey
    );
  }
  if (system === "claude_code") {
    return (
      activeClaudePaperConversationByPaper.get(
        buildClaudePaperStateKey(scope.libraryID, scope.paperItemID),
      ) === scope.conversationKey ||
      getLastUsedClaudePaperConversationKey(
        scope.libraryID,
        scope.paperItemID,
      ) === scope.conversationKey
    );
  }
  return (
    activeCodexPaperConversationByPaper.get(
      buildCodexPaperStateKey(scope.libraryID, scope.paperItemID),
    ) === scope.conversationKey ||
    getLastUsedCodexPaperConversationKey(scope.libraryID, scope.paperItemID) ===
      scope.conversationKey
  );
}

export function resolveConversationStorageSystemForItem(params: {
  item: Zotero.Item;
  conversationSystem?: ConversationSystem | null;
}): ConversationSystem | null {
  const noteScope = resolveActiveNoteSession(params.item);
  const requestedSystem =
    params.conversationSystem ||
    resolveConversationSystemForItem(params.item) ||
    (noteScope
      ? resolvePreferredConversationSystem({ item: params.item })
      : null) ||
    "upstream";
  const conversationKey = normalizePositiveInt(
    noteScope
      ? resolveConversationKeyForNoteFocus(params.item, {
          conversationSystem: requestedSystem,
        })
      : getConversationKey(params.item),
  );
  if (!conversationKey) return null;
  const itemSystem = resolveConversationSystemForItem(params.item);
  return resolveConversationStorageSystem({
    conversationKey,
    conversationSystem: itemSystem || params.conversationSystem,
  });
}

async function provisionUpstreamConversation(scope: {
  conversationKey: number;
  kind: ConversationKind;
  libraryID: number;
  paperItemID?: number;
}): Promise<ConversationCatalogEntry | null> {
  const existing = await conversationRepository.ensureCatalogEntry({
    system: "upstream",
    conversationKey: scope.conversationKey,
    kind: scope.kind,
    libraryID: scope.libraryID,
    paperItemID: scope.paperItemID,
  });
  const existingLedger =
    existing && isConversationKeyLedgerStoreInitialized()
      ? await getConversationKeyLedgerEntry(existing.conversationKey)
      : null;
  const ledgerReady = isConversationKeyLedgerStoreInitialized();
  if (
    existing &&
    (!ledgerReady || (existingLedger && !existingLedger.retiredAt))
  ) {
    return rememberProvisionedConversation(scope, existing) ? existing : null;
  }
  const expectedKey =
    scope.kind === "global"
      ? buildDefaultUpstreamGlobalConversationKey(scope.libraryID)
      : scope.paperItemID;
  const rememberedKey = isRememberedScopeKey("upstream", scope);
  if (
    !expectedKey ||
    (scope.conversationKey !== expectedKey && !rememberedKey)
  ) {
    return null;
  }
  // A remembered preference can outlive a failed/aborted allocation and point
  // at a key with no catalog row.  If the deterministic default still owns a
  // live conversation for this scope, prefer that exact row instead of
  // creating a second empty conversation merely because the preference is
  // stale.  Only allocate a replacement when the default is absent or retired.
  if (!existing && expectedKey !== scope.conversationKey) {
    const expectedEntry = await conversationRepository.getCatalogEntry({
      system: "upstream",
      kind: scope.kind,
      conversationKey: expectedKey,
    });
    const expectedLedger =
      expectedEntry && ledgerReady
        ? await getConversationKeyLedgerEntry(expectedEntry.conversationKey)
        : null;
    if (
      expectedEntry &&
      sameRuntimeScope(expectedEntry, scope) &&
      (!ledgerReady || (expectedLedger && !expectedLedger.retiredAt))
    ) {
      return rememberProvisionedConversation(scope, expectedEntry)
        ? expectedEntry
        : null;
    }
  }
  const ledger = isConversationKeyLedgerStoreInitialized()
    ? await getConversationKeyLedgerEntry(scope.conversationKey)
    : null;
  const preferred =
    !existing && !ledger
      ? await conversationRepository.createCatalogEntry({
          system: "upstream",
          kind: scope.kind,
          libraryID: scope.libraryID,
          paperItemID: scope.paperItemID,
          preferredConversationKey: scope.conversationKey,
        })
      : null;
  if (preferred) {
    return rememberProvisionedConversation(scope, preferred) ? preferred : null;
  }
  if (
    !ledger?.retiredAt &&
    !(existing && ledgerReady && !ledger) &&
    !rememberedKey
  ) {
    return null;
  }
  const replacement = await conversationRepository.createCatalogEntry({
    system: "upstream",
    kind: scope.kind,
    libraryID: scope.libraryID,
    paperItemID: scope.paperItemID,
  });
  return replacement && rememberProvisionedConversation(scope, replacement)
    ? replacement
    : null;
}

function buildConversationProvisionKey(
  system: ConversationSystem,
  scope: {
    conversationKey: number;
    kind: ConversationKind;
    libraryID: number;
    paperItemID?: number;
  },
): string {
  return [
    system,
    scope.kind,
    scope.libraryID,
    scope.paperItemID || 0,
    scope.conversationKey,
  ].join(":");
}

async function provisionConversationEntry(
  system: ConversationSystem,
  scope: {
    conversationKey: number;
    kind: ConversationKind;
    libraryID: number;
    paperItemID?: number;
  },
): Promise<ConversationCatalogEntry | null> {
  const inFlightKey = buildConversationProvisionKey(system, scope);
  const inFlight = inFlightConversationProvisions.get(inFlightKey);
  if (inFlight) return inFlight;

  const provision = provisionConversationEntryUncoalesced(system, scope);
  inFlightConversationProvisions.set(inFlightKey, provision);
  try {
    return await provision;
  } finally {
    if (inFlightConversationProvisions.get(inFlightKey) === provision) {
      inFlightConversationProvisions.delete(inFlightKey);
    }
  }
}

async function provisionConversationEntryUncoalesced(
  system: ConversationSystem,
  scope: {
    conversationKey: number;
    kind: ConversationKind;
    libraryID: number;
    paperItemID?: number;
  },
): Promise<ConversationCatalogEntry | null> {
  const currentLedger = await getConversationKeyLedgerEntry(
    scope.conversationKey,
  );
  if (currentLedger?.retiredAt) {
    // A deterministic paper/library key can be reused as a Zotero item ID
    // after its conversation was deleted.  Never let the stale catalog witness
    // win the first lookup; allocate exactly one fresh immutable identity.
    const replacement = await conversationRepository.createCatalogEntry({
      system,
      kind: scope.kind,
      libraryID: scope.libraryID,
      paperItemID: scope.paperItemID,
    });
    return replacement && rememberProvisionedConversation(scope, replacement)
      ? replacement
      : null;
  }
  if (system === "upstream") {
    return provisionUpstreamConversation(scope);
  }
  return system === "claude_code"
    ? provisionClaudeConversation(scope)
    : provisionCodexConversation(scope);
}

async function provisionRuntimeConversationUncoalesced(
  system: "claude_code" | "codex",
  scope: {
    conversationKey: number;
    kind: ConversationKind;
    libraryID: number;
    paperItemID?: number;
  },
): Promise<ConversationCatalogEntry | null> {
  const existing = await conversationRepository.getCatalogEntry({
    system,
    kind: scope.kind,
    conversationKey: scope.conversationKey,
  });
  const existingLedger =
    existing && isConversationKeyLedgerStoreInitialized()
      ? await getConversationKeyLedgerEntry(existing.conversationKey)
      : null;
  const ledgerReady = isConversationKeyLedgerStoreInitialized();
  if (
    sameRuntimeScope(existing, scope) &&
    (!ledgerReady || (existingLedger && !existingLedger.retiredAt))
  ) {
    const ensured = await conversationRepository.ensureCatalogEntry({
      system,
      conversationKey: scope.conversationKey,
      kind: scope.kind,
      libraryID: scope.libraryID,
      paperItemID: scope.paperItemID,
    });
    return rememberProvisionedConversation(scope, ensured) ? ensured : null;
  }
  if (scope.kind === "global") {
    const expectedKey =
      system === "claude_code"
        ? buildDefaultClaudeGlobalConversationKey(scope.libraryID)
        : buildDefaultCodexGlobalConversationKey(scope.libraryID);
    const rememberedKey = isRememberedScopeKey(system, scope);
    if (scope.conversationKey !== expectedKey && !rememberedKey) return null;
    if (!existing && expectedKey !== scope.conversationKey) {
      const expectedEntry = await conversationRepository.getCatalogEntry({
        system,
        kind: "global",
        conversationKey: expectedKey,
      });
      const expectedLedger =
        expectedEntry && ledgerReady
          ? await getConversationKeyLedgerEntry(expectedEntry.conversationKey)
          : null;
      if (
        expectedEntry &&
        sameRuntimeScope(expectedEntry, scope) &&
        (!ledgerReady || (expectedLedger && !expectedLedger.retiredAt))
      ) {
        return rememberProvisionedConversation(scope, expectedEntry)
          ? expectedEntry
          : null;
      }
    }
    const ledger = isConversationKeyLedgerStoreInitialized()
      ? await getConversationKeyLedgerEntry(scope.conversationKey)
      : null;
    const ensured =
      !existing && !ledger
        ? await conversationRepository.createCatalogEntry({
            system,
            kind: "global",
            libraryID: scope.libraryID,
            preferredConversationKey: scope.conversationKey,
          })
        : null;
    if (ensured?.conversationKey === scope.conversationKey) {
      return rememberProvisionedConversation(scope, ensured) ? ensured : null;
    }
    if (
      !ledger?.retiredAt &&
      !(existing && ledgerReady && !ledger) &&
      !rememberedKey
    ) {
      return null;
    }
    const replacement = await conversationRepository.createCatalogEntry({
      system,
      kind: "global",
      libraryID: scope.libraryID,
    });
    return replacement && rememberProvisionedConversation(scope, replacement)
      ? replacement
      : null;
  }
  if (!scope.paperItemID) return null;
  const expectedPaperKey =
    system === "claude_code"
      ? buildDefaultClaudePaperConversationKey(scope.paperItemID)
      : buildDefaultCodexPaperConversationKey(scope.paperItemID);
  const rememberedKey = isRememberedScopeKey(system, scope);
  if (scope.conversationKey !== expectedPaperKey && !rememberedKey) return null;
  if (!existing && expectedPaperKey !== scope.conversationKey) {
    const expectedEntry = await conversationRepository.getCatalogEntry({
      system,
      kind: "paper",
      conversationKey: expectedPaperKey,
    });
    const expectedLedger =
      expectedEntry && ledgerReady
        ? await getConversationKeyLedgerEntry(expectedEntry.conversationKey)
        : null;
    if (
      expectedEntry &&
      sameRuntimeScope(expectedEntry, scope) &&
      (!ledgerReady || (expectedLedger && !expectedLedger.retiredAt))
    ) {
      return rememberProvisionedConversation(scope, expectedEntry)
        ? expectedEntry
        : null;
    }
  }
  const ledger = isConversationKeyLedgerStoreInitialized()
    ? await getConversationKeyLedgerEntry(scope.conversationKey)
    : null;
  const ensured =
    !existing && !ledger
      ? await conversationRepository.createCatalogEntry({
          system,
          kind: "paper",
          libraryID: scope.libraryID,
          paperItemID: scope.paperItemID,
          preferredConversationKey: scope.conversationKey,
        })
      : null;
  if (ensured?.conversationKey === scope.conversationKey) {
    return rememberProvisionedConversation(scope, ensured) ? ensured : null;
  }
  if (
    !ledger?.retiredAt &&
    !(existing && ledgerReady && !ledger) &&
    !rememberedKey
  ) {
    return null;
  }
  const replacement = await conversationRepository.createCatalogEntry({
    system,
    kind: "paper",
    libraryID: scope.libraryID,
    paperItemID: scope.paperItemID,
  });
  return replacement && rememberProvisionedConversation(scope, replacement)
    ? replacement
    : null;
}

function rememberProvisionedConversation(
  scope: {
    kind: ConversationKind;
    libraryID: number;
    paperItemID?: number;
  },
  entry: ConversationCatalogEntry | null,
): boolean {
  if (!entry || !sameRuntimeScope(entry, scope)) return false;
  if (entry.system === "upstream") {
    if (scope.kind === "global") {
      activeGlobalConversationByLibrary.set(
        scope.libraryID,
        entry.conversationKey,
      );
      setLastUsedUpstreamGlobalConversationKey(
        scope.libraryID,
        entry.conversationKey,
      );
    } else if (scope.paperItemID) {
      activePaperConversationByPaper.set(
        buildPaperStateKey(scope.libraryID, scope.paperItemID),
        entry.conversationKey,
      );
      setLastUsedPaperConversationKey(
        scope.libraryID,
        scope.paperItemID,
        entry.conversationKey,
      );
    }
    return true;
  }
  if (entry.system === "claude_code") {
    if (scope.kind === "global") {
      const key = buildClaudeLibraryStateKey(scope.libraryID);
      activeClaudeGlobalConversationByLibrary.set(key, entry.conversationKey);
      setLastUsedClaudeGlobalConversationKey(
        scope.libraryID,
        entry.conversationKey,
      );
    } else if (scope.paperItemID) {
      const key = buildClaudePaperStateKey(scope.libraryID, scope.paperItemID);
      activeClaudePaperConversationByPaper.set(key, entry.conversationKey);
      setLastUsedClaudePaperConversationKey(
        scope.libraryID,
        scope.paperItemID,
        entry.conversationKey,
      );
    }
    return true;
  }
  if (scope.kind === "global") {
    const key = buildCodexLibraryStateKey(scope.libraryID);
    activeCodexGlobalConversationByLibrary.set(key, entry.conversationKey);
    setLastUsedCodexGlobalConversationKey(
      scope.libraryID,
      entry.conversationKey,
    );
  } else if (scope.paperItemID) {
    const key = buildCodexPaperStateKey(scope.libraryID, scope.paperItemID);
    activeCodexPaperConversationByPaper.set(key, entry.conversationKey);
    setLastUsedCodexPaperConversationKey(
      scope.libraryID,
      scope.paperItemID,
      entry.conversationKey,
    );
  }
  return true;
}

async function provisionClaudeConversation(scope: {
  conversationKey: number;
  kind: ConversationKind;
  libraryID: number;
  paperItemID?: number;
}): Promise<ConversationCatalogEntry | null> {
  return provisionRuntimeConversationUncoalesced("claude_code", scope);
}

async function provisionCodexConversation(scope: {
  conversationKey: number;
  kind: ConversationKind;
  libraryID: number;
  paperItemID?: number;
}): Promise<ConversationCatalogEntry | null> {
  return provisionRuntimeConversationUncoalesced("codex", scope);
}

export async function provisionConversationScopeForItem(params: {
  item: Zotero.Item;
  conversationSystem?: ConversationSystem | null;
}): Promise<boolean> {
  // Identity validation must precede any catalog lookup.  Without this, a
  // legacy deterministic paper key can return an old catalog row before the
  // durable retired-key ledger has been initialized, and the first append
  // then targets a permanently retired instance.
  await initConversationKeyLedgerStore();
  const storageSystem = resolveConversationStorageSystemForItem(params);
  if (!storageSystem) return false;
  const scope = resolveProvisionScope(params.item, storageSystem);
  if (!scope) return false;
  try {
    const entry = await provisionConversationEntry(storageSystem, scope);
    if (entry && entry.conversationKey !== scope.conversationKey) {
      bindProvisionedConversationKey(params.item, entry.conversationKey);
    }
    bindSyntheticPortalItemToEntry(params.item, entry);
    return Boolean(entry);
  } catch (err) {
    const debug = (
      globalThis as typeof globalThis & {
        Zotero?: { debug?: (message: string, err?: unknown) => void };
      }
    ).Zotero?.debug;
    debug?.("LLM: Failed to provision conversation scope", {
      error: err,
      key: scope.conversationKey,
      system: storageSystem,
      kind: scope.kind,
      libraryID: scope.libraryID,
      paperItemID: scope.paperItemID,
    });
  }
  return false;
}
