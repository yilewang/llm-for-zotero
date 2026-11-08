import type { SessionMapper } from "./session-mapper.js";

export interface SessionListItem {
  sessionId: string;
  summary?: string;
  lastModified?: number;
  cwd?: string;
}

export interface SessionDiscoveryClient {
  listSessions(options?: {
    dir?: string;
    limit?: number;
    includeWorktrees?: boolean;
  }): Promise<SessionListItem[]>;
}

export interface SessionResolverOptions {
  sessionMapper: SessionMapper;
  discoveryClient: SessionDiscoveryClient;
}

export class SessionResolver {
  private readonly sessionMapper: SessionMapper;
  private readonly discoveryClient: SessionDiscoveryClient;

  constructor(options: SessionResolverOptions) {
    this.sessionMapper = options.sessionMapper;
    this.discoveryClient = options.discoveryClient;
  }

  async resolveForConversation(params: {
    conversationKey: string;
    dir?: string;
    includeWorktrees?: boolean;
  }): Promise<string | undefined> {
    const existing = await this.sessionMapper.get(params.conversationKey);
    if (existing) {
      return existing;
    }

    const sessions = await this.discoveryClient.listSessions({
      dir: params.dir,
      limit: 1,
      includeWorktrees: params.includeWorktrees ?? true,
    });

    const latest = sessions[0]?.sessionId;
    if (!latest) {
      return undefined;
    }

    await this.sessionMapper.set(params.conversationKey, latest);
    return latest;
  }

  async bindConversation(
    conversationKey: string,
    sessionId: string,
  ): Promise<void> {
    await this.sessionMapper.set(conversationKey, sessionId);
  }
}
