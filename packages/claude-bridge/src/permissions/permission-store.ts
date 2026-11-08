/**
 * Pending permission request store for canUseTool callback.
 * Bridges async SDK callback with HTTP-based frontend resolution.
 */

export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

export type PendingPermission = {
  requestId: string;
  toolUseID: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  displayName?: string;
  blockedPath?: string;
  decisionReason?: string;
  createdAt: number;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
};

export type PendingPermissionEvent = {
  requestId: string;
  toolName: string;
  title?: string;
  description?: string;
  displayName?: string;
  blockedPath?: string;
  decisionReason?: string;
  input: Record<string, unknown>;
};

export class PermissionStore {
  private pending = new Map<string, PendingPermission>();
  private readonly defaultTimeoutMs = 300_000; // 5 minutes

  create(
    toolUseID: string,
    toolName: string,
    input: Record<string, unknown>,
    metadata: {
      title?: string;
      description?: string;
      displayName?: string;
      blockedPath?: string;
      decisionReason?: string;
    },
  ): { requestId: string; promise: Promise<PermissionResult> } {
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const promise = new Promise<PermissionResult>((resolve, reject) => {
      const pending: PendingPermission = {
        requestId,
        toolUseID,
        toolName,
        input,
        title: metadata.title,
        description: metadata.description,
        displayName: metadata.displayName,
        blockedPath: metadata.blockedPath,
        decisionReason: metadata.decisionReason,
        createdAt: Date.now(),
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          // Timeout: auto-deny instead of reject to avoid SDK errors
          this.pending.delete(requestId);
          resolve({
            behavior: "deny",
            message: `Permission request timed out after ${this.defaultTimeoutMs}ms`,
            interrupt: false,
            toolUseID,
          });
        }, this.defaultTimeoutMs),
      };

      this.pending.set(requestId, pending);
    });

    return { requestId, promise };
  }

  resolve(
    requestId: string,
    result: { approved: boolean; data?: unknown },
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    if (result.approved) {
      const data =
        result.data && typeof result.data === "object"
          ? (result.data as Record<string, unknown>)
          : {};
      const rawUpdatedInput =
        typeof data.input === "string" ? data.input.trim() : "";
      let updatedInput: Record<string, unknown> = {};
      if (rawUpdatedInput) {
        try {
          const parsed = JSON.parse(rawUpdatedInput);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            updatedInput = parsed as Record<string, unknown>;
          }
        } catch {
          updatedInput = {};
        }
      }
      pending.resolve({
        behavior: "allow",
        updatedInput,
        toolUseID: pending.toolUseID,
      });
    } else {
      pending.resolve({
        behavior: "deny",
        message:
          typeof result.data === "string" ? result.data : "User denied action",
        interrupt: false,
        toolUseID: pending.toolUseID,
      });
    }

    this.pending.delete(requestId);
    return true;
  }

  getPendingForEvent(requestId: string): PendingPermissionEvent | null {
    const p = this.pending.get(requestId);
    if (!p) return null;
    return {
      requestId: p.requestId,
      toolName: p.toolName,
      title: p.title,
      description: p.description,
      displayName: p.displayName,
      blockedPath: p.blockedPath,
      decisionReason: p.decisionReason,
      input: p.input,
    };
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  listPendingRequestIds(limit = 3): string[] {
    if (limit <= 0) return [];
    return Array.from(this.pending.keys()).slice(-limit);
  }

  cleanup(): void {
    for (const [, p] of this.pending) {
      if (p.timeoutId) clearTimeout(p.timeoutId);
      p.reject(new Error("Permission store cleanup"));
    }
    this.pending.clear();
  }
}

// Singleton instance for the process
export const globalPermissionStore = new PermissionStore();
