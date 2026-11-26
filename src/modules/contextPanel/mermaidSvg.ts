import { HTML_NS } from "../../utils/domHelpers";

const SVG_NS = "http://www.w3.org/2000/svg";

const MERMAID_ALLOWED_SVG_TAGS = new Set([
  "svg",
  "g",
  "defs",
  "style",
  "marker",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "foreignobject",
  "title",
  "desc",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "pattern",
  "filter",
  "fedropshadow",
  "fegaussianblur",
  "feoffset",
  "femerge",
  "femergenode",
  "feflood",
  "fecomposite",
  "feblend",
  "fecolormatrix",
  "femorphology",
  "fecomponenttransfer",
  "fefunca",
  "fefuncr",
  "fefuncg",
  "fefuncb",
  "symbol",
  "use",
]);

const MERMAID_ALLOWED_FOREIGN_OBJECT_TAGS = new Set([
  "div",
  "span",
  "p",
  "br",
  "strong",
  "em",
  "b",
  "i",
  "code",
]);

function trimSvgLeadingMetadata(svg: string): string {
  let result = svg.trim().replace(/^\uFEFF/, "");
  let previous = "";
  while (previous !== result) {
    previous = result;
    result = result
      .replace(/^<\?xml[\s\S]*?\?>\s*/i, "")
      .replace(/^<!--[\s\S]*?-->\s*/i, "");
  }
  return result;
}

function normalizeSvgHtmlBreaks(svg: string): string {
  return svg.replace(/<br(\s[^/>]*)?>/gi, (_match, attrs: string = "") => {
    const normalizedAttrs = attrs.trim();
    return normalizedAttrs ? `<br ${normalizedAttrs}/>` : "<br/>";
  });
}

function getTagLocalName(tagName: string): string {
  const parts = tagName.split(":");
  return (parts[parts.length - 1] || "").toLowerCase();
}

function getDisallowedTag(svg: string): string | null {
  const tagPattern = /<\s*\/?\s*([a-zA-Z][\w:.-]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(svg)) !== null) {
    const localName = getTagLocalName(match[1]);
    if (
      !MERMAID_ALLOWED_SVG_TAGS.has(localName) &&
      !MERMAID_ALLOWED_FOREIGN_OBJECT_TAGS.has(localName)
    ) {
      return localName || match[1];
    }
  }
  return null;
}

function getUnsafeCssReason(value: string): string | null {
  if (/@import\b/i.test(value)) return "CSS @import is not allowed";
  if (/\b(?:expression|behavior|-moz-binding)\s*:/i.test(value)) {
    return "unsafe CSS property is not allowed";
  }
  if (/\b(?:javascript|data)\s*:/i.test(value)) {
    return "unsafe CSS URL scheme is not allowed";
  }

  const cssUrlPattern = /url\(\s*(["']?)([^)"']+)\1\s*\)/gi;
  let cssMatch: RegExpExecArray | null;
  while ((cssMatch = cssUrlPattern.exec(value)) !== null) {
    const url = cssMatch[2].trim();
    if (url && !url.startsWith("#")) {
      return "external CSS url() is not allowed";
    }
  }
  return null;
}

function getUnsafeAttributeUrlFunctionReason(value: string): string | null {
  const urlPattern = /url\(\s*(["']?)([^)"']+)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(value)) !== null) {
    const url = match[2].trim();
    if (url && !url.startsWith("#")) {
      return "attribute url() must reference an internal fragment";
    }
  }
  return null;
}

function getUnsafeAttributeReason(svg: string): string | null {
  if (/\son[a-z]+\s*=/i.test(svg)) {
    return "event handler attributes are not allowed";
  }

  const urlAttrPattern = /\b(href|src|xlink:href)\s*=\s*(["'])([\s\S]*?)\2/gi;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = urlAttrPattern.exec(svg)) !== null) {
    const value = attrMatch[3].trim();
    if (value && !value.startsWith("#")) {
      return `${attrMatch[1]} must reference an internal fragment`;
    }
  }

  const attributePattern = /\s([a-zA-Z_:][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  while ((attrMatch = attributePattern.exec(svg)) !== null) {
    const reason = getUnsafeAttributeUrlFunctionReason(attrMatch[3]);
    if (reason) return reason;
  }

  const styleAttrPattern = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi;
  while ((attrMatch = styleAttrPattern.exec(svg)) !== null) {
    const reason = getUnsafeCssReason(attrMatch[2]);
    if (reason) return reason;
  }

  return null;
}

function getUnsafeStyleElementReason(svg: string): string | null {
  const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = stylePattern.exec(svg)) !== null) {
    const reason = getUnsafeCssReason(styleMatch[1]);
    if (reason) return reason;
  }
  return null;
}

export type MermaidSvgSanitizationResult =
  | { ok: true; svg: string }
  | { ok: false; reason: string };

export function sanitizeRenderedMermaidSvgWithReason(
  svg: string,
  maxChars: number,
): MermaidSvgSanitizationResult {
  if (!svg) return { ok: false, reason: "Mermaid returned an empty SVG" };
  if (svg.length > maxChars) {
    return { ok: false, reason: "rendered SVG is too large" };
  }

  let safeSvg = normalizeSvgHtmlBreaks(trimSvgLeadingMetadata(svg));
  if (!/^<svg\b[\s\S]*<\/svg>\s*$/i.test(safeSvg)) {
    return { ok: false, reason: "rendered output is not a complete SVG" };
  }

  if (/<!doctype\b/i.test(safeSvg)) {
    return { ok: false, reason: "doctype declarations are not allowed" };
  }
  if (/<!entity\b/i.test(safeSvg)) {
    return { ok: false, reason: "entity declarations are not allowed" };
  }
  if (/\bjavascript\s*:/i.test(safeSvg)) {
    return { ok: false, reason: "javascript URLs are not allowed" };
  }

  const blockedTag = safeSvg.match(
    /<\s*(script|iframe|object|embed|link|meta|base|audio|video|canvas|image|a)\b/i,
  )?.[1];
  if (blockedTag) {
    return { ok: false, reason: `unsafe SVG tag: ${blockedTag}` };
  }

  const disallowedTag = getDisallowedTag(safeSvg);
  if (disallowedTag) {
    return { ok: false, reason: `unsupported SVG tag: ${disallowedTag}` };
  }

  const unsafeAttributeReason = getUnsafeAttributeReason(safeSvg);
  if (unsafeAttributeReason) {
    return { ok: false, reason: unsafeAttributeReason };
  }

  const unsafeStyleReason = getUnsafeStyleElementReason(safeSvg);
  if (unsafeStyleReason) {
    return { ok: false, reason: unsafeStyleReason };
  }

  const openingTag = safeSvg.match(/^<svg\b[^>]*>/i)?.[0] || "";
  if (!/\sxmlns\s*=/.test(openingTag)) {
    safeSvg = safeSvg.replace(/^<svg\b/i, `<svg xmlns="${SVG_NS}"`);
  }

  return { ok: true, svg: safeSvg };
}

export function createInlineSvgElement(
  doc: Document,
  svgMarkup: string,
  className: string,
  ariaLabel: string,
): SVGSVGElement | null {
  const container = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  container.innerHTML = svgMarkup.trim();
  const svg = container.firstElementChild;
  if (!svg || svg.localName.toLowerCase() !== "svg") return null;
  svg.classList.add(className);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", ariaLabel);
  return svg as unknown as SVGSVGElement;
}

export function createInlineMermaidSvgElement(
  doc: Document,
  svgMarkup: string,
  className: string,
): SVGSVGElement | null {
  return createInlineSvgElement(doc, svgMarkup, className, "Mermaid diagram");
}
