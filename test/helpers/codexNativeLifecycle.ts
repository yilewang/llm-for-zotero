import { CodexAppServerProcess } from "../../src/utils/codexAppServerProcess";

export function createNativeLifecycleTestProcess(params: {
  newThreadIds: string[];
  requests: Array<{ method: string; params: Record<string, any> }>;
  deltaForTurn?: (turnNumber: number) => string;
  beforeTurnCompleted?: (turnId: string) => Promise<void>;
  skillsListResult?: unknown;
  permissionProfilesResult?: unknown;
  resumeEffectiveSettings?: {
    permissions?: string;
    approvalPolicy?: string;
    approvalsReviewer?: string;
  };
  settingsUpdateMethodNotFound?: boolean;
  collaborationModes?: string[];
  onTurn?: (turn: {
    threadId: string;
    turnId: string;
    turnNumber: number;
    emit: (message: Record<string, unknown>) => void;
  }) => void;
  onServerResponse?: (message: Record<string, any>) => void;
  onTurnBeforeResponse?: boolean;
  onMcpReload?: () => Promise<void>;
}): CodexAppServerProcess {
  let turnNumber = 0;
  const threadIds = [...params.newThreadIds];
  const proc = CodexAppServerProcess.forTest({
    stdin: {
      write: (chunk: string) => {
        const request = JSON.parse(chunk) as {
          id: number;
          method: string;
          params?: Record<string, any>;
        };
        const requestParams = request.params || {};
        if (!request.method) {
          params.onServerResponse?.(request);
          return;
        }
        params.requests.push({ method: request.method, params: requestParams });
        const handleMessage = (
          proc as unknown as {
            handleMessage: (message: Record<string, unknown>) => void;
          }
        ).handleMessage.bind(proc);
        if (request.method === "config/mcpServer/reload") {
          void Promise.resolve(params.onMcpReload?.()).then(() =>
            handleMessage({ id: request.id, result: {} }),
          );
          return;
        }
        if (request.method === "collaborationMode/list") {
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: {
                  data: (params.collaborationModes || ["plan", "default"]).map(
                    (mode) => ({ mode }),
                  ),
                },
              }),
            0,
          );
          return;
        }
        if (
          request.method === "permissionProfile/list" &&
          params.permissionProfilesResult !== undefined
        ) {
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: params.permissionProfilesResult,
              }),
            0,
          );
          return;
        }
        if (request.method === "experimentalFeature/list") {
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: {
                  data: [{ name: "guardian_approval", enabled: true }],
                },
              }),
            0,
          );
          return;
        }
        if (request.method === "configRequirements/read") {
          setTimeout(() => handleMessage({ id: request.id, result: {} }), 0);
          return;
        }
        if (request.method === "thread/settings/update") {
          if (params.settingsUpdateMethodNotFound) {
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  error: { code: -32601, message: "Method not found" },
                }),
              0,
            );
            return;
          }
          setTimeout(() => handleMessage({ id: request.id, result: {} }), 0);
          setTimeout(
            () =>
              handleMessage({
                method: "thread/settings/updated",
                params: {
                  threadId: requestParams.threadId,
                  threadSettings: {
                    activePermissionProfile: requestParams.permissions
                      ? { id: requestParams.permissions }
                      : null,
                    approvalPolicy: requestParams.approvalPolicy,
                    approvalsReviewer: requestParams.approvalsReviewer,
                  },
                },
              }),
            2,
          );
          return;
        }
        if (
          request.method === "skills/list" &&
          params.skillsListResult !== undefined
        ) {
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: params.skillsListResult,
              }),
            0,
          );
          return;
        }
        if (request.method === "thread/resume") {
          const effective = params.resumeEffectiveSettings || requestParams;
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: {
                  thread: { id: requestParams.threadId },
                  activePermissionProfile: effective.permissions
                    ? { id: effective.permissions }
                    : null,
                  approvalPolicy: effective.approvalPolicy,
                  approvalsReviewer: effective.approvalsReviewer,
                },
              }),
            0,
          );
          return;
        }
        if (request.method === "thread/start") {
          const threadId = threadIds.shift() || "thread-native-test";
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: { thread: { id: threadId } },
              }),
            0,
          );
          return;
        }
        if (
          request.method === "thread/archive" ||
          request.method === "turn/interrupt" ||
          request.method === "thread/name/set" ||
          request.method === "thread/read" ||
          request.method === "thread/inject_items"
        ) {
          setTimeout(() => handleMessage({ id: request.id, result: {} }), 0);
          return;
        }
        if (request.method === "turn/start") {
          turnNumber += 1;
          const turnId = `turn-lifecycle-${turnNumber}`;
          setTimeout(
            () =>
              handleMessage({
                id: request.id,
                result: { turn: { id: turnId } },
              }),
            0,
          );
          if (params.onTurn) {
            if (params.onTurnBeforeResponse) {
              params.onTurn({
                threadId: requestParams.threadId,
                turnId,
                turnNumber,
                emit: handleMessage,
              });
              return;
            }
            setTimeout(
              () =>
                params.onTurn?.({
                  threadId: requestParams.threadId,
                  turnId,
                  turnNumber,
                  emit: handleMessage,
                }),
              2,
            );
            return;
          }
          const delta = params.deltaForTurn?.(turnNumber) || "";
          if (delta) {
            setTimeout(
              () =>
                handleMessage({
                  method: "item/agentMessage/delta",
                  params: { turnId, delta },
                }),
              2,
            );
          }
          setTimeout(async () => {
            await params.beforeTurnCompleted?.(turnId);
            handleMessage({
              method: "turn/completed",
              params: { turn: { id: turnId, status: "completed" } },
            });
          }, 5);
        }
      },
    },
    kill: () => {},
  });
  if (params.permissionProfilesResult !== undefined) {
    proc.isProtocolInitialized = () => true;
  }
  return proc;
}

export function installDirectPathTestPrefs(
  skillMode: "native" | "off" = "off",
  permissionProfile = ":read-only",
) {
  const originalZotero = (globalThis as any).Zotero;
  const canonicalPermissionState =
    permissionProfile === ":read-only"
      ? undefined
      : JSON.stringify({
          boundary: { kind: "profile", profileId: permissionProfile },
          approvalOverride: {
            policy:
              permissionProfile === ":danger-full-access"
                ? "never"
                : "on-request",
            reviewer: "user",
          },
        });
  (globalThis as any).Zotero = {
    ...(originalZotero || {}),
    debug: () => undefined,
    DataDirectory: { dir: "/tmp/lfz-direct-pdf-skill-data" },
    Profile: { dir: "/tmp/lfz-direct-pdf-skill-profile" },
    Prefs: {
      get: (key: string) => {
        if (key.endsWith(".codexAppServerZoteroMcpToolsEnabled")) return false;
        if (key.endsWith(".codexNativeSkillMode")) return skillMode;
        if (key.endsWith(".codexAppServerPermissionState")) {
          return canonicalPermissionState;
        }
        if (key.endsWith(".codexAppServerPermissionProfile")) {
          return permissionProfile;
        }
        return undefined;
      },
      prefHasUserValue: (key: string) =>
        key.endsWith(".codexAppServerPermissionState") &&
        canonicalPermissionState !== undefined,
    },
  };
  return () => {
    (globalThis as any).Zotero = originalZotero;
  };
}
