import type { AgentModelContentPart, AgentModelMessage } from "../agent/types";
import { parseDataUrl } from "../agent/model/shared";
import type { ChatMessage, MessageContent } from "./llmClient";
import { fileUrlToPath } from "./pathFileUrl";
import { joinLocalPath } from "./localPath";

export type CodexAppServerUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

type CodexAppServerHistoryInputPart =
  | { type: "input_text"; text: string }
  | {
      type: "input_image";
      image_url: string;
      detail?: "low" | "high" | "auto";
    };

type CodexAppServerHistoryOutputPart = { type: "output_text"; text: string };

export type CodexAppServerHistoryItem =
  | {
      type: "message";
      role: "system" | "user";
      content: CodexAppServerHistoryInputPart[];
    }
  | {
      type: "message";
      role: "assistant";
      content: CodexAppServerHistoryOutputPart[];
    };

export type CodexAppServerPreparedTurn = {
  developerInstructions?: string;
  historyItemsToInject: CodexAppServerHistoryItem[];
  turnInput: CodexAppServerUserInput[];
};

const MAX_APP_SERVER_IMAGE_FILES = 128;

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  getChildren?: (path: string) => Promise<string[]>;
  remove?: (
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ) => Promise<void>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
};

type OSFileLike = {
  exists?: (path: string) => Promise<boolean>;
  writeAtomic?: (path: string, data: Uint8Array) => Promise<void>;
  remove?: (
    path: string,
    options?: { ignoreAbsent?: boolean },
  ) => Promise<void>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

function getWritableRoot(): string {
  const zotero = Zotero as unknown as {
    DataDirectory?: { dir?: string };
    Profile?: { dir?: string };
    getTempDirectory?: () => { path?: string } | null;
  };
  const dataDir = zotero.DataDirectory?.dir?.trim();
  if (dataDir) return dataDir;
  const profileDir = zotero.Profile?.dir?.trim();
  if (profileDir) return profileDir;
  const tempDir = zotero.getTempDirectory?.()?.path?.trim();
  if (tempDir) return tempDir;
  throw new Error(
    "Cannot resolve writable directory for Codex app-server images",
  );
}

function getAppServerImageDir(): string {
  return joinLocalPath(
    getWritableRoot(),
    "llm-for-zotero-codex-app-server-images",
  );
}

async function pathExists(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.exists) {
    try {
      return Boolean(await io.exists(path));
    } catch {
      return false;
    }
  }
  const osFile = getOSFile();
  if (osFile?.exists) {
    try {
      return Boolean(await osFile.exists(path));
    } catch {
      return false;
    }
  }
  return false;
}

async function ensureDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, {
      from: getWritableRoot(),
      ignoreExisting: true,
    });
    return;
  }
  throw new Error("No directory API available for Codex app-server images");
}

async function writeBytes(path: string, data: Uint8Array): Promise<void> {
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, data);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, data);
    return;
  }
  throw new Error("No file write API available for Codex app-server images");
}

async function listChildren(path: string): Promise<string[]> {
  const io = getIOUtils();
  if (io?.getChildren) {
    try {
      return await io.getChildren(path);
    } catch {
      return [];
    }
  }
  return [];
}

async function removePath(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.remove) {
    await io.remove(path, { ignoreAbsent: true });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.remove) {
    await osFile.remove(path, { ignoreAbsent: true });
  }
}

function decodeBase64(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, "");
  const atobFn = (
    globalThis as typeof globalThis & {
      atob?: (value: string) => string;
    }
  ).atob;
  if (typeof atobFn !== "function") {
    throw new Error("atob is unavailable");
  }
  const binary = atobFn(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function mimeTypeToExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/svg+xml":
      return ".svg";
    default:
      return ".img";
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function persistDataUrlImage(url: string): Promise<string | null> {
  const parsed = parseDataUrl(url);
  if (!parsed || !/^image\//i.test(parsed.mimeType)) {
    return null;
  }
  const bytes = decodeBase64(parsed.data);
  const hash = await sha256Hex(bytes);
  const imageDir = getAppServerImageDir();
  const imagePath = joinLocalPath(
    imageDir,
    `${hash}${mimeTypeToExtension(parsed.mimeType)}`,
  );
  if (!(await pathExists(imagePath))) {
    await ensureDir(imageDir);
    await writeBytes(imagePath, bytes);
    void prunePersistedDataUrlImages(imagePath);
  }
  return imagePath;
}

async function prunePersistedDataUrlImages(retainPath: string): Promise<void> {
  const imageDir = getAppServerImageDir();
  const entries = await listChildren(imageDir);
  if (entries.length <= MAX_APP_SERVER_IMAGE_FILES) return;

  const removable = entries.filter((entry) => entry !== retainPath).sort();
  const excessCount = entries.length - MAX_APP_SERVER_IMAGE_FILES;
  for (const entry of removable.slice(0, excessCount)) {
    try {
      await removePath(entry);
    } catch {
      /* ignore cleanup failures */
    }
  }
}

async function buildImageInput(url: string): Promise<CodexAppServerUserInput> {
  const localPath = fileUrlToPath(url);
  if (localPath) {
    return {
      type: "localImage",
      path: localPath,
    };
  }
  if (/^data:/i.test(url.trim())) {
    const persistedPath = await persistDataUrlImage(url);
    if (persistedPath) {
      return {
        type: "localImage",
        path: persistedPath,
      };
    }
  }
  return {
    type: "image",
    url,
  };
}

function pushTextInput(
  target: CodexAppServerUserInput[],
  text: string,
  label?: string,
): void {
  const body = text.trim();
  target.push({
    type: "text",
    text: label ? `${label}:\n${body || "[Empty message]"}` : body,
  });
}

function splitChatContent(content: MessageContent): {
  text: string;
  imageUrls: string[];
} {
  if (typeof content === "string") {
    return { text: content, imageUrls: [] };
  }

  const lines: string[] = [];
  const imageUrls: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      const text = part.text.trim();
      if (text) lines.push(text);
      continue;
    }
    imageUrls.push(part.image_url.url);
  }

  return {
    text: lines.join("\n\n"),
    imageUrls,
  };
}

function pushHistoryTextPart(
  target: CodexAppServerHistoryInputPart[] | CodexAppServerHistoryOutputPart[],
  role: "system" | "user" | "assistant",
  text: string,
): void {
  const body = text.trim();
  if (role === "assistant") {
    (target as CodexAppServerHistoryOutputPart[]).push({
      type: "output_text",
      text: body || "[Empty message]",
    });
    return;
  }
  (target as CodexAppServerHistoryInputPart[]).push({
    type: "input_text",
    text: body || "[Empty message]",
  });
}

function canInjectHistoryImage(url: string): boolean {
  const normalized = url.trim();
  if (!normalized) return false;
  return !fileUrlToPath(normalized);
}

function buildHistoryImagePlaceholder(count: number): string {
  return `[${count} image(s) attached]`;
}

async function buildHistoryMessageItem(params: {
  role: "system" | "user" | "assistant";
  text: string;
  imageUrls: string[];
}): Promise<CodexAppServerHistoryItem> {
  const { role, text, imageUrls } = params;
  if (role === "assistant") {
    const content: CodexAppServerHistoryOutputPart[] = [];
    if (text.trim()) {
      pushHistoryTextPart(content, role, text);
    }
    if (!content.length || imageUrls.length > 0) {
      pushHistoryTextPart(
        content,
        role,
        imageUrls.length > 0
          ? buildHistoryImagePlaceholder(imageUrls.length)
          : "",
      );
    }
    return {
      type: "message",
      role,
      content,
    };
  }

  const content: CodexAppServerHistoryInputPart[] = [];
  if (text.trim()) {
    pushHistoryTextPart(content, role, text);
  }

  let omittedImages = 0;
  for (const rawUrl of imageUrls) {
    const url = rawUrl.trim();
    if (!url) continue;
    if (!canInjectHistoryImage(url)) {
      omittedImages += 1;
      continue;
    }
    content.push({
      type: "input_image",
      image_url: url,
      detail: "high",
    });
  }

  if (!content.length || omittedImages > 0) {
    pushHistoryTextPart(
      content,
      role,
      omittedImages > 0 ? buildHistoryImagePlaceholder(omittedImages) : "",
    );
  }

  return {
    type: "message",
    role,
    content,
  };
}

async function buildTurnInput(params: {
  text: string;
  imageUrls: string[];
}): Promise<CodexAppServerUserInput[]> {
  const input: CodexAppServerUserInput[] = [];
  if (params.text || !params.imageUrls.length) {
    pushTextInput(input, params.text);
  }
  for (const url of params.imageUrls) {
    input.push(await buildImageInput(url));
  }
  return input.length ? input : [{ type: "text", text: "" }];
}

function getChatRoleLabel(
  role: ChatMessage["role"],
): "System" | "Assistant" | "User" {
  return role === "system"
    ? "System"
    : role === "assistant"
      ? "Assistant"
      : "User";
}

async function buildLegacyChatMessageInput(
  message: ChatMessage,
): Promise<CodexAppServerUserInput[]> {
  const { text, imageUrls } = splitChatContent(message.content);
  const fallbackText = imageUrls.length
    ? `[${imageUrls.length} image(s) attached]`
    : "";
  const input: CodexAppServerUserInput[] = [];
  pushTextInput(input, text || fallbackText, getChatRoleLabel(message.role));
  for (const url of imageUrls) {
    input.push(await buildImageInput(url));
  }
  return input;
}

function extractFirstChatSystemInstruction(
  messages: readonly ChatMessage[],
): string | undefined {
  for (const message of messages) {
    if (message.role !== "system") continue;
    const { text } = splitChatContent(message.content);
    const normalized = text.trim();
    if (normalized) return normalized;
    return undefined;
  }
  return undefined;
}

function splitAgentContent(content: AgentModelMessage["content"]): {
  text: string;
  imageUrls: string[];
} {
  if (typeof content === "string") {
    return { text: content, imageUrls: [] };
  }

  const lines: string[] = [];
  const imageUrls: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      const text = part.text.trim();
      if (text) lines.push(text);
      continue;
    }
    if (part.type === "image_url") {
      imageUrls.push(part.image_url.url);
      continue;
    }
    lines.push(`[Prepared file: ${part.file_ref.name}]`);
  }

  return {
    text: lines.join("\n\n"),
    imageUrls,
  };
}

function extractFirstAgentSystemInstruction(
  messages: readonly AgentModelMessage[],
): string | undefined {
  for (const message of messages) {
    if (message.role !== "system") continue;
    const { text } = splitAgentContent(message.content);
    const normalized = text.trim();
    if (normalized) return normalized;
    return undefined;
  }
  return undefined;
}

function getAgentRoleLabel(
  role: Exclude<AgentModelMessage, { role: "tool" }>["role"],
): "System" | "Assistant" | "User" {
  return role === "system"
    ? "System"
    : role === "assistant"
      ? "Assistant"
      : "User";
}

async function buildLegacyAgentMessageInput(
  message: Exclude<AgentModelMessage, { role: "tool" }>,
): Promise<CodexAppServerUserInput[]> {
  const { text, imageUrls } = splitAgentContent(message.content);
  const fallbackText = imageUrls.length
    ? `[${imageUrls.length} image(s) attached]`
    : "";
  const input: CodexAppServerUserInput[] = [];
  pushTextInput(input, text || fallbackText, getAgentRoleLabel(message.role));
  for (const url of imageUrls) {
    input.push(await buildImageInput(url));
  }
  return input;
}

export async function prepareCodexAppServerChatTurn(
  messages: ChatMessage[],
): Promise<CodexAppServerPreparedTurn> {
  const developerInstructions = extractFirstChatSystemInstruction(messages);
  const visibleMessages = messages.filter(
    (message) => message.role !== "system",
  );
  let latestUserIndex = -1;
  for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
    if (visibleMessages[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }

  const historyItemsToInject: CodexAppServerHistoryItem[] = [];
  const historyMessages =
    latestUserIndex >= 0
      ? visibleMessages.slice(0, latestUserIndex)
      : visibleMessages;
  for (const message of historyMessages) {
    const { text, imageUrls } = splitChatContent(message.content);
    historyItemsToInject.push(
      await buildHistoryMessageItem({
        role: message.role,
        text,
        imageUrls,
      }),
    );
  }

  const latestUserMessage =
    latestUserIndex >= 0 ? visibleMessages[latestUserIndex] : undefined;
  const turnInput = latestUserMessage
    ? await buildTurnInput(splitChatContent(latestUserMessage.content))
    : [{ type: "text" as const, text: "" }];

  return {
    developerInstructions,
    historyItemsToInject,
    turnInput,
  };
}

export async function buildLegacyCodexAppServerChatInput(
  messages: ChatMessage[],
  options: { includeSystem?: boolean } = {},
): Promise<CodexAppServerUserInput[]> {
  const includeSystem = options.includeSystem !== false;
  const input: CodexAppServerUserInput[] = [];
  for (const message of messages) {
    if (!includeSystem && message.role === "system") continue;
    input.push(...(await buildLegacyChatMessageInput(message)));
  }
  return input.length ? input : [{ type: "text", text: "" }];
}

export async function extractLatestCodexAppServerUserInput(
  messages: AgentModelMessage[],
): Promise<CodexAppServerUserInput[]> {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return buildTurnInput(splitAgentContent(message.content));
  }
  return [{ type: "text", text: "" }];
}

export async function prepareCodexAppServerAgentTurn(
  messages: AgentModelMessage[],
): Promise<CodexAppServerPreparedTurn> {
  const seededMessages = messages.filter(
    (message): message is Exclude<AgentModelMessage, { role: "tool" }> =>
      message.role !== "tool",
  );
  const developerInstructions = extractFirstAgentSystemInstruction(messages);
  const visibleHistoryMessages = seededMessages.filter(
    (message) => message.role !== "system",
  );

  let latestUserIndex = -1;
  for (let i = visibleHistoryMessages.length - 1; i >= 0; i -= 1) {
    if (visibleHistoryMessages[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }

  const historyItemsToInject: CodexAppServerHistoryItem[] = [];
  const historyMessages =
    latestUserIndex >= 0
      ? visibleHistoryMessages.slice(0, latestUserIndex)
      : visibleHistoryMessages;
  for (const message of historyMessages) {
    const { text, imageUrls } = splitAgentContent(message.content);
    historyItemsToInject.push(
      await buildHistoryMessageItem({
        role: message.role,
        text,
        imageUrls,
      }),
    );
  }

  const latestUserMessage =
    latestUserIndex >= 0 ? visibleHistoryMessages[latestUserIndex] : undefined;
  const turnInput = latestUserMessage
    ? await buildTurnInput(splitAgentContent(latestUserMessage.content))
    : [{ type: "text" as const, text: "" }];

  return {
    developerInstructions,
    historyItemsToInject,
    turnInput,
  };
}

export async function buildLegacyCodexAppServerAgentInitialInput(
  messages: AgentModelMessage[],
  options: { includeSystem?: boolean } = {},
): Promise<CodexAppServerUserInput[]> {
  const includeSystem = options.includeSystem !== false;
  const input: CodexAppServerUserInput[] = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    if (!includeSystem && message.role === "system") continue;
    input.push(...(await buildLegacyAgentMessageInput(message)));
  }
  return input.length ? input : [{ type: "text", text: "" }];
}

export function isCodexAppServerImageInput(
  input: CodexAppServerUserInput,
): input is Extract<CodexAppServerUserInput, { type: "image" | "localImage" }> {
  return input.type === "image" || input.type === "localImage";
}
