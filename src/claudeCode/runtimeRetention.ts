import { getCoreAgentRuntime } from "../agent";
import type { AgentEvent } from "../agent/types";
import { updateClaudeRuntimeRetention, buildClaudeScope } from "./runtime";
import { CLAUDE_RUNTIME_RELEASE_GRACE_MS, isClaudeConversationKey } from "./constants";
import { resolveConversationSystemForItem, resolveConversationBaseItem, resolveDisplayConversationKind } from "../modules/contextPanel/portalScope";
import { getConversationKey } from "../modules/contextPanel/conversationIdentity";

type RetentionTarget = {
  conversationKey: number;
  scope: { scopeType: "paper" | "open"; scopeId: string; scopeLabel?: string };
};

type ThreadRetentionEntry = {
  mountId: string;
  probeId: string;
  target: RetentionTarget;
  bodies: Set<Element>;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  retainedRemotely: boolean;
  retainInFlight: Promise<void> | null;
  lastRetainBody: Element | null;
};

const retainedThreadKeyByBody = new WeakMap<Element, string>();
const retainedThreads = new Map<string, ThreadRetentionEntry>();
const pendingRetentionEventsByBody = new WeakMap<Element, AgentEvent[]>();
let nextMountOrdinal = 1;

function pushRetentionEvent(body: Element | null | undefined, stage: string, payload?: Record<string, unknown>): void {
  if (!body) return;
  const events = pendingRetentionEventsByBody.get(body) || [];
  events.push({
    type: "provider_event",
    providerType: "profiling",
    ts: Date.now(),
    payload: {
      stage,
      ...(payload || {}),
    },
  });
  pendingRetentionEventsByBody.set(body, events);
}

export function consumePendingRetentionEvents(body: Element): AgentEvent[] {
  const events = pendingRetentionEventsByBody.get(body) || [];
  pendingRetentionEventsByBody.delete(body);
  return events;
}

async function ensureRemoteRetention(entry: ThreadRetentionEntry, body: Element): Promise<void> {
  if (entry.retainInFlight) {
    pushRetentionEvent(body, "frontend.runtime_retention.await_inflight", {
      conversationKey: entry.target.conversationKey,
      scopeType: entry.target.scope.scopeType,
      scopeId: entry.target.scope.scopeId,
      mountId: entry.mountId,
      probeId: entry.probeId,
    });
    await entry.retainInFlight;
    return;
  }
  pushRetentionEvent(body, "frontend.runtime_retention.retain_dispatch", {
    conversationKey: entry.target.conversationKey,
    scopeType: entry.target.scope.scopeType,
    scopeId: entry.target.scope.scopeId,
    mountId: entry.mountId,
    probeId: entry.probeId,
  });
  entry.retainInFlight = updateClaudeRuntimeRetention(getCoreRuntime(), {
    conversationKey: entry.target.conversationKey,
    scope: entry.target.scope,
    mountId: entry.mountId,
    retain: true,
    probeId: entry.probeId,
  })
    .then((retained) => {
      entry.retainedRemotely = retained;
      pushRetentionEvent(body, "frontend.runtime_retention.retain_result", {
        conversationKey: entry.target.conversationKey,
        scopeType: entry.target.scope.scopeType,
        scopeId: entry.target.scope.scopeId,
        mountId: entry.mountId,
      probeId: entry.probeId,
        retainedRemotely: retained,
      });
    })
    .catch((error) => {
      pushRetentionEvent(body, "frontend.runtime_retention.retain_error", {
        conversationKey: entry.target.conversationKey,
        scopeType: entry.target.scope.scopeType,
        scopeId: entry.target.scope.scopeId,
        mountId: entry.mountId,
      probeId: entry.probeId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      entry.retainInFlight = null;
    });
  await entry.retainInFlight;
}

function makeMountId(): string {
  return `cc-ui-${Date.now()}-${nextMountOrdinal++}`;
}

function makeProbeId(): string {
  return `retain-probe-${Date.now()}-${nextMountOrdinal++}`;
}

const getCoreRuntime = () => getCoreAgentRuntime();

function resolveRetentionTarget(item: any | null | undefined): RetentionTarget | null {
  if (!item) return null;
  const conversationKey = getConversationKey(item);
  if (
    resolveConversationSystemForItem(item) !== "claude_code" &&
    !isClaudeConversationKey(conversationKey)
  ) return null;
  const kind = resolveDisplayConversationKind(item);
  if (!kind) return null;
  const baseItem = resolveConversationBaseItem(item);
  const libraryID = Number(item.libraryID || baseItem?.libraryID || 0);
  if (!Number.isFinite(conversationKey) || conversationKey <= 0 || !Number.isFinite(libraryID) || libraryID <= 0) {
    return null;
  }
  const scope = buildClaudeScope({
    libraryID: Math.floor(libraryID),
    kind,
    paperItemID: kind === "paper" ? Number(baseItem?.id || 0) || undefined : undefined,
    paperTitle: kind === "paper"
      ? String(baseItem?.getField?.("title") || "").trim() || undefined
      : undefined,
  });
  return {
    conversationKey,
    scope,
  };
}

export async function retainClaudeRuntimeForBody(
  body: Element,
  item: any | null | undefined,
): Promise<void> {
  const target = resolveRetentionTarget(item);
  const nextThreadKey = target
    ? `${target.scope.scopeType}:${target.scope.scopeId}:${target.conversationKey}`
    : null;
  const previousThreadKey = retainedThreadKeyByBody.get(body) || null;

  if (previousThreadKey && previousThreadKey !== nextThreadKey) {
    const previousEntry = retainedThreads.get(previousThreadKey);
    if (previousEntry) {
      previousEntry.bodies.delete(body);
      if (!previousEntry.bodies.size && !previousEntry.releaseTimer) {
        previousEntry.releaseTimer = setTimeout(() => {
          const liveEntry = retainedThreads.get(previousThreadKey);
          if (!liveEntry || liveEntry.bodies.size > 0) return;
          retainedThreads.delete(previousThreadKey);
          void (async () => {
            try {
              await liveEntry.retainInFlight;
            } catch {}
            if (!liveEntry.retainedRemotely) return;
            pushRetentionEvent(liveEntry.lastRetainBody, "frontend.runtime_retention.release_dispatch", {
              conversationKey: liveEntry.target.conversationKey,
              scopeType: liveEntry.target.scope.scopeType,
              scopeId: liveEntry.target.scope.scopeId,
              mountId: liveEntry.mountId,
              probeId: liveEntry.probeId,
            });
            await updateClaudeRuntimeRetention(getCoreRuntime(), {
              conversationKey: liveEntry.target.conversationKey,
              scope: liveEntry.target.scope,
              mountId: liveEntry.mountId,
              retain: false,
              probeId: liveEntry.probeId,
            }).catch(() => {});
          })();
        }, CLAUDE_RUNTIME_RELEASE_GRACE_MS);
      }
    }
    retainedThreadKeyByBody.delete(body);
  }

  if (!target || !nextThreadKey) {
    return;
  }

  let entry = retainedThreads.get(nextThreadKey);
  if (!entry) {
    entry = {
      mountId: makeMountId(),
      probeId: makeProbeId(),
      target,
      bodies: new Set<Element>(),
      releaseTimer: null,
      retainedRemotely: false,
      retainInFlight: null,
      lastRetainBody: body,
    };
    retainedThreads.set(nextThreadKey, entry);
  } else {
    entry.target = target;
    entry.lastRetainBody = body;
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
  }

  entry.bodies.add(body);
  retainedThreadKeyByBody.set(body, nextThreadKey);
  await ensureRemoteRetention(entry, body).catch(() => {});
}

export async function releaseClaudeRuntimeForBody(body: Element): Promise<void> {
  const previousThreadKey = retainedThreadKeyByBody.get(body) || null;
  if (!previousThreadKey) return;
  retainedThreadKeyByBody.delete(body);
  const entry = retainedThreads.get(previousThreadKey);
  if (!entry) return;
  entry.bodies.delete(body);
  if (entry.bodies.size > 0 || entry.releaseTimer) return;
  entry.releaseTimer = setTimeout(() => {
    const liveEntry = retainedThreads.get(previousThreadKey);
    if (!liveEntry || liveEntry.bodies.size > 0) return;
    retainedThreads.delete(previousThreadKey);
    pushRetentionEvent(liveEntry.lastRetainBody, "frontend.runtime_retention.release_dispatch", {
      conversationKey: liveEntry.target.conversationKey,
      scopeType: liveEntry.target.scope.scopeType,
      scopeId: liveEntry.target.scope.scopeId,
      mountId: liveEntry.mountId,
      probeId: liveEntry.probeId,
    });
    void updateClaudeRuntimeRetention(getCoreRuntime(), {
      conversationKey: liveEntry.target.conversationKey,
      scope: liveEntry.target.scope,
      mountId: liveEntry.mountId,
      retain: false,
      probeId: liveEntry.probeId,
    }).catch(() => {});
  }, CLAUDE_RUNTIME_RELEASE_GRACE_MS);
}
