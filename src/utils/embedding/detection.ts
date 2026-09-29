import type { DiscoveredModel } from "../../modelCapabilities/types";
import {
  buildDetectionIdentity,
  type EmbeddingCapabilityRecord,
} from "./detectionRecord";
import type { EmbeddingImagesPref } from "./settings";
import {
  EmbeddingRequestError,
  type EmbeddingRequestFormat,
  type MultimodalItem,
} from "./types";

/** Statuses meaning "this model/endpoint does not take this input". */
const IMAGE_UNSUPPORTED_STATUSES = new Set([400, 415, 422]);

export function extractModelDeclaration(
  models: DiscoveredModel[],
  model: string,
): { ownedBy?: string; declaredImage?: boolean } {
  const wanted = model.trim().toLowerCase();
  const matched = models.find((entry) => entry.id.toLowerCase() === wanted);
  const ownedBy =
    matched?.ownedBy || models.find((entry) => entry.ownedBy)?.ownedBy;
  const declaredImage = matched?.inputs?.image;
  return {
    ...(ownedBy ? { ownedBy } : {}),
    ...(typeof declaredImage === "boolean" ? { declaredImage } : {}),
  };
}

/**
 * Only a request error the endpoint answers with 400/415/422 says the model
 * rejects images. Auth, rate limits, server and network failures say nothing
 * about the model and must not be recorded as "unsupported".
 */
export function classifyImageProbeFailure(
  error: unknown,
): "unsupported" | "unknown" {
  return error instanceof EmbeddingRequestError &&
    IMAGE_UNSUPPORTED_STATUSES.has(error.status)
    ? "unsupported"
    : "unknown";
}

export type EmbeddingCapabilityTestOutcome =
  | { kind: "both_ok"; dimension: number }
  | { kind: "text_only_ok"; dimension: number }
  | {
      kind: "dimension_mismatch";
      textDimension: number;
      imageDimension: number;
    }
  | { kind: "text_failed"; error: unknown }
  | { kind: "image_unsupported"; error: unknown }
  | { kind: "image_unknown"; error: unknown };

export type EmbeddingCapabilityTestDeps = {
  apiBase: string;
  model: string;
  previousRecord: EmbeddingCapabilityRecord | null;
  /** "" (auto) or "on"; a manual "off" never runs this flow. */
  imagesPref: EmbeddingImagesPref;
  fetchModels: () => Promise<DiscoveredModel[]>;
  resolveFormat: (ownedBy: string | undefined) => EmbeddingRequestFormat;
  embed: (
    items: MultimodalItem[],
    format: EmbeddingRequestFormat,
  ) => Promise<number[][]>;
  testImageDataUrl: string;
  now: () => number;
};

export async function runEmbeddingCapabilityTest(
  deps: EmbeddingCapabilityTestDeps,
): Promise<{
  outcome: EmbeddingCapabilityTestOutcome;
  record: EmbeddingCapabilityRecord;
}> {
  const identity = buildDetectionIdentity(deps.apiBase, deps.model);
  let declaration: { ownedBy?: string; declaredImage?: boolean } = {};
  try {
    declaration = extractModelDeclaration(await deps.fetchModels(), deps.model);
  } catch {
    // No catalog is fine: detection falls back to the probe.
  }
  const previousProbe =
    deps.previousRecord?.identity === identity
      ? deps.previousRecord.probe
      : undefined;
  const record: EmbeddingCapabilityRecord = {
    identity,
    ...declaration,
    ...(previousProbe ? { probe: previousProbe } : {}),
  };
  const format = deps.resolveFormat(declaration.ownedBy);
  const textItem: MultimodalItem = { kind: "text", text: "test" };
  const imageItem: MultimodalItem = {
    kind: "image",
    dataUrl: deps.testImageDataUrl,
  };

  const finishPair = (textVector: number[], imageVector: number[]) => {
    if (textVector.length !== imageVector.length) {
      return {
        outcome: {
          kind: "dimension_mismatch" as const,
          textDimension: textVector.length,
          imageDimension: imageVector.length,
        },
        record,
      };
    }
    record.probe = { format, image: "supported", checkedAt: deps.now() };
    return {
      outcome: { kind: "both_ok" as const, dimension: textVector.length },
      record,
    };
  };

  if (deps.imagesPref === "" && declaration.declaredImage === false) {
    try {
      const [vector] = await deps.embed([textItem], "openai_compat");
      return {
        outcome: { kind: "text_only_ok", dimension: vector.length },
        record,
      };
    } catch (error) {
      return { outcome: { kind: "text_failed", error }, record };
    }
  }

  try {
    const [textVector, imageVector] = await deps.embed(
      [textItem, imageItem],
      format,
    );
    return finishPair(textVector, imageVector);
  } catch {
    // Retry each half alone to learn which one failed.
  }

  let textVector: number[];
  try {
    [textVector] = await deps.embed([textItem], format);
  } catch (error) {
    return { outcome: { kind: "text_failed", error }, record };
  }
  try {
    const [imageVector] = await deps.embed([imageItem], format);
    return finishPair(textVector, imageVector);
  } catch (error) {
    if (classifyImageProbeFailure(error) === "unsupported") {
      record.probe = { format, image: "unsupported", checkedAt: deps.now() };
      return { outcome: { kind: "image_unsupported", error }, record };
    }
    return { outcome: { kind: "image_unknown", error }, record };
  }
}
