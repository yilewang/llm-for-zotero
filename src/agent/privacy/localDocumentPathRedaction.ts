import type { LocalDocumentResource } from "../../shared/types";
import { getLocalParentPath, isUncPath } from "../../utils/localPath";
import type { AgentEvent } from "../types";

type SensitivePathEntry = {
  rawPath: string;
  variants: readonly SensitivePathVariant[];
  replacement: string;
  persistent: boolean;
  leaseIds: Set<number>;
  clearRequested: boolean;
};

type SensitivePathVariant = Readonly<{
  pattern: RegExp;
  sortLength: number;
  canStartWith: (value: string) => boolean;
}>;

const sensitivePathsByConversation = new Map<
  number,
  Map<string, SensitivePathEntry>
>();
let nextSensitivePathLeaseId = 1;

function normalizeConversationKey(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function jsonEscapeStringContent(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
}

function escapeRegExpCharacter(value: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(value) ? `\\${value}` : value;
}

function percentEscapePattern(value: string): string {
  return Array.from(value, (character) =>
    /[a-f]/i.test(character)
      ? `[${character.toLowerCase()}${character.toUpperCase()}]`
      : character,
  ).join("");
}

function buildPathVariantPattern(
  value: string,
  options: {
    caseInsensitive: boolean;
    flexibleWindowsSeparators?: boolean;
    fileSchemeInsensitive?: boolean;
  },
): RegExp {
  let pattern = "";
  let index = 0;
  if (
    options.fileSchemeInsensitive &&
    value.slice(0, 5).toLowerCase() === "file:"
  ) {
    pattern = "[Ff][Ii][Ll][Ee]:";
    index = 5;
  }
  while (index < value.length) {
    const character = value[index];
    if (
      character === "%" &&
      /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))
    ) {
      pattern += `%${percentEscapePattern(value.slice(index + 1, index + 3))}`;
      index += 3;
      continue;
    }
    if (
      options.flexibleWindowsSeparators &&
      (character === "/" || character === "\\")
    ) {
      pattern += "[\\\\/]+";
      index += 1;
      continue;
    }
    pattern += escapeRegExpCharacter(character);
    index += 1;
  }
  return new RegExp(pattern, options.caseInsensitive ? "giu" : "gu");
}

type FlexiblePathToken = Readonly<{
  forms: readonly Readonly<{ value: string; caseInsensitive?: boolean }>[];
}>;

function percentEncodedUtf8(value: string): string {
  return Array.from(
    new TextEncoder().encode(value),
    (byte) => `%${byte.toString(16).padStart(2, "0")}`,
  ).join("");
}

function buildFlexiblePathTokens(
  value: string,
  options: {
    caseInsensitive: boolean;
    fileSchemeInsensitive?: boolean;
    rawOrPercentEncoded?: boolean;
    shellEscapeFlexible?: boolean;
  },
): FlexiblePathToken[] {
  return Array.from(value, (character, index) => {
    const rawCaseInsensitive =
      options.caseInsensitive ||
      Boolean(options.fileSchemeInsensitive && index < 5);
    const forms: Array<{ value: string; caseInsensitive?: boolean }> = [
      { value: character, caseInsensitive: rawCaseInsensitive },
    ];
    if (options.rawOrPercentEncoded && character !== "/") {
      forms.push({
        value: percentEncodedUtf8(character),
        caseInsensitive: true,
      });
    }
    if (
      options.shellEscapeFlexible &&
      /[\\\s'"`$!&;()[\]{}*?<>|#~]/u.test(character)
    ) {
      forms.push({
        value: `\\${character}`,
        caseInsensitive: rawCaseInsensitive,
      });
    }
    return { forms };
  });
}

function flexibleTokensCanStartWith(
  tokens: readonly FlexiblePathToken[],
  candidate: string,
): boolean {
  const memo = new Map<string, boolean>();
  const visit = (tokenIndex: number, candidateIndex: number): boolean => {
    if (candidateIndex >= candidate.length) return true;
    if (tokenIndex >= tokens.length) return false;
    const memoKey = `${tokenIndex}:${candidateIndex}`;
    const cached = memo.get(memoKey);
    if (cached !== undefined) return cached;
    const remaining = candidate.slice(candidateIndex);
    for (const form of tokens[tokenIndex].forms) {
      const comparableRemaining = form.caseInsensitive
        ? remaining.toLowerCase()
        : remaining;
      const comparableForm = form.caseInsensitive
        ? form.value.toLowerCase()
        : form.value;
      if (
        (remaining.length <= form.value.length &&
          comparableForm.startsWith(comparableRemaining)) ||
        (remaining.length > form.value.length &&
          comparableRemaining.startsWith(comparableForm) &&
          visit(tokenIndex + 1, candidateIndex + form.value.length))
      ) {
        memo.set(memoKey, true);
        return true;
      }
    }
    memo.set(memoKey, false);
    return false;
  };
  return visit(0, 0);
}

function buildFlexiblePathVariant(
  value: string,
  options: {
    caseInsensitive: boolean;
    fileSchemeInsensitive?: boolean;
    rawOrPercentEncoded?: boolean;
    shellEscapeFlexible?: boolean;
  },
): Pick<SensitivePathVariant, "pattern" | "canStartWith"> {
  const tokens = buildFlexiblePathTokens(value, options);
  const pattern = tokens
    .map((token) => {
      const alternatives = token.forms.map((form) => {
        const escaped = Array.from(form.value, escapeRegExpCharacter).join("");
        if (!form.caseInsensitive) return escaped;
        return Array.from(escaped, (character) =>
          /[a-z]/i.test(character)
            ? `[${character.toLowerCase()}${character.toUpperCase()}]`
            : character,
        ).join("");
      });
      return alternatives.length === 1
        ? alternatives[0]
        : `(?:${alternatives.join("|")})`;
    })
    .join("");
  return {
    pattern: new RegExp(pattern, "gu"),
    canStartWith: (candidate) => flexibleTokensCanStartWith(tokens, candidate),
  };
}

function normalizePathPrefixComparison(
  value: string,
  options: {
    caseInsensitive: boolean;
    flexibleWindowsSeparators?: boolean;
    fileSchemeInsensitive?: boolean;
  },
): string {
  let normalized = options.flexibleWindowsSeparators
    ? value.replace(/[\\/]+/g, "/")
    : value;
  normalized = normalized.replace(
    /%([0-9a-f]{0,2})/gi,
    (_match, hex: string) => `%${hex.toLowerCase()}`,
  );
  if (options.caseInsensitive) return normalized.toLowerCase();
  if (options.fileSchemeInsensitive) {
    const schemeLength = Math.min(5, normalized.length);
    normalized =
      normalized.slice(0, schemeLength).toLowerCase() +
      normalized.slice(schemeLength);
  }
  return normalized;
}

function encodeFileUrlPathSegments(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function shellEscapePosixPath(value: string): string {
  return value.replace(/([\\\s'"`$!&;()[\]{}*?<>|#~])/gu, "\\$1");
}

function buildSensitivePathVariants(rawPath: string): SensitivePathVariant[] {
  const variants: SensitivePathVariant[] = [];
  const seen = new Set<string>();
  const add = (
    value: string,
    options: {
      caseInsensitive: boolean;
      flexibleWindowsSeparators?: boolean;
      fileSchemeInsensitive?: boolean;
      rawOrPercentEncoded?: boolean;
      shellEscapeFlexible?: boolean;
    },
  ) => {
    if (!value) return;
    const key = `${options.caseInsensitive ? "i" : "s"}:${options.flexibleWindowsSeparators ? "f" : "e"}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const flexibleVariant =
      options.rawOrPercentEncoded || options.shellEscapeFlexible
        ? buildFlexiblePathVariant(value, options)
        : undefined;
    variants.push({
      pattern:
        flexibleVariant?.pattern || buildPathVariantPattern(value, options),
      sortLength: value.length,
      canStartWith:
        flexibleVariant?.canStartWith ||
        ((candidate) =>
          normalizePathPrefixComparison(value, options).startsWith(
            normalizePathPrefixComparison(candidate, options),
          )),
    });
    const jsonEscaped = jsonEscapeStringContent(value);
    if (jsonEscaped !== value) {
      const jsonKey = `${options.caseInsensitive ? "i" : "s"}:j:${jsonEscaped}`;
      if (!seen.has(jsonKey)) {
        seen.add(jsonKey);
        variants.push({
          pattern: buildPathVariantPattern(jsonEscaped, {
            caseInsensitive: options.caseInsensitive,
            fileSchemeInsensitive: options.fileSchemeInsensitive,
          }),
          sortLength: jsonEscaped.length,
          canStartWith: (candidate) =>
            normalizePathPrefixComparison(jsonEscaped, {
              caseInsensitive: options.caseInsensitive,
              fileSchemeInsensitive: options.fileSchemeInsensitive,
            }).startsWith(
              normalizePathPrefixComparison(candidate, {
                caseInsensitive: options.caseInsensitive,
                fileSchemeInsensitive: options.fileSchemeInsensitive,
              }),
            ),
        });
      }
    }
  };

  const appendPathForm = (pathForm: string) => {
    const driveMatch = pathForm.match(/^([A-Za-z]:)[\\/]+(.*)$/s);
    const uncMatch = isUncPath(pathForm)
      ? pathForm.match(
          /^(?:\\\\|\/\/)([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/s,
        )
      : null;
    if (driveMatch) {
      const drive = driveMatch[1];
      const segments = driveMatch[2].split(/[\\/]+/).filter(Boolean);
      const forwardPath = `${drive}/${segments.join("/")}`;
      add(forwardPath, {
        caseInsensitive: true,
        flexibleWindowsSeparators: true,
      });
      add(`${drive}\\${segments.join("\\")}`, { caseInsensitive: true });
      const fileUrlTail = encodeFileUrlPathSegments(segments);
      for (const prefix of ["file:///", "file://localhost/"]) {
        add(`${prefix}${drive}/${segments.join("/")}`, {
          caseInsensitive: true,
          fileSchemeInsensitive: true,
          rawOrPercentEncoded: true,
        });
      }
      return;
    }

    if (uncMatch) {
      const host = uncMatch[1];
      const share = uncMatch[2];
      const segments = (uncMatch[3] || "").split(/[\\/]+/).filter(Boolean);
      const forwardPath = `//${host}/${share}${segments.length ? `/${segments.join("/")}` : ""}`;
      add(forwardPath, {
        caseInsensitive: true,
        flexibleWindowsSeparators: true,
      });
      add(
        `\\\\${host}\\${share}${segments.length ? `\\${segments.join("\\")}` : ""}`,
        { caseInsensitive: true },
      );
      const unencodedTail = [share, ...segments].join("/");
      const encodedTail = encodeFileUrlPathSegments([share, ...segments]);
      for (const url of [
        `file://${host}/${unencodedTail}`,
        `file://${host}/${encodedTail}`,
        `file:////${host}/${unencodedTail}`,
        `file:////${host}/${encodedTail}`,
      ]) {
        add(url, {
          caseInsensitive: true,
          fileSchemeInsensitive: true,
          rawOrPercentEncoded: true,
        });
      }
      return;
    }

    add(pathForm, {
      caseInsensitive: false,
      shellEscapeFlexible: true,
    });
    if (pathForm.startsWith("/")) {
      const prefix = pathForm.startsWith("//") ? "file:////" : "file:///";
      const segments = pathForm.split("/").filter(Boolean);
      const urlPrefixes = pathForm.startsWith("//")
        ? [prefix]
        : [prefix, "file://localhost/"];
      for (const urlPrefix of urlPrefixes) {
        add(`${urlPrefix}${segments.join("/")}`, {
          caseInsensitive: false,
          fileSchemeInsensitive: true,
          rawOrPercentEncoded: true,
        });
      }
      if (!pathForm.startsWith("//")) {
        add(`file:/${segments.join("/")}`, {
          caseInsensitive: false,
          fileSchemeInsensitive: true,
          rawOrPercentEncoded: true,
        });
      }
    }
  };

  for (const pathForm of new Set([
    rawPath,
    rawPath.normalize("NFC"),
    rawPath.normalize("NFD"),
  ])) {
    appendPathForm(pathForm);
  }
  return variants.sort((left, right) => right.sortLength - left.sortLength);
}

function touchConversationRegistry(
  conversationKey: number,
): Map<string, SensitivePathEntry> {
  const existing = sensitivePathsByConversation.get(conversationKey);
  if (existing) return existing;
  const created = new Map<string, SensitivePathEntry>();
  sensitivePathsByConversation.set(conversationKey, created);
  return created;
}

function rememberSensitivePath(params: {
  conversationKey: number;
  rawPath: string;
  sourceKey: string;
  kind: "path" | "directory";
  leaseId?: number;
}): void {
  if (!params.rawPath) return;
  const registry = touchConversationRegistry(params.conversationKey);
  const replacement =
    params.kind === "path"
      ? `[raw_pdf_path:${params.sourceKey}]`
      : `[raw_pdf_directory:${params.sourceKey}]`;
  const key = `${params.rawPath}\u0000${replacement}`;
  const existing = registry.get(key);
  if (existing) {
    if (params.leaseId) existing.leaseIds.add(params.leaseId);
    else {
      existing.persistent = true;
      existing.clearRequested = false;
    }
    return;
  }
  registry.set(key, {
    rawPath: params.rawPath,
    variants: buildSensitivePathVariants(params.rawPath),
    replacement,
    persistent: !params.leaseId,
    leaseIds: new Set(params.leaseId ? [params.leaseId] : []),
    clearRequested: false,
  });
}

export type LocalDocumentPathLease = Readonly<{
  rememberDocuments: (
    localDocuments: readonly LocalDocumentResource[] | undefined,
  ) => void;
  rememberDirectory: (absolutePath: string, sourceKey?: string) => void;
  release: () => void;
}>;

export function acquireLocalDocumentPathLease(
  conversationKeyValue: unknown,
  localDocuments?: readonly LocalDocumentResource[],
): LocalDocumentPathLease {
  const conversationKey = normalizeConversationKey(conversationKeyValue);
  const registry = conversationKey
    ? touchConversationRegistry(conversationKey)
    : new Map<string, SensitivePathEntry>();
  const leaseId = nextSensitivePathLeaseId++;
  let released = false;
  const rememberDirectory = (absolutePath: string, sourceKey = "selected") => {
    if (released || !conversationKey || !absolutePath) return;
    rememberSensitivePath({
      conversationKey,
      rawPath: absolutePath,
      sourceKey,
      kind: "directory",
      leaseId,
    });
  };
  const rememberDocuments = (
    documents: readonly LocalDocumentResource[] | undefined,
  ) => {
    if (released || !conversationKey) return;
    for (const document of documents || []) {
      const rawPath =
        typeof document?.absolutePath === "string" ? document.absolutePath : "";
      if (!rawPath) continue;
      const sourceKey =
        typeof document.sourceKey === "string" && document.sourceKey
          ? document.sourceKey
          : "selected";
      rememberSensitivePath({
        conversationKey,
        rawPath,
        sourceKey,
        kind: "path",
        leaseId,
      });
      const parentPath = getLocalParentPath(rawPath);
      const parentIsFilesystemRoot =
        parentPath === "/" ||
        parentPath === "//" ||
        parentPath === "\\\\" ||
        /^[A-Za-z]:[\\/]$/.test(parentPath);
      if (parentPath && parentPath !== rawPath && !parentIsFilesystemRoot) {
        rememberDirectory(parentPath, sourceKey);
      }
    }
    // Provider sessions can retain and repeat an exact path on later turns.
    // Keep the path registered after this turn's lease ends; conversation
    // cleanup clears the persistent registration.
    rememberLocalDocumentPaths(conversationKey, documents);
  };
  rememberDocuments(localDocuments);
  return Object.freeze({
    rememberDocuments,
    rememberDirectory,
    release: () => {
      if (released) return;
      released = true;
      for (const [key, entry] of registry) {
        entry.leaseIds.delete(leaseId);
        if (entry.clearRequested) entry.persistent = false;
        if (!entry.persistent && entry.leaseIds.size === 0) {
          registry.delete(key);
        }
      }
      if (
        conversationKey &&
        sensitivePathsByConversation.get(conversationKey) === registry &&
        registry.size === 0
      ) {
        sensitivePathsByConversation.delete(conversationKey);
      }
    },
  });
}

export function getRememberedLocalDocumentPathCountForTests(
  conversationKeyValue: unknown,
): number {
  const conversationKey = normalizeConversationKey(conversationKeyValue);
  return sensitivePathsByConversation.get(conversationKey)?.size || 0;
}

export function resetRememberedLocalDocumentPathsForTests(
  conversationKeyValue: unknown,
): void {
  const conversationKey = normalizeConversationKey(conversationKeyValue);
  if (conversationKey) sensitivePathsByConversation.delete(conversationKey);
}

/**
 * Registers exactly one sensitive directory without implicitly registering its
 * parent. Capability roots commonly live below shared system directories, and
 * redacting the shared parent would corrupt unrelated model output.
 */
export function rememberLocalDocumentDirectory(
  conversationKeyValue: unknown,
  absolutePath: string,
  sourceKey = "selected",
): void {
  const conversationKey = normalizeConversationKey(conversationKeyValue);
  if (!conversationKey || !absolutePath) return;
  rememberSensitivePath({
    conversationKey,
    rawPath: absolutePath,
    sourceKey,
    kind: "directory",
  });
}

export function rememberLocalDocumentPaths(
  conversationKeyValue: unknown,
  localDocuments: readonly LocalDocumentResource[] | undefined,
): void {
  const conversationKey = normalizeConversationKey(conversationKeyValue);
  if (!conversationKey || !localDocuments?.length) return;
  for (const document of localDocuments) {
    const rawPath =
      typeof document?.absolutePath === "string" ? document.absolutePath : "";
    if (!rawPath) continue;
    const sourceKey =
      typeof document.sourceKey === "string" && document.sourceKey
        ? document.sourceKey
        : "selected";
    rememberSensitivePath({
      conversationKey,
      rawPath,
      sourceKey,
      kind: "path",
    });
    const parentPath = getLocalParentPath(rawPath);
    const parentIsFilesystemRoot =
      parentPath === "/" ||
      parentPath === "//" ||
      parentPath === "\\\\" ||
      /^[A-Za-z]:[\\/]$/.test(parentPath);
    if (parentPath && parentPath !== rawPath && !parentIsFilesystemRoot) {
      rememberSensitivePath({
        conversationKey,
        rawPath: parentPath,
        sourceKey,
        kind: "directory",
      });
    }
  }
}

export function clearRememberedLocalDocumentPaths(
  conversationKeyValue: unknown,
): void {
  const conversationKey = normalizeConversationKey(conversationKeyValue);
  if (!conversationKey) return;
  const registry = sensitivePathsByConversation.get(conversationKey);
  if (!registry) return;
  for (const [key, entry] of registry) {
    entry.persistent = false;
    entry.clearRequested = true;
    if (entry.leaseIds.size === 0) registry.delete(key);
  }
  if (registry.size === 0) sensitivePathsByConversation.delete(conversationKey);
}

export function hasRememberedLocalDocumentPaths(
  conversationKeyValue: unknown,
): boolean {
  const conversationKey = normalizeConversationKey(conversationKeyValue);
  return Boolean(
    conversationKey && sensitivePathsByConversation.get(conversationKey)?.size,
  );
}

function getSensitivePathVariants(
  conversationKeyValue: unknown,
): Array<SensitivePathVariant & { replacement: string }> {
  const conversationKey = normalizeConversationKey(conversationKeyValue);
  if (!conversationKey) return [];
  const registry = sensitivePathsByConversation.get(conversationKey);
  if (!registry) return [];
  return Array.from(registry.values())
    .flatMap((entry) =>
      entry.variants.map((variant) => ({
        ...variant,
        replacement: entry.replacement,
      })),
    )
    .sort((left, right) => right.sortLength - left.sortLength);
}

function getAllSensitivePathVariants(): Array<
  SensitivePathVariant & { replacement: string }
> {
  return Array.from(sensitivePathsByConversation.keys())
    .flatMap((conversationKey) => getSensitivePathVariants(conversationKey))
    .sort((left, right) => right.sortLength - left.sortLength);
}

type SensitiveReplacementVariant = SensitivePathVariant & {
  replacement: string;
};

function redactTextWithVariants(
  value: string,
  variants: readonly SensitiveReplacementVariant[],
): string {
  let redacted = value;
  for (const variant of variants) {
    redacted = redacted.replace(variant.pattern, variant.replacement);
  }
  return redacted;
}

/**
 * Whether a fragment already names a private location. Shorter fragments,
 * such as "file" or a bare drive letter, are ordinary words until more of a
 * path follows them.
 */
function isCrediblePathPrefix(candidate: string): boolean {
  if (/^[A-Za-z]:[\\/]+./u.test(candidate)) return true;
  // A UNC host is already private even when a stream stops before the share.
  if (/^(?:\\\\|\/\/)[^\\/]+/u.test(candidate)) return true;
  if (/^file:[\\/]+[^\\/]+/iu.test(candidate)) return true;
  return /^\/[^/]+\/.+/u.test(candidate);
}

function redactTerminalTextWithVariants(
  value: string,
  variants: readonly SensitiveReplacementVariant[],
): string {
  if (!value || !variants.length) return value;
  const maxVariantLength = variants.reduce(
    (maximum, variant) => Math.max(maximum, variant.sortLength),
    0,
  );
  const firstCandidateIndex = Math.max(
    0,
    value.length - maxVariantLength - 256,
  );
  for (let index = firstCandidateIndex; index < value.length; index += 1) {
    const suffix = value.slice(index);
    if (!isCrediblePathPrefix(suffix)) continue;
    const partialMatch = variants.find((variant) =>
      variant.canStartWith(suffix),
    );
    if (!partialMatch) continue;
    return `${redactTextWithVariants(
      value.slice(0, index),
      variants,
    )}${partialMatch.replacement}`;
  }
  return redactTextWithVariants(value, variants);
}

function redactValueWithTextRedactor<T>(
  value: T,
  redactText: (value: string) => string,
): T {
  const seen = new WeakMap<object, unknown>();
  const redact = (current: unknown): unknown => {
    if (typeof current === "string") return redactText(current);
    if (!current || typeof current !== "object") return current;
    const cached = seen.get(current);
    if (cached) return cached;
    if (Array.isArray(current)) {
      const clone: unknown[] = [];
      seen.set(current, clone);
      for (const entry of current) clone.push(redact(entry));
      return clone;
    }
    const clone: Record<string, unknown> = {};
    seen.set(current, clone);
    for (const [key, child] of Object.entries(
      current as Record<string, unknown>,
    )) {
      clone[redactText(key)] = redact(child);
    }
    return clone;
  };
  return redact(value) as T;
}

export function redactRememberedLocalDocumentPathsFromText(
  conversationKeyValue: unknown,
  value: string,
): string {
  return redactTextWithVariants(
    value,
    getSensitivePathVariants(conversationKeyValue),
  );
}

/**
 * Redacts complete paths and fails closed when a terminal string ends in only
 * a prefix of a protected path. Providers can stop a stream at any byte, so a
 * final result must not release the suffix that the stream redactor withheld.
 */
export function redactRememberedLocalDocumentPathsFromTerminalText(
  conversationKeyValue: unknown,
  value: string,
): string {
  return redactTerminalTextWithVariants(
    value,
    getSensitivePathVariants(conversationKeyValue),
  );
}

export function redactAllRememberedLocalDocumentPathsFromText(
  value: string,
): string {
  let redacted = value;
  for (const conversationKey of Array.from(
    sensitivePathsByConversation.keys(),
  )) {
    redacted = redactRememberedLocalDocumentPathsFromText(
      conversationKey,
      redacted,
    );
  }
  return redacted;
}

export function redactAllRememberedLocalDocumentPathsFromTerminalText(
  value: string,
): string {
  let redacted = value;
  for (const conversationKey of Array.from(
    sensitivePathsByConversation.keys(),
  )) {
    redacted = redactRememberedLocalDocumentPathsFromTerminalText(
      conversationKey,
      redacted,
    );
  }
  return redacted;
}

export function redactRememberedLocalDocumentPaths<T>(
  conversationKeyValue: unknown,
  value: T,
): T {
  const seen = new WeakMap<object, unknown>();
  const redact = (current: unknown): unknown => {
    if (typeof current === "string") {
      return redactRememberedLocalDocumentPathsFromText(
        conversationKeyValue,
        current,
      );
    }
    if (!current || typeof current !== "object") return current;
    const cached = seen.get(current);
    if (cached) return cached;
    if (Array.isArray(current)) {
      const clone: unknown[] = [];
      seen.set(current, clone);
      for (const entry of current) clone.push(redact(entry));
      return clone;
    }
    const clone: Record<string, unknown> = {};
    seen.set(current, clone);
    for (const [key, child] of Object.entries(
      current as Record<string, unknown>,
    )) {
      clone[
        redactRememberedLocalDocumentPathsFromText(conversationKeyValue, key)
      ] = redact(child);
    }
    return clone;
  };
  return redact(value) as T;
}

export function redactRememberedLocalDocumentPathsFromTerminalValue<T>(
  conversationKeyValue: unknown,
  value: T,
): T {
  const seen = new WeakMap<object, unknown>();
  const redact = (current: unknown): unknown => {
    if (typeof current === "string") {
      return redactRememberedLocalDocumentPathsFromTerminalText(
        conversationKeyValue,
        current,
      );
    }
    if (!current || typeof current !== "object") return current;
    const cached = seen.get(current);
    if (cached) return cached;
    if (Array.isArray(current)) {
      const clone: unknown[] = [];
      seen.set(current, clone);
      for (const entry of current) clone.push(redact(entry));
      return clone;
    }
    const clone: Record<string, unknown> = {};
    seen.set(current, clone);
    for (const [key, child] of Object.entries(
      current as Record<string, unknown>,
    )) {
      clone[
        redactRememberedLocalDocumentPathsFromTerminalText(
          conversationKeyValue,
          key,
        )
      ] = redact(child);
    }
    return clone;
  };
  return redact(value) as T;
}

export function redactAllRememberedLocalDocumentPaths<T>(value: T): T {
  let redacted = value;
  for (const conversationKey of Array.from(
    sensitivePathsByConversation.keys(),
  )) {
    redacted = redactRememberedLocalDocumentPaths(conversationKey, redacted);
  }
  return redacted;
}

export function redactAllRememberedLocalDocumentPathsFromTerminalValue<T>(
  value: T,
): T {
  let redacted = value;
  for (const conversationKey of Array.from(
    sensitivePathsByConversation.keys(),
  )) {
    redacted = redactRememberedLocalDocumentPathsFromTerminalValue(
      conversationKey,
      redacted,
    );
  }
  return redacted;
}

export type LocalDocumentPathStreamFlush = Readonly<{
  channel: string;
  text: string;
}>;

/**
 * Holds only a suffix that can still become a sensitive path. This prevents a
 * model from evading redaction by splitting a path across streaming deltas
 * while preserving normal low-latency output for unrelated text.
 */
export class LocalDocumentPathStreamRedactor {
  private readonly pendingByChannel = new Map<
    string,
    { text: string; replacement: string }
  >();
  private readonly variants: SensitiveReplacementVariant[] = [];
  private readonly variantKeys = new Set<string>();

  constructor(
    private readonly conversationKeyValue: unknown,
    private readonly options: { allConversations?: boolean } = {},
  ) {
    this.refreshVariants();
  }

  private refreshVariants(): void {
    const current = this.options.allConversations
      ? getAllSensitivePathVariants()
      : getSensitivePathVariants(this.conversationKeyValue);
    for (const variant of current) {
      const key = `${variant.pattern.source}\u0000${variant.pattern.flags}\u0000${variant.replacement}`;
      if (this.variantKeys.has(key)) continue;
      this.variantKeys.add(key);
      this.variants.push(variant);
    }
    this.variants.sort((left, right) => right.sortLength - left.sortLength);
  }

  /** Captures newly registered variants into this turn-lifetime snapshot. */
  captureCurrentVariants(): void {
    this.refreshVariants();
  }

  private getVariants(): Array<SensitivePathVariant & { replacement: string }> {
    // Learn paths added after process construction, but never discard a path
    // while this stream is alive. Cleanup can clear the global registry while
    // abort/final callbacks are still draining split chunks.
    this.refreshVariants();
    return this.variants;
  }

  redactText(value: string): string {
    return redactTextWithVariants(value, this.getVariants());
  }

  redactTerminalText(value: string): string {
    return redactTerminalTextWithVariants(value, this.getVariants());
  }

  redactValue<T>(value: T): T {
    return redactValueWithTextRedactor(value, (text) => this.redactText(text));
  }

  redactTerminalValue<T>(value: T): T {
    return redactValueWithTextRedactor(value, (text) =>
      this.redactTerminalText(text),
    );
  }

  push(channel: string, chunk: string): string {
    if (!chunk) return "";
    const previousPending = this.pendingByChannel.get(channel);
    const combined = `${previousPending?.text || ""}${chunk}`;
    const variants = this.getVariants();
    if (!variants.length) return combined;

    const maxVariantLength = variants.reduce(
      (maximum, variant) => Math.max(maximum, variant.sortLength),
      0,
    );
    const firstCandidateIndex = Math.max(
      0,
      combined.length - maxVariantLength - 256,
    );
    let holdStart = -1;
    let holdReplacement = "";
    for (let index = firstCandidateIndex; index < combined.length; index += 1) {
      const suffix = combined.slice(index);
      const partialVariant = variants.find((variant) =>
        variant.canStartWith(suffix),
      );
      if (partialVariant) {
        holdStart = index;
        holdReplacement = partialVariant.replacement;
        break;
      }
    }

    if (holdStart < 0) {
      this.pendingByChannel.delete(channel);
      const redacted = this.redactText(combined);
      if (
        !previousPending ||
        redacted !== combined ||
        !isCrediblePathPrefix(previousPending.text)
      ) {
        return redacted;
      }
      // A held prefix that already names a private location diverged before
      // completing a full path. Never release those held bytes; replace them
      // and stream the new suffix independently so it can itself begin
      // another sensitive path.
      return `${previousPending.replacement}${this.push(channel, chunk)}`;
    }
    this.pendingByChannel.set(channel, {
      text: combined.slice(holdStart),
      replacement: holdReplacement,
    });
    return this.redactText(combined.slice(0, holdStart));
  }

  flush(channel: string): string {
    const pending = this.pendingByChannel.get(channel)?.text || "";
    this.pendingByChannel.delete(channel);
    return this.redactTerminalText(pending);
  }

  flushAll(): LocalDocumentPathStreamFlush[] {
    const flushed = Array.from(this.pendingByChannel, ([channel, pending]) => ({
      channel,
      text: this.redactTerminalText(pending.text),
    })).filter((entry) => entry.text);
    this.pendingByChannel.clear();
    return flushed;
  }

  discard(channel: string): void {
    this.pendingByChannel.delete(channel);
  }
}

type AgentEventFactory = (text: string) => AgentEvent;

export class AgentEventLocalDocumentStreamRedactor {
  private readonly streams: LocalDocumentPathStreamRedactor;
  private readonly pendingEventFactories = new Map<string, AgentEventFactory>();

  constructor(conversationKeyValue: unknown) {
    this.streams = new LocalDocumentPathStreamRedactor(conversationKeyValue);
  }

  process(event: AgentEvent): AgentEvent[] {
    if (event.type === "final") {
      const safeEvent = this.streams.redactTerminalValue(event);
      return [
        ...this.flush(),
        {
          ...safeEvent,
          text: this.streams.redactTerminalText(event.text),
        },
      ];
    }
    if (event.type === "fallback") {
      const safeEvent = this.streams.redactTerminalValue(event);
      return [
        ...this.flush(),
        {
          ...safeEvent,
          reason: this.streams.redactTerminalText(event.reason),
        },
      ];
    }
    if (event.type === "message_rollback") {
      this.streams.discard("message_delta");
      this.pendingEventFactories.delete("message_delta");
      const safeEvent = this.streams.redactTerminalValue(event);
      return [
        {
          ...safeEvent,
          text: this.streams.redactTerminalText(event.text),
        },
      ];
    }
    if (event.type === "message_delta") {
      const channel = "message_delta";
      const safeEvent = this.streams.redactTerminalValue(event);
      this.pendingEventFactories.set(channel, (text) => ({
        ...safeEvent,
        text,
      }));
      const text = this.streams.push(channel, event.text);
      return text ? [{ ...safeEvent, text }] : [];
    }
    if (event.type === "reasoning") {
      const safeEvent = this.streams.redactTerminalValue(event);
      const identity = `${event.round}:${safeEvent.stepId || safeEvent.stepLabel || "default"}`;
      const summaryChannel = `reasoning:${identity}:summary`;
      const detailsChannel = `reasoning:${identity}:details`;
      let summary: string | undefined;
      let details: string | undefined;
      if (event.summary) {
        this.pendingEventFactories.set(summaryChannel, (text) => ({
          ...safeEvent,
          summary: text,
          details: undefined,
        }));
        summary = this.streams.push(summaryChannel, event.summary) || undefined;
      }
      if (event.details) {
        this.pendingEventFactories.set(detailsChannel, (text) => ({
          ...safeEvent,
          summary: undefined,
          details: text,
        }));
        details = this.streams.push(detailsChannel, event.details) || undefined;
      }
      return summary || details ? [{ ...safeEvent, summary, details }] : [];
    }
    if (event.type === "codex_progress") {
      // A step list is a whole snapshot, not a fragment of a longer text:
      // holding back its tail would drop or garble the list.
      if (event.steps?.length) return [this.streams.redactTerminalValue(event)];
      const safeEvent = this.streams.redactTerminalValue(event);
      const channel = `codex_progress:${event.itemId}`;
      this.pendingEventFactories.set(channel, (text) => ({
        ...safeEvent,
        text,
      }));
      const text = this.streams.push(channel, event.text);
      return text ? [{ ...safeEvent, text }] : [];
    }
    // Every other event, including status lines and provider payloads, is a
    // whole record rather than a fragment of a longer text, so it is redacted
    // on its own and nothing is held for the next event.
    return [this.streams.redactTerminalValue(event)];
  }

  flush(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const entry of this.streams.flushAll()) {
      const factory = this.pendingEventFactories.get(entry.channel);
      if (factory) events.push(factory(entry.text));
    }
    this.pendingEventFactories.clear();
    return events;
  }
}

export function redactAgentEventLocalDocumentPaths(
  conversationKeyValue: unknown,
  event: AgentEvent,
): AgentEvent {
  return redactRememberedLocalDocumentPathsFromTerminalValue(
    conversationKeyValue,
    event,
  );
}
