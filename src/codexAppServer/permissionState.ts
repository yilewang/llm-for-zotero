export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexApprovalsReviewer = "user" | "auto_review";

export type CodexPermissionBoundary =
  | { kind: "config" }
  | { kind: "profile"; profileId: string };

export type CodexApprovalOverride =
  | {
      policy: "on-request";
      reviewer: CodexApprovalsReviewer;
    }
  | {
      policy: "never";
      reviewer: "user";
    }
  | null;

export type CodexPermissionState = {
  boundary: CodexPermissionBoundary;
  approvalOverride: CodexApprovalOverride;
};

export type CodexPermissionPreset = "ask" | "approve" | "full" | "custom";

export type CodexPermissionChoice =
  | { kind: "preset"; preset: CodexPermissionPreset }
  | { kind: "profile"; profileId: string };

export const CODEX_ASK_PERMISSION_STATE: CodexPermissionState = {
  boundary: { kind: "profile", profileId: ":workspace" },
  approvalOverride: { policy: "on-request", reviewer: "user" },
};

export const CODEX_APPROVE_PERMISSION_STATE: CodexPermissionState = {
  boundary: { kind: "profile", profileId: ":workspace" },
  approvalOverride: { policy: "on-request", reviewer: "auto_review" },
};

export const CODEX_FULL_PERMISSION_STATE: CodexPermissionState = {
  boundary: { kind: "profile", profileId: ":danger-full-access" },
  approvalOverride: { policy: "never", reviewer: "user" },
};

export const CODEX_CUSTOM_PERMISSION_STATE: CodexPermissionState = {
  boundary: { kind: "config" },
  approvalOverride: null,
};

export function cloneCodexPermissionState(
  state: CodexPermissionState,
): CodexPermissionState {
  return {
    boundary:
      state.boundary.kind === "config"
        ? { kind: "config" }
        : { kind: "profile", profileId: state.boundary.profileId },
    approvalOverride: state.approvalOverride
      ? { ...state.approvalOverride }
      : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseCodexPermissionState(
  value: unknown,
): CodexPermissionState | null {
  if (!isRecord(value) || !isRecord(value.boundary)) return null;
  let boundary: CodexPermissionBoundary;
  if (value.boundary.kind === "config") {
    boundary = { kind: "config" };
  } else if (
    value.boundary.kind === "profile" &&
    typeof value.boundary.profileId === "string" &&
    value.boundary.profileId.trim()
  ) {
    boundary = {
      kind: "profile",
      profileId: value.boundary.profileId,
    };
  } else {
    return null;
  }

  if (value.approvalOverride === null) {
    return { boundary, approvalOverride: null };
  }
  if (boundary.kind === "config") return null;
  if (!isRecord(value.approvalOverride)) return null;
  const policy = value.approvalOverride.policy;
  const reviewer = value.approvalOverride.reviewer;
  if (
    policy === "on-request" &&
    (reviewer === "user" || reviewer === "auto_review")
  ) {
    return { boundary, approvalOverride: { policy, reviewer } };
  }
  if (policy === "never" && reviewer === "user") {
    return { boundary, approvalOverride: { policy, reviewer } };
  }
  return null;
}

export function deserializeCodexPermissionState(
  raw: string,
): CodexPermissionState | null {
  try {
    return parseCodexPermissionState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeCodexPermissionState(
  state: CodexPermissionState,
): string {
  const normalized = parseCodexPermissionState(state);
  if (!normalized) throw new Error("Invalid Codex permission state");
  return JSON.stringify(normalized);
}

export function codexPermissionStatesEqual(
  left: CodexPermissionState | null | undefined,
  right: CodexPermissionState | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    serializeCodexPermissionState(left) === serializeCodexPermissionState(right)
  );
}

export function applyCodexPermissionChoice(params: {
  current: CodexPermissionState;
  choice: CodexPermissionChoice;
}): CodexPermissionState {
  if (params.choice.kind === "profile") {
    const profileId = params.choice.profileId;
    if (!profileId.trim()) {
      throw new Error("Codex permission profile ID is required");
    }
    return {
      boundary: { kind: "profile", profileId },
      approvalOverride: params.current.approvalOverride
        ? { ...params.current.approvalOverride }
        : null,
    };
  }
  if (params.choice.preset === "ask") {
    return cloneCodexPermissionState(CODEX_ASK_PERMISSION_STATE);
  }
  if (params.choice.preset === "approve") {
    return cloneCodexPermissionState(CODEX_APPROVE_PERMISSION_STATE);
  }
  if (params.choice.preset === "full") {
    return cloneCodexPermissionState(CODEX_FULL_PERMISSION_STATE);
  }
  return cloneCodexPermissionState(CODEX_CUSTOM_PERMISSION_STATE);
}

export function getCodexPermissionPreset(
  state: CodexPermissionState,
): CodexPermissionPreset | null {
  if (codexPermissionStatesEqual(state, CODEX_ASK_PERMISSION_STATE)) {
    return "ask";
  }
  if (codexPermissionStatesEqual(state, CODEX_APPROVE_PERMISSION_STATE)) {
    return "approve";
  }
  if (codexPermissionStatesEqual(state, CODEX_FULL_PERMISSION_STATE)) {
    return "full";
  }
  if (codexPermissionStatesEqual(state, CODEX_CUSTOM_PERMISSION_STATE)) {
    return "custom";
  }
  return null;
}

export function codexProfileSelectionKey(profileId: string): string {
  return `codex:profile:${encodeURIComponent(profileId)}`;
}

export function getCodexPermissionSelectionKey(
  state: CodexPermissionState,
): string {
  const preset = getCodexPermissionPreset(state);
  if (preset) return `codex:preset:${preset}`;
  return state.boundary.kind === "profile"
    ? codexProfileSelectionKey(state.boundary.profileId)
    : "codex:preset:custom";
}

export function getCodexApprovalBehaviorLabel(
  approvalOverride: CodexApprovalOverride,
): string {
  if (!approvalOverride) return "Codex config";
  if (approvalOverride.policy === "never") return "Never ask";
  return approvalOverride.reviewer === "auto_review"
    ? "Approve for me"
    : "Ask for approval";
}
