export type RecoveryPayload =
  | {
      storage: "inline";
      content: string;
      checksum: string;
      sizeBytes: number;
      encoding?: "utf8" | "base64";
    }
  | {
      storage: "blob";
      blobPath: string;
      checksum: string;
      sizeBytes: number;
    };

const INLINE_LIMIT = 64 * 1024;
let recoveryBlobSequence = 0;

function nextRecoveryBlobName(): string {
  recoveryBlobSequence += 1;
  return `payload-${Date.now()}-${recoveryBlobSequence}-${Math.random()
    .toString(36)
    .slice(2, 8)}.bin`;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  const encode = (globalThis as { btoa?: (value: string) => string }).btoa;
  if (typeof encode !== "function") {
    throw new Error("Base64 encoding is unavailable for recovery payloads");
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return encode(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const decode = (globalThis as { atob?: (value: string) => string }).atob;
  if (typeof decode !== "function") {
    throw new Error("Base64 decoding is unavailable for recovery payloads");
  }
  const binary = decode(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoObject?.subtle) {
    throw new Error("SHA-256 is unavailable for recovery payload verification");
  }
  // TypeScript models a Uint8Array as potentially backed by a
  // SharedArrayBuffer, while WebCrypto deliberately accepts an ArrayBuffer.
  // Copying also prevents a caller from mutating the bytes while the digest is
  // being computed.
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const digest = await cryptoObject.subtle.digest(
    "SHA-256",
    stableBytes.buffer,
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

function profileDirectory(): string {
  const pathUtils = (globalThis as { PathUtils?: { profileDir?: unknown } })
    .PathUtils;
  if (typeof pathUtils?.profileDir === "string" && pathUtils.profileDir) {
    return pathUtils.profileDir;
  }
  const profile = (
    Zotero as unknown as {
      Profile?: { dir?: { path?: unknown } | string };
    }
  ).Profile?.dir;
  if (typeof profile === "string") return profile;
  if (profile && typeof profile.path === "string") return profile.path;
  throw new Error("The Zotero profile directory is unavailable");
}

function join(...parts: string[]): string {
  const pathUtils = (
    globalThis as {
      PathUtils?: { join?: (...values: string[]) => string };
    }
  ).PathUtils;
  if (typeof pathUtils?.join === "function") return pathUtils.join(...parts);
  return parts
    .map((part, index) =>
      index === 0 ? part.replace(/[\\/]$/, "") : part.replace(/^[\\/]/, ""),
    )
    .join("/");
}

function recoveryDirectory(): string {
  return join(profileDirectory(), "llm-for-zotero", "journal-recovery");
}

export async function storeRecoveryText(
  value: string,
): Promise<RecoveryPayload> {
  const bytes = new TextEncoder().encode(value);
  const checksum = await sha256Bytes(bytes);
  if (bytes.byteLength <= INLINE_LIMIT) {
    return {
      storage: "inline",
      content: value,
      checksum,
      sizeBytes: bytes.byteLength,
    };
  }
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  if (
    typeof io?.write !== "function" ||
    typeof io?.makeDirectory !== "function"
  ) {
    throw new Error("Binary recovery storage is unavailable");
  }
  const directory = recoveryDirectory();
  await io.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const blobPath = join(directory, nextRecoveryBlobName());
  await io.write(blobPath, bytes, { tmpPath: `${blobPath}.tmp` });
  return { storage: "blob", blobPath, checksum, sizeBytes: bytes.byteLength };
}

/** Store an exact byte pre-image so undo never changes the original encoding. */
export async function storeRecoveryBytes(
  source: Uint8Array,
): Promise<RecoveryPayload> {
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const checksum = await sha256Bytes(bytes);
  if (bytes.byteLength <= INLINE_LIMIT) {
    return {
      storage: "inline",
      content: bytesToBase64(bytes),
      checksum,
      sizeBytes: bytes.byteLength,
      encoding: "base64",
    };
  }
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  if (
    typeof io?.write !== "function" ||
    typeof io?.makeDirectory !== "function"
  ) {
    throw new Error("Binary recovery storage is unavailable");
  }
  const directory = recoveryDirectory();
  await io.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const blobPath = join(directory, nextRecoveryBlobName());
  await io.write(blobPath, bytes, { tmpPath: `${blobPath}.tmp` });
  return { storage: "blob", blobPath, checksum, sizeBytes: bytes.byteLength };
}

/** Remove crash-orphaned payload files that have no durable journal row. */
export async function sweepOrphanRecoveryBlobs(
  referencedPaths: Iterable<string>,
): Promise<void> {
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  if (
    typeof io?.getChildren !== "function" ||
    typeof io?.remove !== "function"
  ) {
    return;
  }
  const directory = recoveryDirectory();
  if (typeof io.exists === "function" && !(await io.exists(directory))) return;
  let children: string[];
  try {
    children = await io.getChildren(directory);
  } catch (error) {
    if (/not found|does not exist|no such/i.test(String(error))) return;
    throw error;
  }
  const referenced = new Set([...referencedPaths].filter(Boolean));
  for (const path of children) {
    const name = path.split(/[\\/]/).pop() || "";
    if (!/^payload-.*\.bin(?:\.tmp)?$/.test(name) || referenced.has(path)) {
      continue;
    }
    await io.remove(path, { ignoreAbsent: true });
  }
}

export async function readRecoveryText(
  payload: RecoveryPayload,
): Promise<string> {
  if (payload.storage === "inline" && payload.encoding !== "base64") {
    const checksum = await sha256Text(payload.content);
    if (checksum !== payload.checksum) {
      throw new Error("Inline recovery payload checksum mismatch");
    }
    return payload.content;
  }
  return new TextDecoder().decode(await readRecoveryBytes(payload));
}

export async function readRecoveryBytes(
  payload: RecoveryPayload,
): Promise<Uint8Array> {
  if (payload.storage === "inline") {
    const bytes =
      payload.encoding === "base64"
        ? base64ToBytes(payload.content)
        : new TextEncoder().encode(payload.content);
    const checksum = await sha256Bytes(bytes);
    if (checksum !== payload.checksum) {
      throw new Error("Inline recovery payload checksum mismatch");
    }
    return bytes;
  }
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  if (typeof io?.read !== "function") {
    throw new Error("Binary recovery storage is unavailable");
  }
  const bytes = new Uint8Array(await io.read(payload.blobPath));
  const checksum = await sha256Bytes(bytes);
  if (checksum !== payload.checksum) {
    throw new Error("Recovery blob checksum mismatch");
  }
  return bytes;
}
