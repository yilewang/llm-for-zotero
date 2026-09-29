import { HTML_NS, el } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import type { EmbeddingCapabilityTestOutcome } from "../../utils/embedding/detection";
import { getEmbeddingFormatAdapter } from "../../utils/embedding/formats";
import {
  EMBEDDING_BATCH_PREF_KEYS,
  EMBEDDING_PREF_KEYS,
  RETRIEVAL_DEFAULTS,
  RETRIEVAL_PREF_KEYS,
  RETRIEVAL_RANGES,
  type EmbeddingImagesPref,
  type MultimodalEmbeddingSettings,
  type RetrievalSettings,
} from "../../utils/embedding/settings";
import {
  EMBEDDING_REQUEST_FORMATS,
  type EmbeddingRequestFormat,
} from "../../utils/embedding/types";

const FORMAT_LABELS: Record<EmbeddingRequestFormat, string> = {
  openai_compat: "OpenAI-compatible (SiliconFlow, etc.)",
  dashscope: "Alibaba Cloud DashScope (native)",
  vllm_messages: "vLLM (messages)",
};

const FORMAT_URL_EXAMPLES: Record<EmbeddingRequestFormat, string> = {
  openai_compat: "https://api.siliconflow.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/api/v1",
  vllm_messages: "http://localhost:8000/v1",
};

const HINT_STYLE = "font-size: 11px; color: var(--fill-secondary, #888);";
const LINK_STYLE =
  "font-size: 11px; background: none; border: none; padding: 0;" +
  " color: var(--color-accent, #2563eb); cursor: pointer;";

export type EmbeddingMultimodalSectionDeps = {
  readPref: (key: string) => string;
  writePref: (key: string, value: string) => void;
  /** Re-resolved from the current prefs on every render. */
  getSettings: () => MultimodalEmbeddingSettings;
  /** Image support or format changed: drop failure flags and cached scores. */
  onEffectiveChange: () => void;
  styles: { label: string; input: string; helper: string };
};

export type EmbeddingMultimodalSection = {
  element: HTMLDivElement;
  refresh: () => void;
};

function describeImageSource(settings: MultimodalEmbeddingSettings): string {
  switch (settings.imageSource) {
    case "declared":
      return settings.imagesEnabled
        ? t("(Auto: the API declares image support)")
        : t("(Auto: the API declares no image support)");
    case "probe":
      return settings.imagesEnabled
        ? t("(Auto: Test confirmed image input works)")
        : t("(Auto: Test showed image input is rejected)");
    default:
      return t("(Auto: not detected yet — click Test)");
  }
}

export function createEmbeddingMultimodalSection(
  doc: Document,
  deps: EmbeddingMultimodalSectionDeps,
): EmbeddingMultimodalSection {
  const element = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 10px;",
  );
  let advancedOpen = false;
  let retrievalOpen = false;

  // Defer so Gecko finishes the change event before the control is removed.
  const scheduleRender = () => {
    doc.defaultView?.setTimeout(() => render(), 0);
  };

  const linkButton = (label: string, onClick: () => void) => {
    const button = el(doc, "button", LINK_STYLE, label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  };

  const renderImageRow = (settings: MultimodalEmbeddingSettings) => {
    const row = el(
      doc,
      "div",
      "display: flex; align-items: center; flex-wrap: wrap; gap: 6px;",
    );
    const checkbox = el(doc, "input");
    checkbox.type = "checkbox";
    checkbox.id = "llmforzotero-embedding-supports-images";
    checkbox.checked = settings.imagesEnabled;
    checkbox.addEventListener("change", () => {
      deps.writePref(
        EMBEDDING_PREF_KEYS.supportsImages,
        checkbox.checked ? "on" : "off",
      );
      deps.onEffectiveChange();
      scheduleRender();
    });
    const label = el(
      doc,
      "label",
      "font-size: 13px; cursor: pointer;",
      t("Supports image input"),
    );
    label.setAttribute("for", checkbox.id);
    row.append(checkbox, label);
    if (settings.imageSource === "manual") {
      row.appendChild(
        linkButton(t("Restore auto"), () => {
          deps.writePref(EMBEDDING_PREF_KEYS.supportsImages, "");
          deps.onEffectiveChange();
          scheduleRender();
        }),
      );
    } else {
      row.appendChild(
        el(doc, "span", HINT_STYLE, describeImageSource(settings)),
      );
    }
    return row;
  };

  const renderFormatRow = (settings: MultimodalEmbeddingSettings) => {
    const wrap = el(doc, "div", "display: flex; flex-direction: column;");
    wrap.appendChild(el(doc, "label", deps.styles.label, t("Request format")));
    const select = el(doc, "select", deps.styles.input);
    const addOption = (value: string, text: string) => {
      const option = el(doc, "option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    };
    addOption(
      "",
      t("Auto ({format})").replace(
        "{format}",
        t(FORMAT_LABELS[settings.autoFormat]),
      ),
    );
    for (const format of EMBEDDING_REQUEST_FORMATS) {
      addOption(format, t(FORMAT_LABELS[format]));
    }
    select.value = settings.formatPref;
    select.addEventListener("change", () => {
      deps.writePref(EMBEDDING_PREF_KEYS.requestFormat, select.value);
      for (const key of EMBEDDING_BATCH_PREF_KEYS) deps.writePref(key, "");
      deps.onEffectiveChange();
      scheduleRender();
    });
    wrap.appendChild(select);
    wrap.appendChild(
      el(
        doc,
        "span",
        deps.styles.helper,
        t("API URL example: {url}").replace(
          "{url}",
          FORMAT_URL_EXAMPLES[settings.candidateFormat],
        ),
      ),
    );
    return wrap;
  };

  const numberField = (
    key: string,
    labelText: string,
    defaultValue: number,
    cappedAt?: number,
    options: { min?: number; max?: number; helper?: string } = {},
  ) => {
    const wrap = el(doc, "div", "display: flex; flex-direction: column;");
    wrap.appendChild(el(doc, "label", deps.styles.label, labelText));
    const input = el(doc, "input", deps.styles.input);
    input.type = "text";
    input.inputMode = "numeric";
    // Empty field: the grey placeholder is the default in force.
    input.placeholder = String(defaultValue);
    input.value = deps.readPref(key);
    input.addEventListener("change", () => {
      const value = input.value.trim();
      const valid = /^\d+$/.test(value) && Number(value) >= (options.min ?? 1);
      // Over-range values are stored clamped so the field shows what applies.
      deps.writePref(
        key,
        valid ? String(Math.min(options.max ?? Infinity, Number(value))) : "",
      );
      scheduleRender();
    });
    wrap.appendChild(input);
    if (options.helper) {
      wrap.appendChild(el(doc, "span", deps.styles.helper, options.helper));
    }
    if (cappedAt !== undefined) {
      wrap.appendChild(
        el(
          doc,
          "span",
          deps.styles.helper,
          t("Capped at the endpoint limit of {limit}").replace(
            "{limit}",
            String(cappedAt),
          ),
        ),
      );
    }
    return wrap;
  };

  const renderAdvanced = (settings: MultimodalEmbeddingSettings) => {
    const details = el(doc, "details");
    details.open = advancedOpen;
    details.addEventListener("toggle", () => {
      advancedOpen = details.open;
    });
    details.appendChild(
      el(
        doc,
        "summary",
        "cursor: pointer; font-size: 12px; font-weight: 600;",
        t("Advanced (batching and concurrency)"),
      ),
    );
    const body = el(
      doc,
      "div",
      "display: flex; flex-direction: column; gap: 8px; margin-top: 8px;",
    );
    const defaults = getEmbeddingFormatAdapter(settings.format).defaults;
    if (settings.format !== "vllm_messages") {
      body.appendChild(
        numberField(
          EMBEDDING_PREF_KEYS.batchMaxItems,
          t("Max inputs per request"),
          defaults.maxItems,
          settings.cappedLimits.maxItems,
        ),
      );
      if (settings.imagesEnabled) {
        body.appendChild(
          numberField(
            EMBEDDING_PREF_KEYS.batchMaxImages,
            t("Max images per request"),
            defaults.maxImages,
            settings.cappedLimits.maxImages,
          ),
        );
      }
    }
    body.appendChild(
      numberField(
        EMBEDDING_PREF_KEYS.concurrency,
        t("Concurrent requests"),
        defaults.concurrency,
      ),
    );
    body.appendChild(
      linkButton(t("Restore defaults"), () => {
        for (const key of EMBEDDING_BATCH_PREF_KEYS) deps.writePref(key, "");
        scheduleRender();
      }),
    );
    details.appendChild(body);
    return details;
  };

  const retrievalField = (
    key: keyof RetrievalSettings,
    labelText: string,
    helper?: string,
  ) =>
    numberField(
      RETRIEVAL_PREF_KEYS[key],
      labelText,
      RETRIEVAL_DEFAULTS[key],
      undefined,
      { ...RETRIEVAL_RANGES[key], helper },
    );

  const renderRetrieval = (settings: MultimodalEmbeddingSettings) => {
    const details = el(doc, "details");
    details.open = retrievalOpen;
    details.addEventListener("toggle", () => {
      retrievalOpen = details.open;
    });
    details.appendChild(
      el(
        doc,
        "summary",
        "cursor: pointer; font-size: 12px; font-weight: 600;",
        t("Retrieval results"),
      ),
    );
    const body = el(
      doc,
      "div",
      "display: flex; flex-direction: column; gap: 8px; margin-top: 8px;",
    );
    body.appendChild(
      retrievalField("textTopK", t("Text chunks returned per paper")),
    );
    if (settings.imagesEnabled) {
      body.appendChild(
        retrievalField("imageTopK", t("Images returned per paper")),
      );
      body.appendChild(
        retrievalField(
          "imageOutstandingPercent",
          t(
            "Outstanding image threshold (% of the lowest hit-chunk similarity)",
          ),
          t(
            "An image whose similarity reaches this percentage of the lowest hit-chunk similarity is returned even without a page or figure-label match. 0 turns this off.",
          ),
        ),
      );
    }
    body.appendChild(
      linkButton(t("Restore defaults"), () => {
        for (const key of Object.values(RETRIEVAL_PREF_KEYS)) {
          deps.writePref(key, "");
        }
        scheduleRender();
      }),
    );
    details.appendChild(body);
    return details;
  };

  const render = () => {
    element.innerHTML = "";
    const settings = deps.getSettings();
    element.appendChild(renderImageRow(settings));
    if (settings.imagesPref !== "off") {
      element.appendChild(renderFormatRow(settings));
    }
    element.appendChild(renderAdvanced(settings));
    element.appendChild(renderRetrieval(settings));
  };

  render();
  return { element, refresh: render };
}

/** 128×128 bar chart: above Qwen3-VL's min_pixels, tiny as a payload. */
export function drawEmbeddingTestImage(doc: Document): string {
  const canvas = doc.createElementNS(HTML_NS, "canvas") as HTMLCanvasElement;
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 128, 128);
  const bars: Array<[string, number]> = [
    ["#2563eb", 70],
    ["#16a34a", 100],
    ["#f59e0b", 45],
    ["#dc2626", 85],
  ];
  bars.forEach(([color, height], index) => {
    ctx.fillStyle = color;
    ctx.fillRect(12 + index * 28, 118 - height, 20, height);
  });
  return canvas.toDataURL("image/png");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function describeCapabilityTestOutcome(
  outcome: EmbeddingCapabilityTestOutcome,
  imagesPref: EmbeddingImagesPref,
): { ok: boolean; text: string } {
  switch (outcome.kind) {
    case "both_ok":
      return {
        ok: true,
        text: t(
          "✓ Text and image embeddings both work (dimension {dimension})",
        ).replace("{dimension}", String(outcome.dimension)),
      };
    case "text_only_ok":
      return {
        ok: true,
        text: t("✓ Text works; the API declares no image input"),
      };
    case "dimension_mismatch":
      return {
        ok: false,
        text: t(
          "✗ Text and image vectors differ in dimension ({text} vs {image})",
        )
          .replace("{text}", String(outcome.textDimension))
          .replace("{image}", String(outcome.imageDimension)),
      };
    case "text_failed":
      return { ok: false, text: `✗ ${errorText(outcome.error)}` };
    case "image_unsupported":
      return imagesPref === "on"
        ? {
            ok: false,
            text: t(
              "✗ Image input failed (turn it off or use a VL model): {error}",
            ).replace("{error}", errorText(outcome.error)),
          }
        : {
            ok: true,
            text: t("✓ Text works; this model does not accept image input"),
          };
    case "image_unknown":
      return {
        ok: false,
        text: t(
          "✗ Image check failed; auto result not updated: {error}",
        ).replace("{error}", errorText(outcome.error)),
      };
  }
}
