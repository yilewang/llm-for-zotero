import { getMineruAvailabilityForAttachmentId } from "./contextPanel/mineruSync";

type ProcessingStatus = "idle" | "processing" | "failed" | "cached";

interface ItemStatus {
  status: ProcessingStatus;
  updatedAt: number;
  errorMessage?: string;
}

const processingMap = new Map<number, ItemStatus>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}

export function setItemProcessing(attachmentId: number): void {
  processingMap.set(attachmentId, {
    status: "processing",
    updatedAt: Date.now(),
  });
  notifyListeners();
}

export function setItemCached(attachmentId: number): void {
  processingMap.set(attachmentId, {
    status: "cached",
    updatedAt: Date.now(),
  });
  notifyListeners();
}

export function setItemFailed(
  attachmentId: number,
  errorMessage?: string,
): void {
  processingMap.set(attachmentId, {
    status: "failed",
    updatedAt: Date.now(),
    errorMessage,
  });
  notifyListeners();
}

export function clearItemStatus(attachmentId: number): void {
  processingMap.delete(attachmentId);
  notifyListeners();
}

export function getItemStatus(attachmentId: number): ItemStatus | undefined {
  return processingMap.get(attachmentId);
}

export type MineruStatus = "cached" | "processing" | "failed" | "idle";

export async function getMineruStatus(
  attachmentId: number,
): Promise<MineruStatus> {
  const status = processingMap.get(attachmentId);
  if (status?.status === "processing") {
    return "processing";
  }

  const availability = await getMineruAvailabilityForAttachmentId(
    attachmentId,
    {
      validateSyncedPackage: false,
    },
  );
  if (availability.status !== "missing") {
    return "cached";
  }

  if (status?.status === "failed") {
    return "failed";
  }

  if (status?.status === "cached") {
    return "cached";
  }

  return "idle";
}

export function onProcessingStatusChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAllProcessingIds(): number[] {
  const result: number[] = [];
  for (const [id, status] of processingMap.entries()) {
    if (status.status === "processing") {
      result.push(id);
    }
  }
  return result;
}

export function getAllFailedIds(): number[] {
  const result: number[] = [];
  for (const [id, status] of processingMap.entries()) {
    if (status.status === "failed") {
      result.push(id);
    }
  }
  return result;
}

export function clearAllStatuses(): void {
  processingMap.clear();
  notifyListeners();
}
