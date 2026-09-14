import type {
  CodexPermissionProfile,
  PermissionOption,
} from "../shared/permissionOptions";
import type { CodexAppServerProcess } from "../utils/codexAppServerProcess";
import {
  getOrCreateCodexAppServerProcess,
  resolveCodexAppServerBinaryPath,
} from "../utils/codexAppServerProcess";
import {
  CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
  resolveCodexNativeRuntimeCwd,
} from "./runtimeCwd";
import {
  applyCodexPermissionChoice,
  codexProfileSelectionKey,
  getCodexApprovalBehaviorLabel,
  getCodexPermissionSelectionKey,
  type CodexApprovalPolicy,
  type CodexApprovalsReviewer,
  type CodexPermissionChoice,
  type CodexPermissionState,
} from "./permissionState";
import {
  readCodexPermissionStatePref,
  type CodexPermissionStatePreference,
} from "./prefs";

export type CodexPermissionCapabilities = {
  protocol: "profiles" | "legacy";
  profiles: CodexPermissionProfile[];
  allowedApprovalPolicies: Set<CodexApprovalPolicy> | null;
  allowedApprovalsReviewers: Set<CodexApprovalsReviewer> | null;
  guardianApprovalEnabled: boolean;
  supportsThreadSettingsUpdate: boolean;
};

export type CodexPermissionOptionCatalog = {
  capabilities: CodexPermissionCapabilities;
  options: PermissionOption[];
  choices: Map<string, CodexPermissionChoice>;
  selectedKey: string;
  state: CodexPermissionState;
  preferenceError?: string;
};

export type CodexPermissionExecution = {
  state: CodexPermissionState | null;
  capabilities: CodexPermissionCapabilities;
  thread: {
    permissions?: string;
    sandbox?: "read-only";
    approvalPolicy?: CodexApprovalPolicy;
    approvalsReviewer?: CodexApprovalsReviewer;
  };
  settingsUpdate?: {
    permissions?: string;
    approvalPolicy?: CodexApprovalPolicy;
    approvalsReviewer?: CodexApprovalsReviewer;
  };
  turn: {
    sandboxPolicy?: { type: "readOnly"; networkAccess: false };
  };
  requiresProviderThreadReplacement: boolean;
  replacementReason?: "clear-boundary" | "clear-approval" | "unknown-state";
};

const LEGACY_PROFILE: CodexPermissionProfile = {
  id: ":read-only",
  description: "Legacy Codex read-only sandbox.",
  allowed: true,
};

const capabilityCache = new WeakMap<
  CodexAppServerProcess,
  Map<string, Promise<CodexPermissionCapabilities>>
>();
const observedCapabilityProcesses = new WeakSet<CodexAppServerProcess>();
const capabilityProcessListeners = new Set<() => void>();

export function subscribeCodexPermissionProcessChanges(
  listener: () => void,
): () => void {
  capabilityProcessListeners.add(listener);
  return () => capabilityProcessListeners.delete(listener);
}

export function isCodexMethodNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /method not found|unknown method|no handler registered|-32601/i.test(
    message,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeCursor(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizePermissionProfilePage(value: unknown): {
  profiles: CodexPermissionProfile[];
  nextCursor?: string;
} {
  const record = asRecord(value);
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.profiles)
      ? record.profiles
      : Array.isArray(record.items)
        ? record.items
        : [];
  const profiles = rows.flatMap((row) => {
    const entry = asRecord(row);
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id.trim()) return [];
    const allowed = entry.allowed !== false;
    return [
      {
        id,
        description:
          typeof entry.description === "string" ? entry.description.trim() : "",
        allowed,
        ...(!allowed
          ? {
              disabledReason:
                "This profile is disabled by managed Codex requirements.",
            }
          : {}),
      },
    ];
  });
  return { profiles, nextCursor: normalizeCursor(record.nextCursor) };
}

function normalizeFeaturePage(value: unknown): {
  guardianApprovalEnabled: boolean;
  nextCursor?: string;
} {
  const record = asRecord(value);
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.features)
      ? record.features
      : Array.isArray(record.items)
        ? record.items
        : [];
  return {
    guardianApprovalEnabled: rows.some((row) => {
      const entry = asRecord(row);
      return entry.name === "guardian_approval" && entry.enabled === true;
    }),
    nextCursor: normalizeCursor(record.nextCursor),
  };
}

function normalizeAllowedSet<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): Set<T> | null {
  if (!Array.isArray(value)) return null;
  const allowed = new Set<T>();
  for (const entry of value) {
    if (allowedValues.includes(entry as T)) allowed.add(entry as T);
  }
  return allowed;
}

async function loadCapabilities(params: {
  proc: CodexAppServerProcess;
  cwd?: string;
}): Promise<CodexPermissionCapabilities> {
  if (
    typeof params.proc.isProtocolInitialized === "function" &&
    !params.proc.isProtocolInitialized()
  ) {
    return {
      protocol: "legacy",
      profiles: [LEGACY_PROFILE],
      allowedApprovalPolicies: null,
      allowedApprovalsReviewers: null,
      guardianApprovalEnabled: false,
      supportsThreadSettingsUpdate: false,
    };
  }

  const profiles: CodexPermissionProfile[] = [];
  const seenProfiles = new Set<string>();
  let profileCursor: string | undefined;
  try {
    do {
      const page = normalizePermissionProfilePage(
        await params.proc.sendRequest("permissionProfile/list", {
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(profileCursor ? { cursor: profileCursor } : {}),
        }),
      );
      for (const profile of page.profiles) {
        if (seenProfiles.has(profile.id)) continue;
        seenProfiles.add(profile.id);
        profiles.push(profile);
      }
      profileCursor = page.nextCursor;
    } while (profileCursor);
  } catch (error) {
    if (!isCodexMethodNotFound(error)) throw error;
    return {
      protocol: "legacy",
      profiles: [LEGACY_PROFILE],
      allowedApprovalPolicies: null,
      allowedApprovalsReviewers: null,
      guardianApprovalEnabled: false,
      supportsThreadSettingsUpdate: false,
    };
  }

  let guardianApprovalEnabled = false;
  let featureCursor: string | undefined;
  try {
    do {
      const page = normalizeFeaturePage(
        await params.proc.sendRequest("experimentalFeature/list", {
          ...(featureCursor ? { cursor: featureCursor } : {}),
        }),
      );
      guardianApprovalEnabled ||= page.guardianApprovalEnabled;
      featureCursor = page.nextCursor;
    } while (featureCursor);
  } catch (error) {
    if (!isCodexMethodNotFound(error)) throw error;
  }

  let allowedApprovalPolicies: Set<CodexApprovalPolicy> | null = null;
  let allowedApprovalsReviewers: Set<CodexApprovalsReviewer> | null = null;
  try {
    const response = asRecord(
      await params.proc.sendRequest("configRequirements/read"),
    );
    const requirements = asRecord(response.requirements || response);
    allowedApprovalPolicies = normalizeAllowedSet(
      requirements.allowedApprovalPolicies,
      ["untrusted", "on-request", "never"] as const,
    );
    allowedApprovalsReviewers = normalizeAllowedSet(
      requirements.allowedApprovalsReviewers,
      ["user", "auto_review"] as const,
    );
  } catch (error) {
    if (!isCodexMethodNotFound(error)) throw error;
  }

  return {
    protocol: "profiles",
    profiles,
    allowedApprovalPolicies,
    allowedApprovalsReviewers,
    guardianApprovalEnabled,
    supportsThreadSettingsUpdate: true,
  };
}

export async function getCodexPermissionCapabilities(
  params: {
    proc?: CodexAppServerProcess;
    codexPath?: string;
    processKey?: string;
    cwd?: string;
    fresh?: boolean;
  } = {},
): Promise<CodexPermissionCapabilities> {
  const proc =
    params.proc ??
    (await getOrCreateCodexAppServerProcess(
      params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
      { codexPath: resolveCodexAppServerBinaryPath(params.codexPath) },
    ));
  const cwd = params.cwd ?? resolveCodexNativeRuntimeCwd();
  const cacheKey = cwd || "";
  if (
    !observedCapabilityProcesses.has(proc) &&
    typeof proc.onClose === "function"
  ) {
    observedCapabilityProcesses.add(proc);
    proc.onClose(() => {
      capabilityCache.delete(proc);
      for (const listener of capabilityProcessListeners) listener();
    });
  }
  let perProcess = capabilityCache.get(proc);
  if (!perProcess) {
    perProcess = new Map();
    capabilityCache.set(proc, perProcess);
  }
  if (params.fresh) perProcess.delete(cacheKey);
  let request = perProcess.get(cacheKey);
  if (!request) {
    const pending = loadCapabilities({ proc, cwd });
    request = pending;
    perProcess.set(cacheKey, pending);
    pending.catch(() => {
      if (perProcess?.get(cacheKey) === pending) perProcess.delete(cacheKey);
    });
  }
  return request;
}

function permissionProfileAllowed(
  capabilities: CodexPermissionCapabilities,
  profileId: string,
): { available: boolean; reason?: string; description?: string } {
  const profile = capabilities.profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    return {
      available: false,
      reason: `Codex did not return the ${profileId} permission profile.`,
    };
  }
  return {
    available: profile.allowed,
    reason: profile.allowed ? undefined : profile.disabledReason,
    description: profile.description,
  };
}

function allowedByRequirement<T extends string>(
  allowed: Set<T> | null,
  value: T,
): boolean {
  return allowed === null || allowed.has(value);
}

function stateAvailability(params: {
  state: CodexPermissionState;
  capabilities: CodexPermissionCapabilities;
  guardianRequired?: boolean;
}): { available: boolean; reason?: string } {
  if (params.capabilities.protocol !== "profiles") {
    return {
      available: false,
      reason: "Update Codex to use modern permission modes.",
    };
  }
  if (params.state.boundary.kind === "profile") {
    const profile = permissionProfileAllowed(
      params.capabilities,
      params.state.boundary.profileId,
    );
    if (!profile.available) return { available: false, reason: profile.reason };
  }
  if (params.state.approvalOverride) {
    if (
      !allowedByRequirement(
        params.capabilities.allowedApprovalPolicies,
        params.state.approvalOverride.policy,
      )
    ) {
      return {
        available: false,
        reason:
          "This approval policy is disabled by managed Codex requirements.",
      };
    }
    if (
      !allowedByRequirement(
        params.capabilities.allowedApprovalsReviewers,
        params.state.approvalOverride.reviewer,
      )
    ) {
      return {
        available: false,
        reason:
          "This approval reviewer is disabled by managed Codex requirements.",
      };
    }
  }
  if (params.guardianRequired && !params.capabilities.guardianApprovalEnabled) {
    return {
      available: false,
      reason:
        "Approve for me is unavailable because Codex auto-review is disabled.",
    };
  }
  return { available: true };
}

export function normalizeCodexProfileLabel(id: string): string {
  const normalized = id.replace(/^:/, "").replace(/[-_]+/g, " ").trim();
  return normalized || id;
}

function buildCodexOption(params: {
  selectionKey: string;
  fullLabel: string;
  compactLabel: string;
  description: string;
  available: boolean;
  disabledReason?: string;
}): PermissionOption {
  return { provider: "codex", ...params };
}

export function buildCodexPermissionOptionCatalog(params: {
  capabilities: CodexPermissionCapabilities;
  preference?: CodexPermissionStatePreference;
}): CodexPermissionOptionCatalog {
  const preference = params.preference ?? readCodexPermissionStatePref();
  const state = preference.state;
  const choices = new Map<string, CodexPermissionChoice>();
  if (params.capabilities.protocol === "legacy" && !preference.hasUserValue) {
    const selectionKey = "codex:legacy:read-only";
    return {
      capabilities: params.capabilities,
      state,
      selectedKey: selectionKey,
      choices,
      options: [
        buildCodexOption({
          selectionKey,
          fullLabel: "Read only (legacy)",
          compactLabel: "read only",
          description: "Legacy Codex read-only sandbox.",
          available: true,
        }),
      ],
      preferenceError: preference.error,
    };
  }

  const presetSpecs: Array<{
    preset: "ask" | "approve" | "full" | "custom";
    fullLabel: string;
    compactLabel: string;
    description: string;
  }> = [
    {
      preset: "ask",
      fullLabel: "Ask for approval",
      compactLabel: "ask",
      description: ":workspace · on-request · user",
    },
    {
      preset: "approve",
      fullLabel: "Approve for me",
      compactLabel: "approve",
      description: ":workspace · on-request · auto_review",
    },
    {
      preset: "full",
      fullLabel: "Full access",
      compactLabel: "full access",
      description: ":danger-full-access · never · user",
    },
    {
      preset: "custom",
      fullLabel: "Custom (config.toml)",
      compactLabel: "custom",
      description: "Codex configuration controls permissions and approvals.",
    },
  ];
  const options = presetSpecs.map((spec) => {
    const selectionKey = `codex:preset:${spec.preset}`;
    const choice: CodexPermissionChoice = {
      kind: "preset",
      preset: spec.preset,
    };
    choices.set(selectionKey, choice);
    const nextState = applyCodexPermissionChoice({ current: state, choice });
    const availability = stateAvailability({
      state: nextState,
      capabilities: params.capabilities,
      guardianRequired: spec.preset === "approve",
    });
    return buildCodexOption({
      selectionKey,
      fullLabel: spec.fullLabel,
      compactLabel: spec.compactLabel,
      description: spec.description,
      available: availability.available,
      disabledReason: availability.reason,
    });
  });

  for (const profile of params.capabilities.profiles) {
    if (profile.id === ":workspace" || profile.id === ":danger-full-access") {
      continue;
    }
    const selectionKey = codexProfileSelectionKey(profile.id);
    const choice: CodexPermissionChoice = {
      kind: "profile",
      profileId: profile.id,
    };
    choices.set(selectionKey, choice);
    const nextState = applyCodexPermissionChoice({ current: state, choice });
    const availability = stateAvailability({
      state: nextState,
      capabilities: params.capabilities,
      guardianRequired: nextState.approvalOverride?.reviewer === "auto_review",
    });
    const approvalLabel = getCodexApprovalBehaviorLabel(
      nextState.approvalOverride,
    );
    options.push(
      buildCodexOption({
        selectionKey,
        fullLabel: normalizeCodexProfileLabel(profile.id),
        compactLabel: normalizeCodexProfileLabel(profile.id),
        description: `${profile.id} · ${approvalLabel}${profile.description ? ` · ${profile.description}` : ""}`,
        available: availability.available,
        disabledReason: availability.reason,
      }),
    );
  }

  const selectedKey = preference.error
    ? "codex:invalid"
    : getCodexPermissionSelectionKey(state);
  if (preference.error) {
    options.push(
      buildCodexOption({
        selectionKey: selectedKey,
        fullLabel: "Invalid saved mode",
        compactLabel: "unavailable",
        description: preference.error,
        available: false,
        disabledReason: preference.error,
      }),
    );
  }
  if (!options.some((option) => option.selectionKey === selectedKey)) {
    const profileId =
      state.boundary.kind === "profile" ? state.boundary.profileId : "custom";
    options.push(
      buildCodexOption({
        selectionKey: selectedKey,
        fullLabel: normalizeCodexProfileLabel(profileId),
        compactLabel: normalizeCodexProfileLabel(profileId),
        description: `${profileId} · ${getCodexApprovalBehaviorLabel(state.approvalOverride)}`,
        available: false,
        disabledReason:
          preference.error ||
          "This saved Codex permission mode is unavailable.",
      }),
    );
  }

  return {
    capabilities: params.capabilities,
    state,
    options,
    choices,
    selectedKey,
    preferenceError: preference.error,
  };
}

export async function getCodexPermissionOptionCatalog(
  params: {
    proc?: CodexAppServerProcess;
    codexPath?: string;
    processKey?: string;
    cwd?: string;
    fresh?: boolean;
  } = {},
): Promise<CodexPermissionOptionCatalog> {
  const capabilities = await getCodexPermissionCapabilities(params);
  return buildCodexPermissionOptionCatalog({ capabilities });
}

export async function resolveCodexPermissionExecution(params: {
  planning?: boolean;
  proc: CodexAppServerProcess;
  cwd?: string;
  fresh?: boolean;
  hasExistingThread?: boolean;
  appliedState?: CodexPermissionState | null;
}): Promise<CodexPermissionExecution> {
  const savedPreference = readCodexPermissionStatePref();
  if (savedPreference.error) throw new Error(savedPreference.error);
  const capabilities = await getCodexPermissionCapabilities({
    proc: params.proc,
    cwd: params.cwd,
    fresh: params.fresh ?? true,
  });
  const preference =
    params.planning && capabilities.protocol !== "legacy"
      ? {
          ...savedPreference,
          hasUserValue: true,
          state: {
            boundary: { kind: "profile" as const, profileId: ":read-only" },
            approvalOverride: {
              policy: "never" as const,
              reviewer: "user" as const,
            },
          },
        }
      : savedPreference;
  return buildCodexPermissionExecution({
    preference,
    capabilities,
    hasExistingThread: params.hasExistingThread,
    appliedState: params.appliedState,
  });
}

export function buildCodexPermissionExecution(params: {
  preference: CodexPermissionStatePreference;
  capabilities: CodexPermissionCapabilities;
  hasExistingThread?: boolean;
  appliedState?: CodexPermissionState | null;
}): CodexPermissionExecution {
  const { preference, capabilities } = params;
  if (preference.error) throw new Error(preference.error);
  if (capabilities.protocol === "legacy") {
    if (preference.hasUserValue) {
      throw new Error(
        "This Codex version supports only Read only (legacy). Update Codex to use the saved permission mode.",
      );
    }
    return {
      state: null,
      capabilities,
      thread: {
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      },
      turn: {
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      requiresProviderThreadReplacement: false,
    };
  }

  const catalog = buildCodexPermissionOptionCatalog({
    capabilities,
    preference,
  });
  const selected = catalog.options.find(
    (option) => option.selectionKey === catalog.selectedKey,
  );
  if (!selected?.available) {
    throw new Error(
      selected?.disabledReason ||
        "Choose an allowed Codex permission mode before sending.",
    );
  }

  const state = preference.state;
  const thread = {
    ...(state.boundary.kind === "profile"
      ? { permissions: state.boundary.profileId }
      : {}),
    ...(state.approvalOverride
      ? {
          approvalPolicy: state.approvalOverride.policy,
          approvalsReviewer: state.approvalOverride.reviewer,
        }
      : {}),
  };
  const hasExistingThread = params.hasExistingThread === true;
  let replacementReason: CodexPermissionExecution["replacementReason"];
  if (hasExistingThread) {
    if (params.appliedState === undefined || params.appliedState === null) {
      if (state.boundary.kind === "config" || state.approvalOverride === null) {
        replacementReason = "unknown-state";
      }
    } else if (
      state.boundary.kind === "config" &&
      params.appliedState.boundary.kind !== "config"
    ) {
      replacementReason = "clear-boundary";
    } else if (
      state.approvalOverride === null &&
      params.appliedState.approvalOverride !== null
    ) {
      replacementReason = "clear-approval";
    }
  }
  const settingsUpdate =
    state.boundary.kind === "profile" || state.approvalOverride
      ? { ...thread }
      : undefined;

  return {
    state,
    capabilities,
    thread,
    settingsUpdate,
    turn: {},
    requiresProviderThreadReplacement: Boolean(replacementReason),
    replacementReason,
  };
}

export function getCodexPermissionStatusText(
  state: CodexPermissionState,
): string {
  const boundary =
    state.boundary.kind === "config" ? "config.toml" : state.boundary.profileId;
  return `${boundary} · ${getCodexApprovalBehaviorLabel(state.approvalOverride)}`;
}
