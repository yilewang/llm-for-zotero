import { version as bundledVersion } from "../../package.json";
import packageJson from "../../package.json";

/**
 * Plugin update indicator: pure decisions plus a small controller. The
 * Gecko and network calls live behind `PluginUpdateDeps`
 * (see pluginUpdateAdapters.ts), so this file runs anywhere.
 */

export type PluginUpdateKind = "current" | "available" | "updating" | "updated";

export type PluginUpdateState = {
  kind: PluginUpdateKind;
  runningVersion: string;
  /** Version offered by the update, when kind is available or updating. */
  nextVersion: string | null;
  /** True when the last install attempt failed and the user can retry. */
  installFailed: boolean;
};

export type AvailableUpdate = { version: string; handle?: unknown };

export type ReleaseNotes = {
  version: string;
  /** Markdown source. */
  body: string;
  /** ISO date, or empty when GitHub gave none. */
  publishedAt: string;
  htmlUrl: string;
};

export type PluginUpdateDeps = {
  /** Resolves null when no update exists. Rejects on any error. */
  checkForUpdate: () => Promise<AvailableUpdate | null>;
  /**
   * Starts the install. `onFailed` runs when the download or install fails,
   * reported by listeners only (never by the install promise).
   * Returns a function that removes whatever listeners the install holds.
   */
  installUpdate: (
    update: AvailableUpdate,
    onFailed: () => void,
  ) => (() => void) | void;
  /**
   * One page of published releases, newest first (page counts from 1).
   * Rejects on any network or HTTP error.
   */
  fetchReleases: (page: number, perPage: number) => Promise<ReleaseNotes[]>;
};

export type DecideStateInput = {
  runningVersion: string;
  lastSeenVersion: string;
  availableVersion: string | null;
  updating: boolean;
};

/**
 * Priority: an install in progress, then an update the user can start, then
 * the one-time "just updated" badge, then the plain version pill.
 */
export function decidePluginUpdateKind(
  input: DecideStateInput,
): PluginUpdateKind {
  if (input.updating) return "updating";
  if (input.availableVersion && input.availableVersion !== input.runningVersion)
    return "available";
  if (input.lastSeenVersion && input.lastSeenVersion !== input.runningVersion)
    return "updated";
  return "current";
}

export type RepoSlug = { owner: string; repo: string };

/** Parses "git+https://github.com/<owner>/<repo>.git" and similar forms. */
export function parseRepoSlug(url: string): RepoSlug | null {
  const match =
    /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/i.exec(
      url.trim(),
    );
  return match ? { owner: match[1], repo: match[2] } : null;
}

export function releaseListApiUrl(
  slug: RepoSlug,
  page: number,
  perPage: number,
): string {
  return `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases?per_page=${perPage}&page=${page}`;
}

/** The releases page on GitHub, for when the list cannot be loaded. */
export function releaseListPageUrl(slug: RepoSlug): string {
  return `https://github.com/${slug.owner}/${slug.repo}/releases`;
}

/** "v3.9.12" and "3.9.12" both give "3.9.12". */
export function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v(?=\d)/i, "");
}

export function releasePageUrl(slug: RepoSlug, version: string): string {
  return `https://github.com/${slug.owner}/${slug.repo}/releases/tag/v${version}`;
}

export function pluginRepoSlug(): RepoSlug | null {
  return parseRepoSlug(
    (packageJson as { repository?: { url?: string } }).repository?.url || "",
  );
}

export const PLUGIN_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Releases shown per page of the "What's new" window. */
export const RELEASES_PER_PAGE = 5;

export type ReleasesLoadResult =
  | { status: "ready"; releases: ReleaseNotes[]; hasMore: boolean }
  | { status: "failed"; htmlUrl: string };

type ControllerOptions = {
  getDeps: () => PluginUpdateDeps;
  readLastSeen: () => string;
  writeLastSeen: (version: string) => void;
  isReplyInFlight: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  runningVersion?: string;
};

export type PluginUpdateController = {
  start: () => void;
  dispose: () => void;
  getState: () => PluginUpdateState;
  subscribe: (listener: (state: PluginUpdateState) => void) => () => void;
  check: () => Promise<void>;
  applyUpdate: () => void;
  /** Stores the running version as seen; clears the "updated" badge. */
  acknowledgeUpdated: () => void;
  /** One page of releases, newest first; page counts from 1. */
  loadReleases: (page: number) => Promise<ReleasesLoadResult>;
  isReplyInFlight: () => boolean;
};

// Release pages are cached for the session: GitHub allows 60
// unauthenticated requests per hour per IP. A failure is never cached.
const notesCache = new Map<number, ReleasesLoadResult>();
const notesInFlight = new Map<number, Promise<ReleasesLoadResult>>();

export function resetPluginUpdateNotesCache(): void {
  notesCache.clear();
  notesInFlight.clear();
}

export function createPluginUpdateController(
  options: ControllerOptions,
): PluginUpdateController {
  const runningVersion = options.runningVersion ?? bundledVersion;
  const listeners = new Set<(state: PluginUpdateState) => void>();
  let lastSeen = "";
  let available: AvailableUpdate | null = null;
  let updating = false;
  let installFailed = false;
  let checkInFlight = false;
  let timer: unknown = null;
  let removeInstallListeners: (() => void) | null = null;
  let disposed = false;

  const snapshot = (): PluginUpdateState => ({
    kind: decidePluginUpdateKind({
      runningVersion,
      lastSeenVersion: lastSeen,
      availableVersion: available?.version ?? null,
      updating,
    }),
    runningVersion,
    nextVersion: available?.version ?? null,
    installFailed,
  });
  const emit = () => {
    const state = snapshot();
    for (const listener of Array.from(listeners)) listener(state);
  };

  const check = async () => {
    if (checkInFlight || updating || disposed) return;
    checkInFlight = true;
    try {
      const found = await options.getDeps().checkForUpdate();
      if (disposed || updating) return;
      available = found && found.version !== runningVersion ? found : null;
      // A failed install stays flagged while the re-check finds the update
      // again; with no update left there is nothing to retry.
      if (!available) installFailed = false;
      emit();
    } catch {
      // Any error leaves the indicator in its current state, silently.
    } finally {
      checkInFlight = false;
    }
  };

  return {
    start() {
      if (disposed || timer !== null) return;
      const stored = options.readLastSeen();
      if (!stored) {
        // Fresh install: nothing to announce.
        options.writeLastSeen(runningVersion);
        lastSeen = runningVersion;
      } else {
        lastSeen = stored;
      }
      emit();
      void check();
      timer = options.setInterval(
        () => void check(),
        PLUGIN_UPDATE_CHECK_INTERVAL_MS,
      );
    },
    dispose() {
      disposed = true;
      if (timer !== null) options.clearInterval(timer);
      timer = null;
      removeInstallListeners?.();
      removeInstallListeners = null;
      listeners.clear();
    },
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check,
    applyUpdate() {
      if (!available || updating || disposed) return;
      const update = available;
      updating = true;
      installFailed = false;
      emit();
      const onFailed = () => {
        if (disposed) return;
        updating = false;
        installFailed = true;
        // Gecko keeps one install promise per AddonInstall, and it stays
        // rejected after a failure. A retry needs a fresh AddonInstall, so
        // drop this one and look for the update again.
        available = null;
        removeInstallListeners?.();
        removeInstallListeners = null;
        emit();
        void check();
      };
      try {
        const remove = options.getDeps().installUpdate(update, onFailed);
        if (typeof remove === "function") removeInstallListeners = remove;
      } catch {
        onFailed();
      }
      // On success Zotero shuts this version down; nothing more to do here.
    },
    acknowledgeUpdated() {
      if (lastSeen === runningVersion) return;
      options.writeLastSeen(runningVersion);
      lastSeen = runningVersion;
      emit();
    },
    async loadReleases(page) {
      const cached = notesCache.get(page);
      if (cached) return cached;
      const pending = notesInFlight.get(page);
      if (pending) return pending;
      const slug = pluginRepoSlug();
      const fallbackUrl = slug ? releaseListPageUrl(slug) : "";
      const task: Promise<ReleasesLoadResult> = options
        .getDeps()
        .fetchReleases(page, RELEASES_PER_PAGE)
        .then(
          (releases): ReleasesLoadResult => {
            const result: ReleasesLoadResult = {
              status: "ready",
              releases,
              // Drafts and pre-releases are dropped from a page, so only an
              // empty page shows the list has ended.
              hasMore: releases.length > 0,
            };
            notesCache.set(page, result);
            return result;
          },
          (): ReleasesLoadResult => ({
            status: "failed",
            htmlUrl: fallbackUrl,
          }),
        )
        .finally(() => notesInFlight.delete(page));
      notesInFlight.set(page, task);
      return task;
    },
    isReplyInFlight: options.isReplyInFlight,
  };
}
