import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import type {
  SessionDiscoveryClient,
  SessionListItem,
} from "../session-link/session-resolver.js";

export class ClaudeAgentSdkSessionDiscoveryClient implements SessionDiscoveryClient {
  async listSessions(options?: {
    dir?: string;
    limit?: number;
    includeWorktrees?: boolean;
  }): Promise<SessionListItem[]> {
    const sessions = await listSessions({
      dir: options?.dir,
      limit: options?.limit,
      includeWorktrees: options?.includeWorktrees,
    });

    return sessions.map((session) => ({
      sessionId: session.sessionId,
      summary: session.summary,
      lastModified: session.lastModified,
      cwd: session.cwd,
    }));
  }
}
