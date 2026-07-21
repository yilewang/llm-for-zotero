const SECTION_ONLY_LABELS = new Set([
  "abstract",
  "background",
  "conclusion",
  "conclusions",
  "discussion",
  "experiment",
  "experiments",
  "introduction",
  "limitation",
  "limitations",
  "material and methods",
  "materials and methods",
  "method",
  "methodology",
  "methods",
  "result",
  "results",
  "supplement",
  "supplementary",
  "supplementary material",
  "supplementary materials",
]);

const INLINE_CITATION_LEADING_CUE_PATTERN =
  /^(?:e\.?\s*g\.?|i\.?\s*e\.?|see(?:\s+also)?|cf\.?|compare|for\s+example|for\s+instance|such\s+as|as\s+in|and\b|&)\s*[:,]?\s*/i;

export type ParsedCitationLabel = {
  sourceLabel: string;
  citationLabel: string;
  displayCitationLabel: string;
  citationKey?: string;
  pageLabel?: string;
  normalizedSourceLabel: string;
  normalizedCitationLabel: string;
  normalizedDisplayCitationLabel: string;
  normalizedCitationKey?: string;
};

function sanitizeCitationText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    ) {
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[index] + text[index + 1];
        index += 1;
      } else {
        out += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }
    out += text[index];
  }
  return out;
}

export function isCitationControlCharCode(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff ||
    code === 0x00ad
  );
}

export function stripCitationControlChars(value: string): string {
  const source = String(value || "");
  if (!source) return "";
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (isCitationControlCharCode(code)) continue;
    out += source[index];
  }
  return out;
}

function normalizeCitationText(value: unknown): string {
  return stripCitationControlChars(sanitizeCitationText(value))
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCitationLabel(value: unknown): string {
  return normalizeCitationText(value).toLowerCase();
}

export function normalizeCitationKey(value: unknown): string {
  return normalizeCitationText(value).replace(/\s+/g, "").toLowerCase();
}

export function stripCitationKeyFromLabel(value: string): string {
  return normalizeCitationText(value)
    .replace(/\s*\[[^\]]+\]\s*$/g, "")
    .trim();
}

export function normalizeWrappedCitationLabel(value: unknown): string {
  const label = normalizeCitationText(value);
  if (!label) return "";
  if (label.startsWith("(") && label.endsWith(")")) return label;
  return `(${label.replace(/^\(+|\)+$/g, "")})`;
}

function stripPageSuffixFromCitationLabel(value: string): string {
  const label = normalizeWrappedCitationLabel(value);
  const inner = label.replace(/^\(|\)$/g, "").trim();
  const withoutPage = inner
    .replace(/,\s*(?:p\.?|pp\.?|page|pages)\s+[^,)]+$/i, "")
    .trim();
  return normalizeWrappedCitationLabel(withoutPage || inner);
}

export function normalizeCitationLabelForMatch(value: unknown): string {
  return stripPageSuffixFromCitationLabel(normalizeWrappedCitationLabel(value))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCitationLabelForCompatibility(value: unknown): string {
  const label = normalizeWrappedCitationLabel(value);
  if (!label) return "";
  return label
    .replace(/^\(+|\)+$/g, "")
    .normalize("NFKC")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/&/g, " and ")
    .replace(
      /,\s*(?:pages?|p\.?|pp\.?)\s+[A-Za-z0-9ivxlcdmIVXLCDM]+(?:\s*[-\u2010-\u2015]\s*[A-Za-z0-9ivxlcdmIVXLCDM]+)?\s*$/i,
      "",
    )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function citationLabelsCompatible(
  sourceLabel: string,
  requestedLabel: string,
): boolean {
  const sourceExact = normalizeCitationLabelForMatch(sourceLabel);
  const requestedExact = normalizeCitationLabelForMatch(requestedLabel);
  if (!sourceExact || !requestedExact) return false;
  if (sourceExact === requestedExact) return true;
  const sourceCore = normalizeCitationLabelForCompatibility(sourceLabel);
  const requestedCore = normalizeCitationLabelForCompatibility(requestedLabel);
  return Boolean(sourceCore && requestedCore && sourceCore === requestedCore);
}

function citationInnerText(value: unknown): string {
  return normalizeWrappedCitationLabel(value)
    .replace(/^\(|\)$/g, "")
    .trim();
}

export function isNonSourceCitationLabel(value: string): boolean {
  const inner = citationInnerText(value)
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!inner) return false;
  const leadingSegment = inner
    .split(/[,;:–—-]/)[0]
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    SECTION_ONLY_LABELS.has(inner) ||
    SECTION_ONLY_LABELS.has(leadingSegment)
  ) {
    return true;
  }
  return (
    /^(?:caption|legend|figure caption|fig\.?\s+caption|table caption)$/i.test(
      inner,
    ) ||
    /^(?:supplementary|supplemental|appendix|appendices)(?:\s+(?:table|tab\.?|figure|fig\.?|section|text|material|materials|note|notes|data|movie|video|file|information))?(?:\s+[a-z0-9][a-z0-9._-]*)?(?:\s+(?:caption|legend))?(?:\s*[,;:–—-].*)?$/i.test(
      inner,
    ) ||
    /^(?:table|tab\.?|figure|fig\.?|fig|box|equation|eq\.?|scheme|algorithm)(?:\s+[a-z0-9][a-z0-9._-]*)?(?:\s+(?:caption|legend))?(?:\s*[,;:–—-].*)?$/i.test(
      inner,
    )
  );
}

export function isCanonicalSourceCitationLabel(value: string): boolean {
  const wrappedLabel = normalizeWrappedCitationLabel(value);
  if (
    !wrappedLabel.startsWith("(") ||
    !wrappedLabel.endsWith(")") ||
    wrappedLabel.length > 300
  ) {
    return false;
  }
  const label = stripPageSuffixFromCitationLabel(wrappedLabel);
  if (isNonSourceCitationLabel(label)) return false;
  const inner = citationInnerText(label);
  if (!inner || inner.includes(";")) return false;
  if (/\battachment\s+under\b/i.test(inner)) return true;
  if (/\b(?:19|20)\d{2}[a-z]?\b/i.test(inner)) return true;
  if (/\bet\s+al\.?\b/i.test(inner)) return true;
  if (/\[[^\]]+\]/.test(inner)) return true;
  if (/^paper(?:\s+\d+)?$/i.test(inner)) return true;
  if (
    /^[\p{L}][\p{L}'’.-]+(?:\s+(?:and|&)\s+[\p{L}][\p{L}'’.-]+)?$/u.test(inner)
  ) {
    return true;
  }
  return false;
}

function looksLikeSourceCitationLabel(value: string): boolean {
  const label = normalizeWrappedCitationLabel(value);
  const inner = label.replace(/^\(|\)$/g, "").trim();
  if (!inner || inner.includes(";")) return false;
  if (isNonSourceCitationLabel(label)) return false;
  if (isCanonicalSourceCitationLabel(label)) return true;
  if (/\b(?:19|20)\d{2}\b/.test(inner)) return true;
  if (/\bet\s+al\.?\b/i.test(inner)) return true;
  if (/\battachment\s+under\b/i.test(inner)) return true;
  return /^[\p{L}][^()]{1,160}$/u.test(inner) && /[,;&]/.test(inner);
}

function stripLeadingInlineCitationCue(value: string): {
  stripped: string;
  consumed: number;
} {
  let remaining = String(value || "");
  let consumed = 0;
  while (remaining) {
    const cueMatch = remaining.match(INLINE_CITATION_LEADING_CUE_PATTERN);
    if (!cueMatch) break;
    consumed += cueMatch[0].length;
    remaining = remaining.slice(cueMatch[0].length);
  }
  return {
    stripped: remaining,
    consumed,
  };
}

export function stripLeadingCitationCueLabel(value: string): string {
  const { stripped } = stripLeadingInlineCitationCue(value);
  const normalized = normalizeCitationText(stripped || value);
  return normalized || normalizeCitationText(value);
}

export function isLikelyStandaloneSourceCitationLabel(value: string): boolean {
  const clean = normalizeCitationText(value);
  const normalized = clean.toLowerCase();
  if (!normalized || normalized.includes(";")) return false;
  if (isNonSourceCitationLabel(clean)) return false;
  return (
    /\bet\s+al\b/.test(normalized) ||
    /\b(19|20)\d{2}\b/.test(normalized) ||
    /\bcid:[^\]]+/.test(normalized) ||
    /\[[^\]]+\]/.test(normalized) ||
    /\bpaper(?:\s+\d+)?\b/.test(normalized) ||
    /(?:[A-Z][\p{L}'’.-]+)\s+(?:and|&)\s+(?:[A-Z][\p{L}'’.-]+)/u.test(clean)
  );
}

function parseCitationParts(
  rawCitation: string,
  rawKey?: string,
  rawPage?: string,
): ParsedCitationLabel | null {
  const citationWithoutKey = stripCitationKeyFromLabel(rawCitation);
  const matchCitationLabel = stripLeadingCitationCueLabel(citationWithoutKey);
  const citationKeyFromLabelMatch = rawCitation.match(/\[([^\]]+)\]\s*$/);
  const parsedCitationKey = normalizeCitationText(
    rawKey || citationKeyFromLabelMatch?.[1] || "",
  );
  const parsedPageLabel = normalizeCitationText(rawPage || "");
  if (
    !matchCitationLabel ||
    matchCitationLabel.includes(";") ||
    /[()]/.test(matchCitationLabel)
  ) {
    return null;
  }
  if (!looksLikeSourceCitationLabel(matchCitationLabel)) return null;
  const sourceLabel = parsedCitationKey
    ? `(${citationWithoutKey} [${parsedCitationKey}])`
    : `(${citationWithoutKey})`;
  const citationLabel = parsedCitationKey
    ? `${matchCitationLabel} [${parsedCitationKey}]`
    : matchCitationLabel;
  return {
    sourceLabel,
    citationLabel,
    displayCitationLabel: citationWithoutKey,
    citationKey: parsedCitationKey || undefined,
    pageLabel: parsedPageLabel || undefined,
    normalizedSourceLabel: normalizeCitationLabel(sourceLabel),
    normalizedCitationLabel: normalizeCitationLabel(citationLabel),
    normalizedDisplayCitationLabel: normalizeCitationLabel(matchCitationLabel),
    normalizedCitationKey: normalizeCitationKey(parsedCitationKey) || undefined,
  };
}

export function parseStandaloneCitationLabel(
  value: string,
): ParsedCitationLabel | null {
  const normalized = normalizeCitationText(value);
  if (!normalized) return null;

  const wrappedMatch = normalized.match(/^\((.+)\)$/);
  if (wrappedMatch) {
    const inner = wrappedMatch[1].trim();
    let parenDepth = 0;
    let isValidSingleGroup = true;
    for (const ch of inner) {
      if (ch === "(") {
        parenDepth += 1;
        isValidSingleGroup = false;
        break;
      } else if (ch === ")") {
        parenDepth -= 1;
        isValidSingleGroup = false;
        break;
      }
      if (parenDepth < 0) {
        isValidSingleGroup = false;
        break;
      }
    }
    if (isValidSingleGroup) {
      const innerParts = inner.match(
        /^(.*?)(?:\s+\[([^\]]+)\])?(?:\s*,?\s*page\s+([^,;]+))?\.?$/i,
      );
      if (!innerParts) return null;
      const citationLabel = normalizeCitationText(innerParts[1] || "");
      if (!citationLabel || citationLabel.length < 4) return null;
      if (isNonSourceCitationLabel(citationLabel)) return null;
      return parseCitationParts(citationLabel, innerParts[2], innerParts[3]);
    }
  }

  const splitMatch = normalized.match(
    /^\((.+?)\)\s*(?:\[([^\]]+)\])?(?:\s*,?\s*page\s+([^,;]+))?\.?$/i,
  );
  if (!splitMatch) return null;
  const citationLabel = normalizeCitationText(splitMatch[1] || "");
  if (!citationLabel || citationLabel.length < 4) return null;
  if (isNonSourceCitationLabel(citationLabel)) return null;
  return parseCitationParts(citationLabel, splitMatch[2], splitMatch[3]);
}

export function extractCitationAuthorKey(normalizedLabel: string): string {
  const stripped = normalizeCitationLabel(normalizedLabel)
    .replace(/^\(|\)$/g, "")
    .trim();
  const matchEtAl = stripped.match(/^(\S+)\s+et\s+al/i);
  if (matchEtAl) return matchEtAl[1].replace(/[,;.]+$/g, "");
  const matchFirst = stripped.match(/^(\p{L}+)/u);
  return matchFirst ? matchFirst[1].toLowerCase() : "";
}

export function extractCitationYear(normalizedCitationLabel: string): string {
  const match = normalizeCitationLabel(normalizedCitationLabel).match(
    /\b(19|20)\d{2}\b/,
  );
  return match?.[0] || "";
}
