import type { ConversationSystem } from "../../shared/types";

export type QueuedFollowUpInput = {
  id: number;
  text: string;
};

export type QueuedFollowUpBodySync = (body: Element) => void;

export const SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY =
  "__llmScheduleQueuedFollowUpDrain";
export const SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY =
  "__llmScheduleQueuedFollowUpThreadDrain";

let queuedFollowUpInputSeq = 0;
const queuedFollowUpsByThread = new Map<string, QueuedFollowUpInput[]>();
const queuedFollowUpBodiesByThread = new Map<string, Set<Element>>();
let syncRegisteredBody: QueuedFollowUpBodySync = () => undefined;

export function setQueuedFollowUpBodySyncCallback(
  callback: QueuedFollowUpBodySync,
): void {
  syncRegisteredBody = callback;
}

export function buildQueuedFollowUpThreadKey(params: {
  conversationSystem?: ConversationSystem | null;
  conversationKey?: number | null;
  webChatActive?: boolean;
}): string | null {
  if (params.webChatActive) return null;
  const rawKey = Number(params.conversationKey);
  if (!Number.isFinite(rawKey) || rawKey <= 0) return null;
  const system = params.conversationSystem || "upstream";
  return `${system}:${Math.floor(rawKey)}`;
}

export function getQueuedFollowUps(
  threadKey: string | null,
): QueuedFollowUpInput[] {
  if (!threadKey) return [];
  return queuedFollowUpsByThread.get(threadKey) || [];
}

export function setQueuedFollowUps(
  threadKey: string | null,
  entries: QueuedFollowUpInput[],
): void {
  if (!threadKey) return;
  if (!entries.length) {
    queuedFollowUpsByThread.delete(threadKey);
  } else {
    queuedFollowUpsByThread.set(threadKey, entries.slice());
  }
  syncQueuedFollowUpBodies(threadKey);
}

export function enqueueQueuedFollowUp(
  threadKey: string | null,
  text: string,
): QueuedFollowUpInput[] {
  const normalized = text.trim();
  if (!threadKey || !normalized) return getQueuedFollowUps(threadKey);
  const nextQueue = [
    ...getQueuedFollowUps(threadKey),
    {
      id: ++queuedFollowUpInputSeq,
      text: normalized,
    },
  ];
  setQueuedFollowUps(threadKey, nextQueue);
  return nextQueue;
}

export function removeQueuedFollowUp(
  threadKey: string | null,
  id: number,
): void {
  if (!threadKey) return;
  setQueuedFollowUps(
    threadKey,
    getQueuedFollowUps(threadKey).filter((entry) => entry.id !== id),
  );
}

export function shiftQueuedFollowUp(
  threadKey: string | null,
): QueuedFollowUpInput | null {
  if (!threadKey) return null;
  const [next, ...rest] = getQueuedFollowUps(threadKey);
  if (!next) return null;
  setQueuedFollowUps(threadKey, rest);
  return next;
}

export function registerQueuedFollowUpBody(
  threadKey: string | null,
  body: Element,
): void {
  if (!threadKey) return;
  const existing = queuedFollowUpBodiesByThread.get(threadKey) || new Set<Element>();
  existing.add(body);
  queuedFollowUpBodiesByThread.set(threadKey, existing);
}

export function unregisterQueuedFollowUpBody(
  threadKey: string | null,
  body: Element,
): void {
  if (!threadKey) return;
  const existing = queuedFollowUpBodiesByThread.get(threadKey);
  if (!existing) return;
  existing.delete(body);
  if (!existing.size) {
    queuedFollowUpBodiesByThread.delete(threadKey);
  }
}

export function syncQueuedFollowUpBodies(threadKey: string | null): void {
  if (!threadKey) return;
  const bodies = queuedFollowUpBodiesByThread.get(threadKey);
  if (!bodies?.size) return;
  for (const body of Array.from(bodies)) {
    if (isDisconnected(body)) {
      bodies.delete(body);
      continue;
    }
    try {
      syncRegisteredBody(body);
    } catch (_err) {
      void _err;
    }
  }
  if (!bodies.size) {
    queuedFollowUpBodiesByThread.delete(threadKey);
  }
}

export function scheduleQueuedFollowUpDrainForThread(
  threadKey: string | null,
): boolean {
  if (!threadKey) return false;
  const bodies = queuedFollowUpBodiesByThread.get(threadKey);
  if (!bodies?.size) return false;
  for (const body of Array.from(bodies)) {
    if (isDisconnected(body)) {
      bodies.delete(body);
      continue;
    }
    const schedule = (body as unknown as Record<string, unknown>)[
      SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY
    ];
    if (typeof schedule === "function") {
      (schedule as () => void)();
      return true;
    }
  }
  if (!bodies.size) {
    queuedFollowUpBodiesByThread.delete(threadKey);
  }
  return false;
}

export function clearQueuedFollowUpState(): void {
  queuedFollowUpInputSeq = 0;
  queuedFollowUpsByThread.clear();
  queuedFollowUpBodiesByThread.clear();
}

function isDisconnected(body: Element): boolean {
  return (body as unknown as { isConnected?: boolean }).isConnected === false;
}
