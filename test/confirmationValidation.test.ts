import { assert } from "chai";
import { validateConfirmationResolution } from "../src/agent/tools/confirmationValidation";
import type { AgentPendingAction } from "../src/agent/types";

function action(
  overrides: Partial<AgentPendingAction> = {},
): AgentPendingAction {
  return {
    toolName: "request_user_input",
    title: "Choose",
    confirmLabel: "Continue",
    cancelLabel: "Cancel",
    fields: [
      {
        type: "select",
        id: "scope",
        label: "Scope",
        options: [
          { id: "library", label: "Library" },
          { id: "items", label: "Items" },
        ],
        requiredForActionIds: ["continue"],
      },
    ],
    actions: [
      { id: "continue", label: "Continue", approved: true },
      { id: "cancel", label: "Cancel", approved: false },
    ],
    defaultActionId: "continue",
    cancelActionId: "cancel",
    ...overrides,
  };
}

describe("confirmation resolution validation", function () {
  it("accepts only values declared by the rendered select field", function () {
    assert.isTrue(
      validateConfirmationResolution(action(), {
        approved: true,
        data: { scope: "items" },
      }).ok,
    );
    const invalid = validateConfirmationResolution(action(), {
      approved: true,
      data: { scope: "arbitrary-model-value" },
    });
    assert.isFalse(invalid.ok);
    if (!invalid.ok) assert.match(invalid.error, /Invalid option/);
  });

  it("rejects missing required answers and stale or unknown IDs", function () {
    const missing = validateConfirmationResolution(action(), {
      approved: true,
      data: {},
    });
    assert.isFalse(missing.ok);
    if (!missing.ok) assert.match(missing.error, /Missing required/);

    const unknownAction = validateConfirmationResolution(action(), {
      approved: true,
      actionId: "stale-action",
      data: { scope: "items" },
    });
    assert.isFalse(unknownAction.ok);
    if (!unknownAction.ok) assert.match(unknownAction.error, /Unknown.*action/);

    const unexpectedAction = validateConfirmationResolution(
      action({
        actions: undefined,
        defaultActionId: undefined,
        cancelActionId: undefined,
      }),
      {
        approved: true,
        actionId: "not-rendered",
        data: { scope: "items" },
      },
    );
    assert.isFalse(unexpectedAction.ok);
    if (!unexpectedAction.ok) {
      assert.match(unexpectedAction.error, /Unknown.*action/);
    }

    assert.isTrue(
      validateConfirmationResolution(
        action({
          actions: undefined,
          defaultActionId: undefined,
          cancelActionId: undefined,
        }),
        {
          approved: true,
          actionId: "confirm",
          data: { scope: "items" },
        },
      ).ok,
    );

    const unknownField = validateConfirmationResolution(action(), {
      approved: true,
      data: { scope: "items", staleField: "old" },
    });
    assert.isFalse(unknownField.ok);
    if (!unknownField.ok) assert.match(unknownField.error, /Unknown.*field/);
  });

  it("fails closed when the rendered schema contains duplicate IDs", function () {
    const duplicateFields = validateConfirmationResolution(
      action({
        fields: [
          { type: "text", id: "same", label: "First" },
          { type: "text", id: "same", label: "Second" },
        ],
      }),
      { approved: true },
    );
    assert.isFalse(duplicateFields.ok);
    if (!duplicateFields.ok)
      assert.match(duplicateFields.error, /Duplicate.*field/);

    const duplicateActions = validateConfirmationResolution(
      action({
        fields: [],
        actions: [
          { id: "same", label: "First" },
          { id: "same", label: "Second" },
        ],
      }),
      { approved: true, actionId: "same" },
    );
    assert.isFalse(duplicateActions.ok);
    if (!duplicateActions.ok)
      assert.match(duplicateActions.error, /Duplicate.*action/);

    const duplicateOptions = validateConfirmationResolution(
      action({
        fields: [
          {
            type: "select",
            id: "scope",
            label: "Scope",
            options: [
              { id: "same", label: "First" },
              { id: "same", label: "Second" },
            ],
          },
        ],
      }),
      { approved: true, data: { scope: "same" } },
    );
    assert.isFalse(duplicateOptions.ok);
    if (!duplicateOptions.ok)
      assert.match(duplicateOptions.error, /Duplicate option/);
  });

  it("validates tagged option and custom planning answers", function () {
    const planningAction: AgentPendingAction = {
      toolName: "request_user_input",
      mode: "review",
      title: "Plan needs your input",
      confirmLabel: "Continue planning",
      cancelLabel: "Cancel plan",
      fields: [
        {
          type: "choice",
          id: "scope",
          label: "Which corpus?",
          allowCustom: true,
          requiredForActionIds: ["continue"],
          options: [
            { id: "collection", label: "Collection" },
            { id: "library", label: "Library" },
          ],
        },
      ],
      actions: [
        { id: "continue", label: "Continue planning", approved: true },
        { id: "cancel", label: "Cancel plan", approved: false },
      ],
      defaultActionId: "continue",
      cancelActionId: "cancel",
    };

    assert.isTrue(
      validateConfirmationResolution(planningAction, {
        approved: true,
        actionId: "continue",
        data: { scope: { kind: "option", optionId: "library" } },
      }).ok,
    );
    assert.isTrue(
      validateConfirmationResolution(planningAction, {
        approved: true,
        actionId: "continue",
        data: { scope: { kind: "custom", text: "My reading list" } },
      }).ok,
    );

    for (const value of [
      { kind: "option", optionId: "undeclared" },
      { kind: "custom", text: "   " },
      { kind: "custom", text: "Valid", injected: true },
      "library",
    ]) {
      assert.isFalse(
        validateConfirmationResolution(planningAction, {
          approved: true,
          actionId: "continue",
          data: { scope: value },
        }).ok,
      );
    }
  });
});
