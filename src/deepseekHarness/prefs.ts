import { config } from "../../package.json";

export function getHarnessPreference(name: string): string {
  const value = globalThis.Zotero?.Prefs?.get?.(
    `${config.prefsPrefix}.${name}`,
    true,
  );
  return typeof value === "string" ? value.trim() : "";
}

export function isDeepSeekHarnessEnabled(): boolean {
  return getHarnessPreference("agentExecutionEngine") === "deepseek_harness";
}

export function setAgentEngineEnabled(
  engine: "builtin" | "deepseek_harness",
  enabled: boolean,
): void {
  if (enabled) {
    Zotero.Prefs.set(
      `${config.prefsPrefix}.agentExecutionEngine`,
      engine,
      true,
    );
  }
  const selected = isDeepSeekHarnessEnabled() ? "deepseek_harness" : "builtin";
  if (selected === engine) {
    Zotero.Prefs.set(`${config.prefsPrefix}.enableAgentMode`, enabled, true);
  }
}
