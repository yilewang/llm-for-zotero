import { config } from "../../package.json";
import {
  pluginRepoSlug,
  releaseListApiUrl,
  releasePageUrl,
  resetPluginUpdateNotesCache,
  versionFromTag,
  type AvailableUpdate,
  type PluginUpdateDeps,
  type ReleaseNotes,
} from "./pluginUpdate";

/**
 * Gecko and network adapters for the update indicator. Workflow tests
 * replace them through `setPluginUpdateDepsForTest`, so no test reaches
 * GitHub or AddonManager.
 */

const REQUEST_TIMEOUT_MS = 15000;

type AddonInstallLike = {
  version: string;
  install: () => unknown;
  addListener: (listener: object) => void;
  removeListener: (listener: object) => void;
};

async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  ) as { AddonManager: any };
  const addon = await AddonManager.getAddonByID(config.addonID);
  if (!addon) return null;
  return new Promise<AvailableUpdate | null>((resolve, reject) => {
    let found: AddonInstallLike | null = null;
    addon.findUpdates(
      {
        onUpdateAvailable(_addon: unknown, install: AddonInstallLike) {
          found = install;
        },
        onNoUpdateAvailable() {},
        onUpdateFinished(_addon: unknown, error?: number) {
          if (found) resolve({ version: found.version, handle: found });
          else if (error) reject(new Error(`update check failed: ${error}`));
          else resolve(null);
        },
      },
      AddonManager.UPDATE_WHEN_USER_REQUESTED,
    );
  });
}

function installUpdate(
  update: AvailableUpdate,
  onFailed: () => void,
): () => void {
  const install = update.handle as AddonInstallLike;
  const listener = {
    onDownloadFailed: onFailed,
    onDownloadCancelled: onFailed,
    onInstallFailed: onFailed,
    onInstallCancelled: onFailed,
  };
  install.addListener(listener);
  const remove = () => {
    try {
      install.removeListener(listener);
    } catch {
      // The install may already be gone.
    }
  };
  try {
    // Failure comes from the listeners. The promise is created once per
    // AddonInstall and stays rejected after a failure, so it cannot report
    // a retry; it is only observed here to avoid an unhandled rejection.
    const result = install.install();
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch (err) {
    remove();
    throw err;
  }
  return remove;
}

async function fetchReleases(
  page: number,
  perPage: number,
): Promise<ReleaseNotes[]> {
  const slug = pluginRepoSlug();
  if (!slug) throw new Error("repository URL is not a GitHub URL");
  const xhr = await Zotero.HTTP.request(
    "GET",
    releaseListApiUrl(slug, page, perPage),
    {
      headers: { Accept: "application/vnd.github+json" },
      responseType: "text",
      successCodes: false,
      timeout: REQUEST_TIMEOUT_MS,
    },
  );
  if (xhr.status !== 200) throw new Error(`GitHub returned ${xhr.status}`);
  const data = JSON.parse(xhr.responseText || "null") as unknown;
  if (!Array.isArray(data)) throw new Error("bad release JSON");
  const releases: ReleaseNotes[] = [];
  for (const entry of data as Array<Record<string, unknown> | null>) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.draft === true || entry.prerelease === true) continue;
    const tag = typeof entry.tag_name === "string" ? entry.tag_name : "";
    const version = versionFromTag(tag);
    if (!version) continue;
    releases.push({
      version,
      body: typeof entry.body === "string" ? entry.body : "",
      publishedAt:
        typeof entry.published_at === "string" ? entry.published_at : "",
      htmlUrl:
        typeof entry.html_url === "string" && entry.html_url
          ? entry.html_url
          : releasePageUrl(slug, version),
    });
  }
  return releases;
}

const realDeps: PluginUpdateDeps = {
  checkForUpdate,
  installUpdate,
  fetchReleases,
};

// The test build never touches the network unless a test injects fakes.
const inertDeps: PluginUpdateDeps = {
  checkForUpdate: async () => null,
  installUpdate: () => {},
  fetchReleases: async () => {
    throw new Error("release notes are disabled in the test build");
  },
};

let injectedDeps: PluginUpdateDeps | null = null;

export function getPluginUpdateDeps(): PluginUpdateDeps {
  if (injectedDeps) return injectedDeps;
  return __env__ === "test" ? inertDeps : realDeps;
}

export function setPluginUpdateDepsForTest(
  deps: PluginUpdateDeps | null,
): void {
  injectedDeps = deps;
  resetPluginUpdateNotesCache();
}
