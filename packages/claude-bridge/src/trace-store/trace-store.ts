import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentEvent } from "../types.js";

export interface TraceEventRecord {
  runId: string;
  conversationKey: string;
  event: AgentEvent;
}

export interface TraceStore {
  append(record: TraceEventRecord): Promise<void>;
  list(conversationKey: string): Promise<TraceEventRecord[]>;
  clear(conversationKey: string): Promise<void>;
  flush?(): Promise<void>;
}

export class InMemoryTraceStore implements TraceStore {
  private readonly records: TraceEventRecord[] = [];

  async append(record: TraceEventRecord): Promise<void> {
    this.records.push(record);
  }

  async list(conversationKey: string): Promise<TraceEventRecord[]> {
    return this.records.filter((r) => r.conversationKey === conversationKey);
  }

  async clear(conversationKey: string): Promise<void> {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      if (this.records[i].conversationKey === conversationKey) {
        this.records.splice(i, 1);
      }
    }
  }
}

export class JsonFileTraceStore implements TraceStore {
  private pending: TraceEventRecord[] = [];
  private flushChain: Promise<void> = Promise.resolve();
  private legacyMigrated = false;

  constructor(private readonly filePath: string) {}

  async append(record: TraceEventRecord): Promise<void> {
    this.pending.push(record);
    this.scheduleFlush();
  }

  async list(conversationKey: string): Promise<TraceEventRecord[]> {
    await this.flush();
    const all = await this.readState();
    return all.filter((r) => r.conversationKey === conversationKey);
  }

  async clear(conversationKey: string): Promise<void> {
    this.pending = this.pending.filter(
      (r) => r.conversationKey !== conversationKey,
    );
    await this.flush();
    const all = await this.readState();
    const next = all.filter((r) => r.conversationKey !== conversationKey);
    await this.writeState(next);
  }

  async flush(): Promise<void> {
    await this.enqueueFlush();
  }

  private scheduleFlush(): void {
    void this.enqueueFlush();
  }

  private async enqueueFlush(): Promise<void> {
    this.flushChain = this.flushChain
      .then(async () => {
        if (!this.pending.length) return;
        const batch = this.pending.splice(0, this.pending.length);
        await this.appendBatch(batch);
      })
      .catch(() => {});
    await this.flushChain;
  }

  private async appendBatch(records: TraceEventRecord[]): Promise<void> {
    if (!records.length) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.migrateLegacyFileIfNeeded();
    const payload =
      records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await appendFile(this.filePath, payload, "utf8");
  }

  private async migrateLegacyFileIfNeeded(): Promise<void> {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed || !trimmed.startsWith("[")) return;
      const parsed = JSON.parse(trimmed) as TraceEventRecord[];
      if (!Array.isArray(parsed)) return;
      const legacyBackupPath = `${this.filePath}.legacy-array`;
      await writeFile(legacyBackupPath, raw, "utf8");
      await this.writeState(parsed);
    } catch {
      this.legacyMigrated = false;
    }
  }

  private async readState(): Promise<TraceEventRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed) as TraceEventRecord[];
        return Array.isArray(parsed) ? parsed : [];
      }
      return trimmed
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TraceEventRecord);
    } catch {
      return [];
    }
  }

  private async writeState(state: TraceEventRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const payload = state.length
      ? state.map((record) => JSON.stringify(record)).join("\n") + "\n"
      : "";
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, this.filePath);
  }
}
