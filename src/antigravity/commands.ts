/**
 * The slash commands agy offers, as it last announced them
 * (`available_commands_update`). agy announces its list on every session it
 * opens; the slash menu shows the latest list.
 */

import type { AcpAvailableCommand } from "../shared/acpProtocol";
import type { AcpClient } from "./acpClient";

export type AntigravitySlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
};

let rememberedCommands: AntigravitySlashCommand[] = [];
const trackedClients = new WeakSet<AcpClient>();

function toSlashCommand(command: AcpAvailableCommand): AntigravitySlashCommand {
  const hint = command.input?.hint?.trim();
  return {
    name: command.name,
    description: command.description?.trim() || "",
    ...(hint ? { argumentHint: hint } : {}),
  };
}

export function rememberAntigravityCommands(
  commands: readonly AcpAvailableCommand[],
): void {
  rememberedCommands = commands
    .filter((command) => typeof command?.name === "string" && command.name)
    .map(toSlashCommand);
}

/** Remembers every list `client` announces from now on. */
export function trackAntigravityCommands(client: AcpClient): void {
  if (trackedClients.has(client)) return;
  trackedClients.add(client);
  client.onAvailableCommands(rememberAntigravityCommands);
}

/**
 * Resolves with the next list `client` announces, or the remembered list
 * after `timeoutMs`. agy announces a session's list just after it answers
 * session/new (about 25 ms later on agy 1.5.10), so a caller that opens a
 * session to learn the list waits for it here.
 */
export function waitForAntigravityCommands(
  client: AcpClient,
  timeoutMs: number,
): Promise<AntigravitySlashCommand[]> {
  trackAntigravityCommands(client);
  return new Promise((resolve) => {
    let stop: () => void = () => undefined;
    const timer = setTimeout(() => {
      stop();
      resolve(rememberedCommands);
    }, timeoutMs);
    stop = client.onAvailableCommands(() => {
      clearTimeout(timer);
      stop();
      // The tracking listener ran first, so the list is remembered already.
      resolve(rememberedCommands);
    });
  });
}

export function listAntigravitySlashCommands(): AntigravitySlashCommand[] {
  return rememberedCommands;
}
