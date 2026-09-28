import { isEmbeddingRequestFormat, type EmbeddingRequestFormat } from "./types";

export type EmbeddingProbeResult = {
  format: EmbeddingRequestFormat;
  image: "supported" | "unsupported";
  checkedAt: number;
};

/**
 * What the settings-page Test learned about one API URL + model. Only the
 * current configuration's record is kept; a different identity voids it.
 */
export type EmbeddingCapabilityRecord = {
  identity: string;
  ownedBy?: string;
  declaredImage?: boolean;
  probe?: EmbeddingProbeResult;
};

export function buildDetectionIdentity(apiBase: string, model: string): string {
  return `${apiBase.trim().replace(/\/+$/, "")}|${model.trim()}`;
}

export function parseDetectionRecord(
  raw: unknown,
): EmbeddingCapabilityRecord | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.identity !== "string" || !row.identity) return null;
  const record: EmbeddingCapabilityRecord = { identity: row.identity };
  if (typeof row.ownedBy === "string") record.ownedBy = row.ownedBy;
  if (typeof row.declaredImage === "boolean") {
    record.declaredImage = row.declaredImage;
  }
  const probe = row.probe as Record<string, unknown> | undefined;
  if (
    probe &&
    isEmbeddingRequestFormat(probe.format) &&
    (probe.image === "supported" || probe.image === "unsupported") &&
    typeof probe.checkedAt === "number"
  ) {
    record.probe = {
      format: probe.format,
      image: probe.image,
      checkedAt: probe.checkedAt,
    };
  }
  return record;
}

export function serializeDetectionRecord(
  record: EmbeddingCapabilityRecord,
): string {
  return JSON.stringify(record);
}
