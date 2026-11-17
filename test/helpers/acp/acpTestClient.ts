/**
 * A minimal ACP client for tests and the conformance check.
 *
 * It is deliberately not the plugin's ACP client (that lives in src/ from
 * Phase 3): it exists to observe an agent, so it records every message and
 * leaves policy, such as how to answer a permission request, to the caller.
 */

import {
  ACP_AUTH_REQUIRED_ERROR_CODE,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type AcpInitializeResult,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionNotification,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "../../../src/shared/acpProtocol";
import { createLineSplitter } from "./lineSplitter";

/** A byte pipe to an agent: its stdin (`write`) and stdout (`onOutput`). */
export type AcpByteDuplex = {
  write(chunk: string): void;
  onOutput(listener: (chunk: string) => void): () => void;
  close(): void;
};

export class AcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly error: JsonRpcError,
  ) {
    super(`${method} failed (${error.code}): ${error.message}`);
  }
}

export type PermissionHandler = (
  params: AcpRequestPermissionParams,
) => AcpRequestPermissionResult | Promise<AcpRequestPermissionResult>;

export class AcpTestClient {
  /** Every message received from the agent, in order. */
  readonly received: JsonRpcMessage[] = [];
  private readonly pending = new Map<
    JsonRpcId,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (e: Error) => void;
    }
  >();
  private readonly updateListeners: Array<(n: AcpSessionNotification) => void> =
    [];
  private nextId = 1;
  private permissionHandler: PermissionHandler = () => ({
    outcome: { outcome: "cancelled" },
  });
  private readonly detach: () => void;

  constructor(private readonly duplex: AcpByteDuplex) {
    const split = createLineSplitter((line) => this.receive(line));
    this.detach = duplex.onOutput(split);
  }

  onPermissionRequest(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  onUpdate(
    listener: (notification: AcpSessionNotification) => void,
  ): () => void {
    this.updateListeners.push(listener);
    return () => {
      const index = this.updateListeners.indexOf(listener);
      if (index >= 0) this.updateListeners.splice(index, 1);
    };
  }

  request<R>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.duplex.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  notify(method: string, params?: unknown): void {
    this.duplex.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  initialize(): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>(ACP_METHODS.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
  }

  /**
   * Retries a request while the agent still reports "Authentication required",
   * which agy does for a short time after start-up.
   */
  async requestWhenReady<R>(
    method: string,
    params: unknown,
    options: { attempts: number; delayMs: number; onRetry?: () => void },
  ): Promise<R> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.request<R>(method, params);
      } catch (error) {
        const authPending =
          error instanceof AcpRpcError &&
          error.error.code === ACP_AUTH_REQUIRED_ERROR_CODE;
        if (!authPending || attempt >= options.attempts) throw error;
        options.onRetry?.();
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }

  close(): void {
    this.detach();
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`${pending.method}: connection closed`));
    }
    this.pending.clear();
    this.duplex.close();
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // agents may print non-protocol diagnostics; ignore them.
    }
    this.received.push(message);
    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ("error" in message)
        pending.reject(new AcpRpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (isJsonRpcRequest(message)) {
      void this.answer(message);
      return;
    }
    if (message.method === ACP_METHODS.sessionUpdate) {
      const notification = message.params as AcpSessionNotification;
      for (const listener of [...this.updateListeners]) listener(notification);
    }
  }

  private async answer(request: JsonRpcRequest): Promise<void> {
    if (request.method !== ACP_METHODS.sessionRequestPermission) {
      this.duplex.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Unsupported: ${request.method}` },
        })}\n`,
      );
      return;
    }
    const result = await this.permissionHandler(
      request.params as AcpRequestPermissionParams,
    );
    this.duplex.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
    );
  }
}
