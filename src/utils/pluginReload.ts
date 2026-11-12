import { config, version } from "../../package.json";

/**
 * Gecko caches parsed chrome:// stylesheets by URL for as long as the app
 * runs, and an in-place plugin update does not clear that cache. Putting the
 * version in the URL makes each release load its own CSS, not the sheet the
 * previous version left in the cache.
 */
export function pluginStylesheetHref(
  path: string,
  pluginVersion: string = version,
): string {
  return `chrome://${config.addonRef}/content/${path}?v=${encodeURIComponent(
    pluginVersion,
  )}`;
}

/**
 * Decides whether a freshly loaded plugin script installs its own addon
 * object. Reusing the existing one is only right when it is alive and comes
 * from this same bundle; otherwise bootstrap would call the old version's
 * hooks. Versions before this check stored no version, so they never match.
 */
export function shouldReplaceAddonInstance(
  existing: unknown,
  bundledVersion: string,
): boolean {
  if (!existing || typeof existing !== "object") return true;
  const data = (existing as { data?: { alive?: unknown; version?: unknown } })
    .data;
  if (!data || data.alive === false) return true;
  return data.version !== bundledVersion;
}
