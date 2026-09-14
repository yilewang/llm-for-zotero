import type { AgentSearchCondition } from "../services/zoteroGateway";
import { validateObject } from "./shared";

// Model-facing names must also be valid MFJS property names. Zotero's native
// `required` flag is represented as `isRequired` in both search tools.
export const SEARCH_CONDITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["condition", "operator"],
  properties: {
    condition: {
      type: "string",
      description:
        "A Zotero search condition, e.g. 'title', 'abstractNote', 'fulltextContent', 'dateAdded', 'DOI', 'itemType', 'tag', 'collection', 'note', 'annotationText', 'citationKey', 'retracted'.",
    },
    operator: {
      type: "string",
      description:
        "An operator the condition accepts, e.g. is, isNot, contains, doesNotContain, beginsWith, isBefore, isAfter, isInTheLast, isLessThan, isGreaterThan, true, false. An invalid pairing is rejected with the list of valid operators for that condition.",
    },
    value: {
      description: "The value to compare against.",
      anyOf: [{ type: "string" }, { type: "number" }],
    },
    mode: {
      type: "string",
      description:
        "Sub-mode for conditions that take one, notably fulltextContent with 'phrase' or 'regexp'.",
    },
    isRequired: {
      type: "boolean",
      description:
        "Force this clause to be required even under joinMode:'any'.",
    },
  },
};

/** Parse tool input without duplicating Zotero's condition/operator vocabulary. */
export function parseSearchCondition(
  value: unknown,
): AgentSearchCondition | undefined {
  if (!validateObject<Record<string, unknown>>(value)) return undefined;
  const condition =
    typeof value.condition === "string" ? value.condition.trim() : "";
  if (!condition) return undefined;
  return {
    condition,
    operator: typeof value.operator === "string" ? value.operator.trim() : "",
    value:
      typeof value.value === "string" || typeof value.value === "number"
        ? value.value
        : undefined,
    mode: typeof value.mode === "string" ? value.mode.trim() : undefined,
    required: value.isRequired === true ? true : undefined,
  };
}
