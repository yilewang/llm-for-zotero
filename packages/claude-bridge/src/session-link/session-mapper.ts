import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type SessionMapState = Record<string, string>;

export interface SessionMapper {
  get(conversationKey: string): Promise<string | undefined>;
  getByPrefix(prefix: string): Promise<string | undefined>;
  set(conversationKey: string, providerSessionId: string): Promise<void>;
  delete(conversationKey: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
}

export class InMemorySessionMapper implements SessionMapper {
  private readonly map = new Map<string, string>();

  async get(conversationKey: string): Promise<string | undefined> {
    return this.map.get(conversationKey);
  }

  async getByPrefix(prefix: string): Promise<string | undefined> {
    for (const [key, value] of this.map.entries()) {
      if (key.startsWith(prefix)) return value;
    }
    return undefined;
  }

  async set(conversationKey: string, providerSessionId: string): Promise<void> {
    this.map.set(conversationKey, providerSessionId);
  }

  async delete(conversationKey: string): Promise<void> {
    this.map.delete(conversationKey);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of Array.from(this.map.keys())) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
      }
    }
  }
}

export class JsonFileSessionMapper implements SessionMapper {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(conversationKey: string): Promise<string | undefined> {
    await this.writeChain;
    const state = await this.readState();
    return state[conversationKey];
  }

  async getByPrefix(prefix: string): Promise<string | undefined> {
    await this.writeChain;
    const state = await this.readState();
    for (const [key, value] of Object.entries(state)) {
      if (key.startsWith(prefix)) return value;
    }
    return undefined;
  }

  async set(conversationKey: string, providerSessionId: string): Promise<void> {
    await this.enqueueWrite((state) => {
      state[conversationKey] = providerSessionId;
    });
  }

  async delete(conversationKey: string): Promise<void> {
    await this.enqueueWrite((state) => {
      delete state[conversationKey];
    });
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    await this.enqueueWrite((state) => {
      for (const key of Object.keys(state)) {
        if (key.startsWith(prefix)) {
          delete state[key];
        }
      }
    });
  }

  private async enqueueWrite(
    mutate: (state: SessionMapState) => void,
  ): Promise<void> {
    const nextWrite = this.writeChain.then(async () => {
      const state = await this.readState();
      mutate(state);
      await this.writeState(state);
    });
    this.writeChain = nextWrite.catch(() => {});
    await nextWrite;
  }

  private async readState(): Promise<SessionMapState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionMapState;
      return parsed;
    } catch {
      return {};
    }
  }

  private async writeState(state: SessionMapState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}
