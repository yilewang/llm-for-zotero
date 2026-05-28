declare const Zotero: any;

import {
  buildDefaultClaudeGlobalConversationKey,
  buildDefaultClaudePaperConversationKey,
} from "../../claudeCode/constants";
import {
  ensureClaudeGlobalConversation,
  ensureClaudePaperConversation,
  getClaudeConversationSummary,
  upsertClaudeConversationSummary,
} from "../../claudeCode/store";
import {
  buildDefaultCodexGlobalConversationKey,
  buildDefaultCodexPaperConversationKey,
} from "../../codexAppServer/constants";
import {
  ensureCodexGlobalConversation,
  ensureCodexPaperConversation,
  getCodexConversationSummary,
  upsertCodexConversationSummary,
} from "../../codexAppServer/store";
import { resolveConversationStorageSystem } from "../../shared/conversationStorageRouting";
import type {
  ClaudeConversationSummary,
  CodexConversationSummary,
  ConversationSystem,
} from "../../shared/types";
import {
  ensureGlobalConversationExists,
  ensurePaperV1Conversation,
  getGlobalConversation,
  getPaperConversation,
} from "../../utils/chatStore";
import { getConversationKey } from "./conversationIdentity";
import {
  resolveActiveNoteSession,
  resolveConversationBaseItem,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
} from "./portalScope";

type ConversationKind = "global" | "paper";

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function sameRuntimeScope(
  summary: ClaudeConversationSummary | CodexConversationSummary | null,
  params: {
    kind: ConversationKind;
    libraryID: number;
    paperItemID?: number | null;
  },
): summary is ClaudeConversationSummary | CodexConversationSummary {
  if (!summary) return false;
  if (summary.kind !== params.kind) return false;
  if (summary.libraryID !== params.libraryID) return false;
  if (params.kind === "paper") {
    return (summary.paperItemID || null) === (params.paperItemID || null);
  }
  return true;
}

function resolveProvisionScope(item: Zotero.Item): {
  conversationKey: number;
  kind: ConversationKind;
  libraryID: number;
  paperItemID?: number;
} | null {
  const conversationKey = normalizePositiveInt(getConversationKey(item));
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

export function resolveConversationStorageSystemForItem(params: {
  item: Zotero.Item;
  conversationSystem?: ConversationSystem | null;
}): ConversationSystem | null {
  const conversationKey = normalizePositiveInt(getConversationKey(params.item));
  if (!conversationKey) return null;
  if (resolveActiveNoteSession(params.item)) {
    return "upstream";
  }
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
}): Promise<boolean> {
  if (scope.kind === "global") {
    await ensureGlobalConversationExists(
      scope.libraryID,
      scope.conversationKey,
    );
    return Boolean(await getGlobalConversation(scope.conversationKey));
  }
  if (scope.conversationKey === scope.paperItemID) {
    return Boolean(
      await ensurePaperV1Conversation(scope.libraryID, scope.paperItemID || 0),
    );
  }
  return Boolean(await getPaperConversation(scope.conversationKey));
}

async function provisionClaudeConversation(scope: {
  conversationKey: number;
  kind: ConversationKind;
  libraryID: number;
  paperItemID?: number;
}): Promise<boolean> {
  const existing = await getClaudeConversationSummary(scope.conversationKey);
  if (sameRuntimeScope(existing, scope)) {
    return upsertClaudeConversationSummary({
      conversationKey: existing.conversationKey,
      libraryID: existing.libraryID,
      kind: existing.kind,
      paperItemID: existing.paperItemID,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      title: existing.title,
      providerSessionId: existing.providerSessionId,
      scopedConversationKey: existing.scopedConversationKey,
      scopeType: existing.scopeType,
      scopeId: existing.scopeId,
      scopeLabel: existing.scopeLabel,
      cwd: existing.cwd,
      model: existing.model,
      effort: existing.effort,
    });
  }
  if (scope.kind === "global") {
    if (
      scope.conversationKey !==
      buildDefaultClaudeGlobalConversationKey(scope.libraryID)
    ) {
      return false;
    }
    const ensured = await ensureClaudeGlobalConversation(scope.libraryID);
    return ensured?.conversationKey === scope.conversationKey;
  }
  if (
    !scope.paperItemID ||
    scope.conversationKey !==
      buildDefaultClaudePaperConversationKey(scope.paperItemID)
  ) {
    return false;
  }
  const ensured = await ensureClaudePaperConversation(
    scope.libraryID,
    scope.paperItemID,
  );
  return ensured?.conversationKey === scope.conversationKey;
}

async function provisionCodexConversation(scope: {
  conversationKey: number;
  kind: ConversationKind;
  libraryID: number;
  paperItemID?: number;
}): Promise<boolean> {
  const existing = await getCodexConversationSummary(scope.conversationKey);
  if (sameRuntimeScope(existing, scope)) {
    return upsertCodexConversationSummary({
      conversationKey: existing.conversationKey,
      libraryID: existing.libraryID,
      kind: existing.kind,
      paperItemID: existing.paperItemID,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      title: existing.title,
      providerSessionId: existing.providerSessionId,
      scopedConversationKey: existing.scopedConversationKey,
      scopeType: existing.scopeType,
      scopeId: existing.scopeId,
      scopeLabel: existing.scopeLabel,
      cwd: existing.cwd,
      model: existing.model,
      effort: existing.effort,
    });
  }
  if (scope.kind === "global") {
    if (
      scope.conversationKey !==
      buildDefaultCodexGlobalConversationKey(scope.libraryID)
    ) {
      return false;
    }
    const ensured = await ensureCodexGlobalConversation(scope.libraryID);
    return ensured?.conversationKey === scope.conversationKey;
  }
  if (
    !scope.paperItemID ||
    scope.conversationKey !==
      buildDefaultCodexPaperConversationKey(scope.paperItemID)
  ) {
    return false;
  }
  const ensured = await ensureCodexPaperConversation(
    scope.libraryID,
    scope.paperItemID,
  );
  return ensured?.conversationKey === scope.conversationKey;
}

export async function provisionConversationScopeForItem(params: {
  item: Zotero.Item;
  conversationSystem?: ConversationSystem | null;
}): Promise<boolean> {
  const scope = resolveProvisionScope(params.item);
  if (!scope) return false;
  const storageSystem = resolveConversationStorageSystemForItem(params);
  try {
    if (storageSystem === "claude_code") {
      return await provisionClaudeConversation(scope);
    }
    if (storageSystem === "codex") {
      return await provisionCodexConversation(scope);
    }
    if (storageSystem === "upstream") {
      return await provisionUpstreamConversation(scope);
    }
  } catch (err) {
    const debug = (
      globalThis as typeof globalThis & {
        Zotero?: { debug?: (message: string, err?: unknown) => void };
      }
    ).Zotero?.debug;
    debug?.("LLM: Failed to provision conversation scope", err);
  }
  return false;
}
