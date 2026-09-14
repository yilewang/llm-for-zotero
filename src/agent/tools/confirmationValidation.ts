import type {
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentPendingField,
} from "../types";

export type ConfirmationValidation =
  | { ok: true; actionId?: string; data: Record<string, unknown> }
  | { ok: false; error: string };

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function fieldOptionIds(field: AgentPendingField): string[] {
  if (
    field.type === "select" ||
    field.type === "choice" ||
    field.type === "assignment_table"
  ) {
    return field.options.map((option) => option.id);
  }
  return [];
}

function validateChoiceValue(
  field: Extract<AgentPendingField, { type: "choice" }>,
  value: unknown,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `Invalid choice for confirmation field ${field.id}`;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "option") {
    if (
      Object.keys(record).some((key) => key !== "kind" && key !== "optionId") ||
      typeof record.optionId !== "string" ||
      !field.options.some((option) => option.id === record.optionId)
    ) {
      return `Invalid option for confirmation field ${field.id}`;
    }
    return null;
  }
  if (record.kind === "custom") {
    if (
      Object.keys(record).some((key) => key !== "kind" && key !== "text") ||
      field.allowCustom !== true ||
      typeof record.text !== "string" ||
      !record.text.trim()
    ) {
      return `Invalid custom answer for confirmation field ${field.id}`;
    }
    return null;
  }
  return `Invalid choice for confirmation field ${field.id}`;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Validate a confirmation against the exact card schema that was rendered.
 * Tool-specific applyConfirmation handlers may normalize values, but they do
 * not get to expand the schema or accept undeclared choices.
 */
export function validateConfirmationResolution(
  action: AgentPendingAction,
  resolution: AgentConfirmationResolution,
): ConfirmationValidation {
  const duplicateField = duplicate(action.fields.map((field) => field.id));
  if (duplicateField) {
    return {
      ok: false,
      error: `Duplicate confirmation field ID: ${duplicateField}`,
    };
  }
  // Older cards express their two rendered buttons through confirmLabel and
  // cancelLabel rather than an explicit actions array. Treat those exact two
  // IDs as part of the rendered schema; every additional action must still be
  // declared explicitly.
  const actions = action.actions?.length
    ? action.actions
    : [
        { id: "confirm", label: action.confirmLabel, approved: true },
        { id: "cancel", label: action.cancelLabel, approved: false },
      ];
  const duplicateAction = duplicate(actions.map((entry) => entry.id));
  if (duplicateAction) {
    return {
      ok: false,
      error: `Duplicate confirmation action ID: ${duplicateAction}`,
    };
  }
  for (const field of action.fields) {
    const duplicateOption = duplicate(fieldOptionIds(field));
    if (duplicateOption) {
      return {
        ok: false,
        error: `Duplicate option ID ${duplicateOption} in field ${field.id}`,
      };
    }
  }

  const declaredActionIds = new Set(actions.map((entry) => entry.id));
  if (action.defaultActionId) declaredActionIds.add(action.defaultActionId);
  if (action.cancelActionId) declaredActionIds.add(action.cancelActionId);
  const actionId =
    resolution.actionId ||
    (resolution.approved
      ? action.defaultActionId ||
        (action.actions?.length ? undefined : "confirm")
      : action.cancelActionId ||
        (action.actions?.length ? undefined : "cancel"));
  if (resolution.actionId && !declaredActionIds.has(resolution.actionId)) {
    return {
      ok: false,
      error: `Unknown confirmation action ID: ${resolution.actionId}`,
    };
  }
  if (actionId && declaredActionIds.size && !declaredActionIds.has(actionId)) {
    return { ok: false, error: `Unknown confirmation action ID: ${actionId}` };
  }

  const data =
    resolution.data &&
    typeof resolution.data === "object" &&
    !Array.isArray(resolution.data)
      ? ({ ...(resolution.data as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {};
  if (actionId) data.confirmationActionId = actionId;
  const fieldIds = new Set(action.fields.map((field) => field.id));
  for (const key of Object.keys(data)) {
    // Action-command plumbing uses this reserved field to carry the button.
    if (key !== "confirmationActionId" && !fieldIds.has(key)) {
      return { ok: false, error: `Unknown confirmation field ID: ${key}` };
    }
  }

  for (const field of action.fields) {
    const visible =
      !field.visibleForActionIds?.length ||
      (Boolean(actionId) && field.visibleForActionIds.includes(actionId!));
    if (!visible) continue;
    const supplied = data[field.id];
    const value =
      supplied === undefined && "value" in field ? field.value : supplied;
    const required =
      field.requiredForActionIds?.includes(actionId || "") === true;
    if (required && !isPresent(value)) {
      return {
        ok: false,
        error: `Missing required confirmation field: ${field.id}`,
      };
    }
    if (field.type === "select" && value !== undefined) {
      if (
        typeof value !== "string" ||
        !field.options.some((option) => option.id === value)
      ) {
        return {
          ok: false,
          error: `Invalid option for confirmation field ${field.id}`,
        };
      }
    }
    if (field.type === "choice" && value !== undefined) {
      const error = validateChoiceValue(field, value);
      if (error) return { ok: false, error };
    }
    if (supplied === undefined && value !== undefined) data[field.id] = value;
  }
  return { ok: true, actionId, data };
}
