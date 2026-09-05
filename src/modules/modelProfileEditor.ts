/**
 * Model parameter controls, rendered inline in a provider card's advanced row.
 *
 * The customization surface exists so a new model — or a new reasoning effort
 * a provider ships tomorrow — works without waiting for a plugin release: the
 * user edits the reasoning-level list and, when needed, the raw JSON escape
 * hatch. Temperature, max tokens, input cap, input mode and the protocol
 * override stay where they already were in the advanced row and are
 * deliberately *not* duplicated here. Feature switches (tools, streaming,
 * vision) are the plugin's job to detect, never the user's to declare, so
 * they have no controls at all.
 *
 * **Reasoning levels are a list the user builds**, not a fixed ladder of
 * checkboxes. When nothing has been customized the list is seeded from the
 * detected profile — so the rows start out matching what the model actually
 * offers, complete with real parameters — and the user then edits, deletes or
 * adds rows. Deleting every row is itself a statement: it stores an explicit
 * "no reasoning" so the menu disappears, rather than silently reverting.
 *
 * **An override belongs to the model it was written for.** The stored value
 * carries `forModel`; pointing the entry at a different model leaves the
 * override dormant instead of deleting it, and renaming back restores it.
 *
 * **Absent stays distinguishable from empty.** `pruneProfileOverride` drops
 * empty sections so nothing is stored as `{}`, which is what makes Reset
 * indistinguishable from never having edited.
 */

import {
  isValidReasoningLevelId,
  parseJsonObjectField,
  parseKeyValueField,
  profileOverrideAppliesTo,
  pruneProfileOverride,
  stringifyJsonObjectField,
  stringifyKeyValueField,
  type ModelProfileOverride,
  type ResolvedModelCapabilities,
} from "../modelCapabilities";
import { el, iconBtn } from "../utils/domHelpers";
import { getGeminiReasoningProfileForModel } from "../utils/reasoningProfiles";

/**
 * Suggestions only — the level id is free text.
 *
 * Providers introduce new effort values (`ultra` and whatever follows), and a
 * fixed dropdown would make the plugin the bottleneck for adopting them. These
 * populate a datalist so the common levels stay one keystroke away without
 * being the only choices.
 */
export const SUGGESTED_REASONING_LEVEL_IDS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "default",
] as const;

/** Unique-per-editor datalist ids; a timestamp collides within one render pass. */
let editorSequence = 0;

export type ModelProfileEditorHandle = {
  element: HTMLElement;
  /** Re-read the detected profile and repaint. */
  refresh: (capabilities: ResolvedModelCapabilities) => void;
};

type EditorDeps = {
  doc: Document;
  getOverride: () => ModelProfileOverride | undefined;
  /** Persist a new override; `undefined` clears it entirely. */
  onChange: (next: ModelProfileOverride | undefined) => void;
  /** The profile as detected, used to seed the level list and for Reset. */
  getDetected: () => ResolvedModelCapabilities;
  /** The model this entry currently points at; overrides are keyed to it. */
  getModelName: () => string;
  t: (text: string) => string;
  styles: {
    input: string;
    inputSm: string;
    helper: string;
    sectionLabel: string;
    outlineBtn: string;
  };
};

type ReasoningRow = {
  wrap: HTMLElement;
  id: HTMLInputElement;
  /** Read-only display of the parameter this level sends. */
  sent: HTMLElement;
  warning: HTMLElement;
};

type ComparableOption = {
  id: string;
  controls?: { body?: Record<string, unknown> };
};

/** Order-sensitive comparison of id + request body; labels are cosmetic. */
function sameOptionSet(
  left: readonly ComparableOption[],
  right: readonly ComparableOption[],
): boolean {
  if (left.length !== right.length) return false;
  const shape = (options: readonly ComparableOption[]) =>
    JSON.stringify(
      options.map((option) => [option.id, option.controls?.body || {}]),
    );
  return shape(left) === shape(right);
}

export type EditorRowState = { id: string };

export type ProfileOverrideDraft = {
  override: ModelProfileOverride | undefined;
  /** One entry per input row; null when the row is fine. */
  rowWarnings: Array<string | null>;
  extraError: string | null;
};

/**
 * The parameter key this model's levels are sent with, read from whatever the
 * detected profile sends: Ollama's options carry `think`, so that is the key.
 *
 * A profile that declares nothing falls back to its protocol's own shape, and
 * the shapes are not interchangeable — a flat `reasoning_effort` is silently
 * ignored by Gemini and by Ollama, so a level sent that way looks selected
 * while doing nothing. `ollama_native` needs its own entry rather than relying
 * on the declared-body loop above: a server that reports no capabilities
 * resolves to a profile with no options at all, and there is then no declared
 * `think` to read.
 *
 * Anthropic is deliberately absent. Its thinking block also needs a `type` and
 * a budget clamped against `max_tokens`, and `omitTemperature` alongside — none
 * of which survives the override store today — so a derived key there would
 * only trade one rejected request for another.
 */
export function resolveReasoningParameterKey(
  detected: ResolvedModelCapabilities,
): string {
  for (const option of detected.reasoning.options) {
    const key = Object.keys(option.controls?.body || {})[0];
    if (key) return key;
  }
  switch (detected.identity.protocol) {
    case "responses_api":
    case "codex_responses":
      return "reasoning.effort";
    case "ollama_native":
      return "think";
    case "gemini_native":
      // 2.5 thinks in token budgets, 3.x in level words; the family decides,
      // and the wrong one of the two is a 400.
      return getGeminiReasoningProfileForModel(detected.model).param ===
        "thinking_budget"
        ? "thinkingConfig.thinkingBudget"
        : "thinkingConfig.thinkingLevel";
    default:
      return "reasoning_effort";
  }
}

/**
 * The level IS the only thing the user provides: typing `ultra` means
 * `reasoning_effort=ultra` (or `think=ultra` on Ollama, `reasoning.effort`
 * on the Responses API, `thinkingConfig.thinkingLevel` on Gemini) — the plugin
 * owns the encoding, the user owns the vocabulary, and the model is the judge
 * of what is valid (the Test button tries every custom level and shows what
 * the server said).
 */
export function deriveLevelParameters(
  detected: ResolvedModelCapabilities,
  id: string,
): string {
  return `${resolveReasoningParameterKey(detected)}=${id.trim() || "high"}`;
}

/**
 * The editor's whole decision, as a pure function of its inputs — what gets
 * stored, and which rows deserve a warning. The DOM layer only collects field
 * values and paints the result, so this is where the behavior is tested.
 */
export function computeProfileOverrideDraft(input: {
  rows: EditorRowState[];
  extraJson: string;
  detected: ResolvedModelCapabilities;
  modelName: string;
  t?: (text: string) => string;
}): ProfileOverrideDraft {
  const t = input.t || ((text: string) => text);
  const detectedOptions = input.detected.reasoning.options;
  const detectedLabelFor = (id: string) =>
    detectedOptions.find((option) => option.id === id)?.label || "";

  // Whether this profile declares its request bodies (Ollama's think options
  // do; hosted profiles rely on the per-protocol legacy encoders instead).
  // Declarative profile: any level without a declared body derives one from
  // its name. Legacy profile: the suggested ids already have correct
  // per-protocol encodings built in, so only ids outside that set derive.
  const declarative = detectedOptions.some(
    (option) => Object.keys(option.controls?.body || {}).length > 0,
  );
  const hasBuiltinEncoding = (id: string) =>
    declarative
      ? Object.keys(
          detectedOptions.find((option) => option.id === id)?.controls?.body ||
            {},
        ).length > 0
      : SUGGESTED_REASONING_LEVEL_IDS.includes(
          id as (typeof SUGGESTED_REASONING_LEVEL_IDS)[number],
        );

  const options: NonNullable<ModelProfileOverride["reasoning"]>["options"] = [];
  const rowWarnings: Array<string | null> = [];
  const seenIds = new Set<string>();
  for (const row of input.rows) {
    const id = row.id.trim().toLowerCase();
    if (!id) {
      rowWarnings.push(null);
      continue;
    }
    if (!isValidReasoningLevelId(id)) {
      // Anything outside this shape is dropped by the pref-store validator,
      // so the level would work once and be forgotten on restart.
      rowWarnings.push(
        t("Use letters, digits, - or _ so the level is remembered"),
      );
      continue;
    }
    if (seenIds.has(id)) {
      rowWarnings.push(t("Duplicate level — ignored"));
      continue;
    }
    rowWarnings.push(null);
    // A detected level keeps the exact body the model declared (Ollama's
    // minimal→think=false, default→think=true; registry entries likewise);
    // a suggested id on a legacy profile keeps its per-protocol built-in
    // encoding; anything else derives its body from its own name — the user
    // provides only the id, the plugin does the encoding, and the model
    // judges validity.
    const body = hasBuiltinEncoding(id)
      ? detectedOptions.find((option) => option.id === id)?.controls?.body
      : parseKeyValueField(deriveLevelParameters(input.detected, id)).value;
    seenIds.add(id);
    options.push({
      id,
      // Carry the detected label rather than echoing the id. The menu keys
      // its off/on styling off this string — `isReasoningDisplayLabelActive`
      // treats "off" and "disabled" as inactive — so relabelling Ollama's
      // `minimal` to "minimal" would make the button read as *on* while
      // thinking was off.
      label: detectedLabelFor(id) || id,
      enabled: true,
      ...(body && Object.keys(body).length ? { controls: { body } } : {}),
    });
  }

  const extra = parseJsonObjectField(input.extraJson);

  // Rows that still match what the model reports are not a customization.
  // Storing them anyway would mark the entry "customized" for doing nothing,
  // and would freeze it against future registry updates for that model.
  const reasoningChanged = !sameOptionSet(options, detectedOptions);

  // No rows left while the model offers levels is an explicit statement —
  // "give this model no reasoning menu" — not an accident to undo.
  const reasoning = options.length
    ? reasoningChanged
      ? { reasoning: { kind: "select" as const, options } }
      : {}
    : detectedOptions.length
      ? { reasoning: { kind: "none" as const, options: [] } }
      : {};

  return {
    override: pruneProfileOverride({
      forModel: input.modelName,
      ...reasoning,
      ...(extra.value && Object.keys(extra.value).length
        ? { extraBody: extra.value }
        : {}),
    }),
    rowWarnings,
    extraError: extra.error ? `${t("Invalid JSON: ")}${extra.error}` : null,
  };
}

export function createModelProfileEditor(
  deps: EditorDeps,
): ModelProfileEditorHandle {
  const { doc, t, styles } = deps;
  const root = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 10px; margin-top: 2px;",
  );

  let detected = deps.getDetected();
  let suspendCommit = false;

  /** The stored override, but only when it belongs to the current model. */
  function applicableOverride(): ModelProfileOverride | undefined {
    const stored = deps.getOverride();
    return stored && profileOverrideAppliesTo(stored, deps.getModelName())
      ? stored
      : undefined;
  }

  /**
   * What this level sends — shown read-only beside the id, so the user sees
   * the parameter without ever owning it. Detected levels show their declared
   * body (think=false); everything else shows its derivation.
   */
  function sentParameterTextFor(id: string): string {
    const trimmed = id.trim().toLowerCase();
    const detectedBody = detected.reasoning.options.find(
      (option) => option.id === trimmed,
    )?.controls?.body;
    if (detectedBody && Object.keys(detectedBody).length) {
      return stringifyKeyValueField(detectedBody);
    }
    return deriveLevelParameters(detected, trimmed);
  }

  const sectionLabel = (title: string) =>
    el(doc, "div", styles.sectionLabel, t(title));

  const hint = (text: string) => el(doc, "span", styles.helper, t(text));

  // ── Reasoning levels ──────────────────────────────────────────────────────
  const reasoningWrap = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 6px;",
  );
  const reasoningHeader = el(
    doc,
    "div",
    "display: flex; align-items: center; gap: 8px;",
  );
  const addLevelBtn = el(
    doc,
    "button",
    styles.outlineBtn,
    t("+ Add level"),
  ) as HTMLButtonElement;
  addLevelBtn.type = "button";
  reasoningHeader.append(sectionLabel("Reasoning levels"), addLevelBtn);
  const reasoningList = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 4px;",
  );
  // A datalist rather than a dropdown: the common levels stay one keystroke
  // away, but a provider's newly-introduced level (ultra, and whatever comes
  // next) can be typed in without waiting for a plugin release.
  const levelSuggestionsId = `llm-reasoning-levels-${++editorSequence}`;
  const levelSuggestions = el(doc, "datalist");
  levelSuggestions.id = levelSuggestionsId;
  for (const levelId of SUGGESTED_REASONING_LEVEL_IDS) {
    const option = el(doc, "option") as HTMLOptionElement;
    option.value = levelId;
    levelSuggestions.appendChild(option);
  }

  reasoningWrap.append(
    reasoningHeader,
    hint(
      "Future-proofing: when a provider ships a new reasoning level, add it " +
        "here yourself — no plugin update needed. Type only the level name " +
        "— ultra, off, anything — and the plugin sends it in the provider's " +
        "own parameter, shown next to the level. The model decides what is " +
        "valid: use Test to try every custom level. Deleting every level " +
        "hides the reasoning menu.",
    ),
    levelSuggestions,
    reasoningList,
  );

  let reasoningRows: ReasoningRow[] = [];

  function addReasoningRow(seed?: { id: string }) {
    const wrap = el(
      doc,
      "div",
      "display: flex; gap: 6px; align-items: center; flex-wrap: wrap;",
    );
    const idInput = el(doc, "input", styles.inputSm) as HTMLInputElement;
    idInput.type = "text";
    idInput.style.width = "104px";
    idInput.setAttribute("list", levelSuggestionsId);
    idInput.placeholder = t("level");
    idInput.value = seed?.id || firstUnusedLevelId();

    // Read-only: the id is the whole input; this just shows what it becomes
    // on the wire, and follows the id as it is typed.
    const sent = el(
      doc,
      "span",
      styles.helper + " font-family: monospace;",
      `→ ${sentParameterTextFor(idInput.value)}`,
    );

    idInput.addEventListener("input", () => {
      sent.textContent = `→ ${sentParameterTextFor(idInput.value)}`;
      commit();
    });

    const removeBtn = iconBtn(doc, "×", t("Delete level"));
    removeBtn.style.fontSize = "15px";

    const warning = el(doc, "span", styles.helper + " color: #b45309;");
    warning.style.display = "none";

    const row: ReasoningRow = { wrap, id: idInput, sent, warning };
    removeBtn.addEventListener("click", () => {
      reasoningRows = reasoningRows.filter((entry) => entry !== row);
      wrap.remove();
      commit();
    });

    wrap.append(idInput, sent, removeBtn, warning);
    reasoningList.append(wrap);
    reasoningRows.push(row);
    return row;
  }

  /** Prefer a suggested slot the user has not taken yet when adding a level. */
  function firstUnusedLevelId(): string {
    const used = new Set(reasoningRows.map((row) => row.id.value.trim()));
    return (
      SUGGESTED_REASONING_LEVEL_IDS.find((levelId) => !used.has(levelId)) || ""
    );
  }

  addLevelBtn.addEventListener("click", () => {
    addReasoningRow();
    commit();
  });

  // ── Extra request parameters ──────────────────────────────────────────────
  const extraWrap = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 4px;",
  );
  const extraInput = el(
    doc,
    "textarea",
    styles.input +
      " min-height: 54px; font-family: monospace; font-size: 12px; resize: vertical;",
  ) as HTMLTextAreaElement;
  extraInput.addEventListener("input", commit);
  const extraError = el(doc, "span", styles.helper + " color: #b45309;");
  extraError.style.display = "none";
  extraWrap.append(
    sectionLabel("Extra request parameters"),
    hint(
      "A JSON object merged into every request to this model, " +
        'for example {"top_k": 40, "options": {"repeat_penalty": 1.1}}.',
    ),
    extraInput,
    extraError,
  );

  // ── Reset ─────────────────────────────────────────────────────────────────
  const resetRow = el(
    doc,
    "div",
    "display: flex; gap: 8px; align-items: center;",
  );
  const resetBtn = el(
    doc,
    "button",
    styles.outlineBtn,
    t("Reset to detected"),
  ) as HTMLButtonElement;
  resetBtn.type = "button";
  resetBtn.title = t("Discard changes and return to the detected profile");
  // Always clickable: mid-edit state (a half-typed level, invalid JSON that
  // never committed) is exactly what a user wants to bail out of, and none of
  // that is visible in the stored override the badge reflects.
  resetBtn.addEventListener("click", () => {
    deps.onChange(undefined);
    render();
  });
  // Without this the panel gives no clue whether the rows are what the model
  // reports or what a previous edit left behind — which is exactly how a stale
  // override reads as the truth.
  const customizedBadge = el(
    doc,
    "span",
    "font-size: 10.5px; color: var(--color-accent, #2563eb); font-weight: 600;",
    t("customized for this model"),
  );
  resetRow.append(resetBtn, customizedBadge);

  root.append(reasoningWrap, extraWrap, resetRow);

  function commit() {
    if (suspendCommit) return;
    const draft = computeProfileOverrideDraft({
      rows: reasoningRows.map((row) => ({ id: row.id.value })),
      extraJson: extraInput.value,
      detected,
      modelName: deps.getModelName(),
      t,
    });
    reasoningRows.forEach((row, index) => {
      const warning = draft.rowWarnings[index];
      row.warning.style.display = warning ? "" : "none";
      row.warning.textContent = warning || "";
    });
    if (draft.extraError) {
      extraError.style.display = "";
      extraError.textContent = draft.extraError;
    } else {
      extraError.style.display = "none";
      extraError.textContent = "";
    }
    deps.onChange(draft.override);
  }

  /**
   * Repaint from the stored override, seeding the level list from the detected
   * profile when nothing has been customized yet.
   */
  function render() {
    suspendCommit = true;
    const override = applicableOverride();

    for (const row of reasoningRows) row.wrap.remove();
    reasoningRows = [];
    const seedSource =
      override?.reasoning?.kind === "none"
        ? []
        : override?.reasoning?.options?.length
          ? override.reasoning.options
          : detected.reasoning.options;
    for (const option of seedSource) {
      addReasoningRow({ id: option.id });
    }

    extraInput.value = override?.extraBody
      ? stringifyJsonObjectField(override.extraBody)
      : "";
    extraInput.placeholder = '{"top_k": 40}';
    extraError.style.display = "none";

    customizedBadge.style.display = override ? "" : "none";

    suspendCommit = false;
  }

  render();

  return {
    element: root,
    refresh: (capabilities: ResolvedModelCapabilities) => {
      detected = capabilities;
      render();
    },
  };
}
