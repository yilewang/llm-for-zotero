import { getUserSkillsRuntimeRootDir } from "../agent/skills/userSkills";

export const CODEX_APP_SERVER_NATIVE_PROCESS_KEY = "codex_app_server_native";

export function resolveCodexNativeRuntimeCwd(): string | undefined {
  try {
    return getUserSkillsRuntimeRootDir();
  } catch {
    return undefined;
  }
}
