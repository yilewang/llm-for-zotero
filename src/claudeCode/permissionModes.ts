import {
  buildClaudePermissionOption,
  type PermissionOption,
} from "../shared/permissionOptions";
import {
  normalizeClaudePermissionMode,
  type ClaudePermissionMode,
} from "../shared/claudePermissionMode";

export type ClaudePermissionModeCatalog = {
  options: PermissionOption[];
  configuredDefaultMode?: string;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export async function fetchClaudePermissionModeCatalog(params: {
  bridgeUrl: string;
  settingSources: readonly string[] | string;
  fetchImpl?: typeof fetch;
}): Promise<ClaudePermissionModeCatalog> {
  const baseUrl = normalizeBaseUrl(params.bridgeUrl);
  if (!baseUrl) throw new Error("Claude Code bridge URL is not configured");
  const fetchImpl = params.fetchImpl ?? fetch;
  const healthResponse = await fetchImpl(`${baseUrl}/healthz`, {
    headers: { Accept: "application/json" },
  });
  if (!healthResponse.ok)
    throw new Error(`Bridge HTTP ${healthResponse.status}`);
  const health = (await healthResponse.json()) as unknown as Record<
    string,
    unknown
  >;
  if (
    !Array.isArray(health.capabilities) ||
    !health.capabilities.includes("permission_modes_v1")
  ) {
    throw new Error(
      "Update and restart the Claude Code bridge to choose permission modes.",
    );
  }
  const sources =
    typeof params.settingSources === "string"
      ? params.settingSources
      : params.settingSources.join(",");
  const query = new URLSearchParams({ settingSources: sources });
  const response = await fetchImpl(`${baseUrl}/permission-modes?${query}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
  const payload = (await response.json()) as unknown as Record<string, unknown>;
  const modes = Array.isArray(payload.modes) ? payload.modes : [];
  const options = modes.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = normalizeClaudePermissionMode(record.id);
    if (record.id !== id) return [];
    return [
      buildClaudePermissionOption({
        id,
        available: record.available !== false,
        description:
          typeof record.description === "string"
            ? record.description
            : undefined,
        disabledReason:
          typeof record.disabledReason === "string"
            ? record.disabledReason
            : undefined,
      }),
    ];
  });
  if (options.length === 0) {
    throw new Error("Claude Code bridge returned no permission modes.");
  }
  const configuredDefaultMode =
    typeof payload.configuredDefaultMode === "string"
      ? payload.configuredDefaultMode.trim()
      : "";
  return {
    options,
    ...(configuredDefaultMode ? { configuredDefaultMode } : {}),
  };
}

export function reconcileClaudePermissionMode(params: {
  selectedId: ClaudePermissionMode;
  options: PermissionOption[];
}): { selectedId: ClaudePermissionMode; warning?: string } {
  const selected = params.options.find(
    (option) => option.selectionKey === `claude:${params.selectedId}`,
  );
  if (selected?.available) return { selectedId: params.selectedId };
  return {
    selectedId: "default",
    warning: `${selected?.fullLabel || params.selectedId} is unavailable. Claude Code permission mode was reset to Default.`,
  };
}
