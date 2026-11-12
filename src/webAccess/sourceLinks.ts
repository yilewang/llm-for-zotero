import { protectInlineCode, restoreInlineCode } from "./inlineCode";
import type { WebSourceDisplay } from "./types";

const MARKER_PREFIX = "<!--llm-web-source:";
const TABLE_ROW_PATTERN = /^\s*\|/;
const REFERENCE_DEFINITION_PATTERN = /^\s{0,3}\[[^\]]+\]:\s/;
// A markdown link (not an image), an <url> autolink, or a bare URL. A link
// destination may hold one level of balanced parentheses.
const WEB_LINK_PATTERN =
  /(?<!!)\[([^[\]]*)\]\(\s*<?(https?:\/\/(?:[^\s<>()\u0000]|\([^\s<>()\u0000]*\))+)>?(?:\s+"([^"]*)")?\s*\)|(?<!\]\(\s*)<(https?:\/\/[^\s<>\u0000]+)>|(?<!\]\(\s*<?)(https?:\/\/[^\s<>\u0000]+)/gi;
const LIST_PREFIX_PATTERN = /^\s*(?:[-*+]|\d+[.)])?\s*/;
const TRAILING_PUNCTUATION = ".,;:!?";

/**
 * A URL key that ignores the scheme, a leading www., a trailing slash, the
 * hash, and utm_* parameters; undefined when the URL cannot be parsed.
 */
export function looseWebUrlKey(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  if (!host) return undefined;
  // A DOI is case-insensitive, and dx.doi.org is the same resolver.
  if (host === "doi.org" || host === "dx.doi.org") {
    let doi = parsed.pathname;
    try {
      doi = decodeURIComponent(doi);
    } catch {
      /* keep it encoded */
    }
    return `doi.org${doi.replace(/\/+$/, "").toLowerCase()}`;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const query = new URLSearchParams(
    Array.from(parsed.searchParams.entries()).filter(
      ([key]) => !key.toLowerCase().startsWith("utm_"),
    ),
  ).toString();
  return `${host}${path}${query ? `?${query}` : ""}`;
}

/** A bare URL without the sentence punctuation or unbalanced ")" after it. */
function trimBareUrl(url: string): string {
  let trimmed = url;
  for (;;) {
    const last = trimmed[trimmed.length - 1];
    if (TRAILING_PUNCTUATION.includes(last)) {
      trimmed = trimmed.slice(0, -1);
    } else if (
      last === ")" &&
      trimmed.split("(").length < trimmed.split(")").length
    ) {
      trimmed = trimmed.slice(0, -1);
    } else {
      return trimmed;
    }
  }
}

function translateLine(
  rawLine: string,
  idByKey: ReadonlyMap<string, string>,
): string {
  if (
    TABLE_ROW_PATTERN.test(rawLine) ||
    REFERENCE_DEFINITION_PATTERN.test(rawLine)
  ) {
    return rawLine;
  }
  const { text: line, spans } = protectInlineCode(rawLine);
  const ids: string[] = [];
  const sourceIdFor = (url: string) => {
    const key = looseWebUrlKey(url);
    const id = key ? idByKey.get(key) : undefined;
    if (id && !ids.includes(id)) ids.push(id);
    return id;
  };
  const translate = (keepUrls: boolean) =>
    line.replace(
      WEB_LINK_PATTERN,
      (
        found: string,
        linkText: string | undefined,
        linkUrl: string | undefined,
        _linkTitle: string | undefined,
        autolinkUrl: string | undefined,
        bareUrl: string | undefined,
      ) => {
        if (linkUrl) {
          if (!sourceIdFor(linkUrl)) return found;
          const text = (linkText || "").trim();
          if (
            keepUrls &&
            (!text || looseWebUrlKey(text) === looseWebUrlKey(linkUrl))
          ) {
            return found;
          }
          return !text || looseWebUrlKey(text) === looseWebUrlKey(linkUrl)
            ? ""
            : text;
        }
        if (autolinkUrl) {
          return sourceIdFor(autolinkUrl) && !keepUrls ? "" : found;
        }
        const url = trimBareUrl(bareUrl || "");
        return sourceIdFor(url) && !keepUrls ? found.slice(url.length) : found;
      },
    );
  let translated = translate(false);
  // Removing the URL must not leave an empty list item or line.
  if (
    ids.length &&
    !/[\p{L}\p{N}]/u.test(translated.replace(LIST_PREFIX_PATTERN, ""))
  ) {
    translated = translate(true);
  }
  if (!ids.length) return rawLine;
  const indent = translated.match(/^\s*/)?.[0] || "";
  const prose = translated
    .slice(indent.length)
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+(?=[,.;:!?)\]，。；：！？）])/g, "");
  const clean = restoreInlineCode(`${indent}${prose}`, spans).trimEnd();
  return `${clean}${MARKER_PREFIX}${ids.join(",")}-->`;
}

/**
 * Turn links to pages found in this run into source markers: a markdown link
 * keeps its text, an autolink or bare URL is removed, and the line gets one
 * marker at its end. Fenced code, inline code, table rows, and
 * reference-style links stay as written.
 */
export function translateWebSourceLinks(
  text: string,
  sources: ReadonlyMap<string, WebSourceDisplay>,
): string {
  const idByKey = new Map<string, string>();
  for (const source of sources.values()) {
    const key = looseWebUrlKey(source.url);
    if (key && !idByKey.has(key)) idByKey.set(key, source.sourceId);
  }
  if (!idByKey.size) return text;
  let output = "";
  let fence: { character: "`" | "~"; length: number } | null = null;
  for (const lineWithBreak of text.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!lineWithBreak) continue;
    const hasBreak = lineWithBreak.endsWith("\n");
    const line = hasBreak ? lineWithBreak.slice(0, -1) : lineWithBreak;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      const character = token[0] as "`" | "~";
      if (!fence) fence = { character, length: token.length };
      else if (fence.character === character && token.length >= fence.length) {
        fence = null;
      }
      output += lineWithBreak;
      continue;
    }
    output += fence
      ? lineWithBreak
      : translateLine(line, idByKey) + (hasBreak ? "\n" : "");
  }
  return output;
}

/** Starts and ends an inline source token: private-use characters. */
export const INLINE_SOURCE_TOKEN_START = "\uE000";
export const INLINE_SOURCE_TOKEN_END = "\uE001";
const INLINE_TOKEN_PATTERN = /\uE000(\d+)\uE001/g;
/** Link words that only say "here is the link": the marker replaces them. */
const GENERIC_LINK_TEXT =
  /^(?:link|links|source|sources|here|doi|pdf|paper|article|preprint|website|web ?page|page|full text|abstract|read more|more)$/i;

function isGenericLinkText(text: string, url: string): boolean {
  const words = text.trim();
  if (!words) return true;
  if (GENERIC_LINK_TEXT.test(words)) return true;
  if (/^doi:\s*10\./i.test(words) || /^10\.\d{4,9}\//.test(words)) return true;
  if (/^https?:\/\//i.test(words) || /^www\./i.test(words)) return true;
  return looseWebUrlKey(words) === looseWebUrlKey(url);
}

function tidyAroundTokens(line: string): string {
  return (
    line
      // "(TOKEN)" or "( TOKEN ; TOKEN )": parentheses that held only links.
      .replace(
        /[ \t]*[([][ \t]*((?:\uE000\d+\uE001[ \t]*[;,]?[ \t]*)+)[)\]]/g,
        (_found, tokens: string) => tokens.replace(/[ \t;,]+/g, ""),
      )
      // "Biology; TOKEN)": the separator before a trailing link goes.
      .replace(
        /[ \t]*[;,][ \t]*(?=\uE000\d+\uE001[ \t]*(?:[)\].,;:!?]|$))/g,
        "",
      )
      // The marker sits right after the words it supports.
      .replace(/[ \t]+(?=\uE000\d+\uE001)/g, "")
      .replace(/(\uE001)[ \t]+(?=[,.;:!?)\]])/g, "$1")
  );
}

/**
 * Turn each link to a known source into an inline source token where the
 * link was: a link with real words keeps them and the token follows; a bare
 * URL, an autolink, or a link that only says "link" becomes the token alone.
 * Adjacent links share one token. `tokens[n]` lists token n's source ids.
 * Fenced code, inline code, table rows and reference definitions stay as
 * written.
 */
export function inlineSourceLinks(
  text: string,
  idByKey: ReadonlyMap<string, string>,
): {
  text: string;
  tokens: string[][];
  /** Each token's exact phrases, by source id: the links' titles. */
  phrases: Record<string, string>[];
} {
  const tokens: string[][] = [];
  const phrases: Record<string, string>[] = [];
  if (!idByKey.size) return { text, tokens, phrases };
  const idFor = (url: string) => {
    const key = looseWebUrlKey(url);
    return key ? idByKey.get(key) : undefined;
  };
  const token = (id: string, phrase = "") => {
    tokens.push([id]);
    phrases.push(phrase ? { [id]: phrase } : {});
    return `${INLINE_SOURCE_TOKEN_START}${tokens.length - 1}${INLINE_SOURCE_TOKEN_END}`;
  };
  const translateLine = (rawLine: string) => {
    if (
      TABLE_ROW_PATTERN.test(rawLine) ||
      REFERENCE_DEFINITION_PATTERN.test(rawLine)
    ) {
      return rawLine;
    }
    const { text: line, spans } = protectInlineCode(rawLine);
    const firstToken = tokens.length;
    const translate = (keepUrls: boolean) =>
      line.replace(
        WEB_LINK_PATTERN,
        (
          found: string,
          linkText: string | undefined,
          linkUrl: string | undefined,
          linkTitle: string | undefined,
          autolinkUrl: string | undefined,
          bareUrl: string | undefined,
        ) => {
          if (linkUrl) {
            const id = idFor(linkUrl);
            if (!id) return found;
            const words = (linkText || "").trim();
            const phrase = (linkTitle || "").replace(/\s+/g, " ").trim();
            if (!isGenericLinkText(words, linkUrl))
              return `${words}${token(id, phrase)}`;
            return keepUrls
              ? `${found}${token(id, phrase)}`
              : token(id, phrase);
          }
          if (autolinkUrl) {
            const id = idFor(autolinkUrl);
            if (!id) return found;
            return keepUrls ? `${found}${token(id)}` : token(id);
          }
          const url = trimBareUrl(bareUrl || "");
          const id = idFor(url);
          if (!id) return found;
          return `${keepUrls ? url : ""}${token(id)}${found.slice(url.length)}`;
        },
      );
    let translated = translate(false);
    if (tokens.length === firstToken) return rawLine;
    const withoutTokens = translated.replace(INLINE_TOKEN_PATTERN, "");
    // Removing the URL must not leave an empty list item or line.
    if (!/[\p{L}\p{N}]/u.test(withoutTokens.replace(LIST_PREFIX_PATTERN, ""))) {
      tokens.length = firstToken;
      phrases.length = firstToken;
      translated = translate(true);
    }
    const tidied = tidyAroundTokens(translated)
      // Adjacent tokens become one marker listing every source.
      .replace(
        /\uE000(\d+)\uE001(?:\uE000\d+\uE001)+/g,
        (found: string, first: string) => {
          const ids = Array.from(found.matchAll(INLINE_TOKEN_PATTERN)).flatMap(
            (match) => tokens[Number(match[1])],
          );
          tokens[Number(first)] = Array.from(new Set(ids));
          phrases[Number(first)] = Object.assign(
            {},
            ...Array.from(found.matchAll(INLINE_TOKEN_PATTERN)).map(
              (match) => phrases[Number(match[1])] || {},
            ),
          );
          return `${INLINE_SOURCE_TOKEN_START}${first}${INLINE_SOURCE_TOKEN_END}`;
        },
      );
    return restoreInlineCode(tidied, spans);
  };
  let output = "";
  let fence: { character: "`" | "~"; length: number } | null = null;
  for (const lineWithBreak of text.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!lineWithBreak) continue;
    const hasBreak = lineWithBreak.endsWith("\n");
    const line = hasBreak ? lineWithBreak.slice(0, -1) : lineWithBreak;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const mark = fenceMatch[1];
      const character = mark[0] as "`" | "~";
      if (!fence) fence = { character, length: mark.length };
      else if (fence.character === character && mark.length >= fence.length) {
        fence = null;
      }
      output += lineWithBreak;
      continue;
    }
    output += fence
      ? lineWithBreak
      : translateLine(line) + (hasBreak ? "\n" : "");
  }
  return { text: output, tokens, phrases };
}

/**
 * Take the inline source tokens out of the text: where each one was (in the
 * text without tokens) and its source ids.
 */
export function extractInlineSourceTokens(
  text: string,
  tokens: readonly string[][],
  /** Each token's exact phrases, by source id (the links' titles). */
  phrases: readonly Record<string, string>[] = [],
): {
  text: string;
  inline: { offset: number; ids: string[]; phrases: Record<string, string> }[];
  /** Where an offset in the text with tokens lands without them. */
  mapOffset: (offset: number) => number;
} {
  const inline: {
    offset: number;
    ids: string[];
    phrases: Record<string, string>;
  }[] = [];
  const removed: { at: number; length: number }[] = [];
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(INLINE_TOKEN_PATTERN)) {
    output += text.slice(cursor, match.index);
    inline.push({
      offset: output.length,
      ids: tokens[Number(match[1])] || [],
      phrases: phrases[Number(match[1])] || {},
    });
    removed.push({ at: match.index!, length: match[0].length });
    cursor = match.index! + match[0].length;
  }
  output += text.slice(cursor);
  return {
    text: output,
    inline: inline.filter((entry) => entry.ids.length),
    mapOffset: (offset) =>
      offset -
      removed
        .filter((entry) => entry.at < offset)
        .reduce((sum, entry) => sum + entry.length, 0),
  };
}
