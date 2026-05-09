export type MultipartTextField = {
  name: string;
  value: string;
};

export type MultipartFileField = {
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
};

export type MultipartField = MultipartTextField | MultipartFileField;

export type MultipartRequest = {
  body: BodyInit;
  contentType?: string;
  mode: "formdata" | "manual";
};

function getFormDataCtor(): typeof FormData | undefined {
  const fromGlobal = (globalThis as { FormData?: typeof FormData }).FormData;
  if (typeof fromGlobal === "function") return fromGlobal;
  const fromToolkit = ztoolkit.getGlobal("FormData") as
    | typeof FormData
    | undefined;
  return typeof fromToolkit === "function" ? fromToolkit : undefined;
}

function getBlobCtor(): typeof Blob | undefined {
  const fromGlobal = (globalThis as { Blob?: typeof Blob }).Blob;
  if (typeof fromGlobal === "function") return fromGlobal;
  const fromToolkit = ztoolkit.getGlobal("Blob") as typeof Blob | undefined;
  return typeof fromToolkit === "function" ? fromToolkit : undefined;
}

export function toSafeMultipartToken(
  value: string | undefined,
  fallback = "field",
): string {
  return (value || "").replace(/[\r\n"]/g, "_").trim() || fallback;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function buildManualMultipartBody(
  fields: MultipartField[],
  options: {
    boundaryPrefix?: string;
    fallbackName?: string;
  } = {},
): { body: Uint8Array; contentType: string } {
  const encoder = new TextEncoder();
  const boundaryPrefix = options.boundaryPrefix || "llmforzotero";
  const boundary = `----${boundaryPrefix}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const fallbackName = options.fallbackName || "field";
  const parts: Uint8Array[] = [];

  for (const field of fields) {
    const safeName = toSafeMultipartToken(field.name, fallbackName);
    if ("data" in field) {
      const safeFilename = toSafeMultipartToken(field.filename, "attachment");
      const safeContentType = toSafeMultipartToken(
        field.contentType,
        "application/octet-stream",
      );
      parts.push(
        encoder.encode(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"\r\n` +
            `Content-Type: ${safeContentType}\r\n\r\n`,
        ),
      );
      parts.push(field.data);
      parts.push(encoder.encode("\r\n"));
    } else {
      parts.push(
        encoder.encode(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${safeName}"\r\n\r\n` +
            `${field.value}\r\n`,
        ),
      );
    }
  }

  parts.push(encoder.encode(`--${boundary}--\r\n`));
  return {
    body: concatBytes(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export function buildMultipartRequest(
  fields: MultipartField[],
  options: {
    boundaryPrefix?: string;
    fallbackName?: string;
    preferFormData?: boolean;
  } = {},
): MultipartRequest {
  const FormDataCtor = getFormDataCtor();
  const BlobCtor = getBlobCtor();
  if (options.preferFormData !== false && FormDataCtor && BlobCtor) {
    const body = new FormDataCtor();
    for (const field of fields) {
      if ("data" in field) {
        const blob = new BlobCtor([field.data], {
          type: field.contentType || "application/octet-stream",
        });
        body.append(
          field.name || options.fallbackName || "field",
          blob,
          field.filename || "attachment",
        );
      } else {
        body.append(field.name || options.fallbackName || "field", field.value);
      }
    }
    return { body, mode: "formdata" };
  }

  const manual = buildManualMultipartBody(fields, options);
  return {
    body: manual.body,
    contentType: manual.contentType,
    mode: "manual",
  };
}
