import type { ZoteroGateway } from "../services/zoteroGateway";

export const PLAN_AUTHOR_DATE_STYLE_ID = "http://www.zotero.org/styles/apa";

type ZoteroStyleDescriptor = {
  class?: string;
  categories?: string | string[];
};

function isAuthorDateStyle(style: ZoteroStyleDescriptor | null): boolean {
  if (!style || style.class !== "in-text") return false;
  const categories = Array.isArray(style.categories)
    ? style.categories
    : [style.categories || ""];
  return categories.some(
    (category) => String(category).toLowerCase() === "author-date",
  );
}

function quickCopyStyleId(): string {
  return String(
    (
      Zotero as unknown as {
        Prefs?: { get?: (key: string) => unknown };
      }
    ).Prefs?.get?.("export.quickCopy.setting") || "",
  ).replace(/^bibliography(?:\/[^/]*)?=/, "");
}

/**
 * Formal Plan documents use concise author-date citations in prose. A user's
 * Quick Copy preference can be a note style (for example Chicago full note)
 * or a numeric style; rendering either inline produces long notes or opaque
 * numbers. Preserve Quick Copy only when CSL identifies it as author-date,
 * otherwise freeze APA as the deterministic author-date fallback.
 */
export function resolvePlanDocumentCitationPreference(
  gateway?: ZoteroGateway,
): {
  styleId: string;
  styleTitle: string;
  locale: string;
} {
  const Styles = (
    Zotero as unknown as {
      Styles?: { get?: (id: string) => ZoteroStyleDescriptor | null };
    }
  ).Styles;
  const preferredId = quickCopyStyleId();
  let preferredStyle: ZoteroStyleDescriptor | null = null;
  try {
    preferredStyle = preferredId ? Styles?.get?.(preferredId) || null : null;
  } catch {
    preferredStyle = null;
  }
  const styleId = isAuthorDateStyle(preferredStyle)
    ? preferredId
    : PLAN_AUTHOR_DATE_STYLE_ID;
  const locale =
    String(
      (
        Zotero as unknown as {
          Prefs?: { get?: (key: string) => unknown };
        }
      ).Prefs?.get?.("export.quickCopy.locale") || "",
    ).trim() || "en-US";
  const styleTitle =
    gateway?.listCitationStyles().find((style) => style.id === styleId)
      ?.title || (styleId === PLAN_AUTHOR_DATE_STYLE_ID ? "APA" : styleId);
  return { styleId, styleTitle, locale };
}
