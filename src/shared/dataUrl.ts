export function parseDataUrl(
  url: string,
): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
  };
}

export function encodeBytesBase64(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(
      index,
      Math.min(bytes.length, index + chunkSize),
    );
    out += String.fromCharCode(...chunk);
  }
  const btoaFn = (
    globalThis as typeof globalThis & { btoa?: (v: string) => string }
  ).btoa;
  if (typeof btoaFn !== "function") throw new Error("btoa is unavailable");
  return btoaFn(out);
}

export function decodeBase64Bytes(base64: string): Uint8Array {
  const atobFn = (
    globalThis as typeof globalThis & { atob?: (v: string) => string }
  ).atob;
  if (typeof atobFn !== "function") throw new Error("atob is unavailable");
  const binary = atobFn(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
