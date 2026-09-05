import bundledRegistry from "../../registry/model-capabilities.v1.json";
import type { ModelCapabilityRegistry } from "./types";

/** The checked-in JSON is the single bundled registry data source. */
export const BUNDLED_MODEL_CAPABILITY_REGISTRY =
  bundledRegistry as ModelCapabilityRegistry;
