import { appLogger } from "../../core/logging";
import type { GeneratedChatImage } from "../../shared/types";
import {
  isRenderableGeneratedImageSrc,
  normalizeGeneratedChatImages,
} from "../../shared/generatedImages";
import { HTML_NS } from "../../utils/domHelpers";
import { toFileUrl } from "../../utils/localPath";
import { revealLocalPath } from "../../utils/revealLocalPath";
import { copyTextToClipboard } from "./clipboard";
import { PDF_LOCATION_ATTRIBUTES } from "./pdfPageLinks";
import {
  isEmbeddableGeneratedImage,
  resolveGeneratedImageAsset,
  resolveGeneratedImageLocalPath,
  saveGeneratedImageAssetToPath,
} from "../../services/images/generatedImageAssets";

function openGeneratedImageFileUrl(fileUrl: string): boolean {
  try {
    const launch = (Zotero as any).launchURL as
      | ((url: string) => void)
      | undefined;
    if (typeof launch === "function") {
      launch(fileUrl);
      return true;
    }
  } catch (_err) {
    void _err;
  }
  try {
    const win = Zotero.getMainWindow?.() as
      | (Window & { open?: (url?: string, target?: string) => unknown })
      | null;
    if (win?.open) {
      win.open(fileUrl, "_blank");
      return true;
    }
  } catch (_err) {
    void _err;
  }
  return false;
}

function resolveGeneratedChatImageSrc(image: GeneratedChatImage): string {
  const fileUrl = toFileUrl(image.path);
  if (fileUrl) return fileUrl;
  return isRenderableGeneratedImageSrc(image.src) ? image.src.trim() : "";
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export async function copyGeneratedImageToClipboard(
  body: Element,
  image: GeneratedChatImage,
): Promise<"image" | "source"> {
  let asset: Awaited<ReturnType<typeof resolveGeneratedImageAsset>> = null;
  try {
    asset = await resolveGeneratedImageAsset(image);
  } catch (err) {
    appLogger.debug("LLM: Generated image read failed, falling back:", err);
  }
  const win = body.ownerDocument?.defaultView as
    | (Window & {
        navigator?: Navigator;
        ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem;
      })
    | undefined;
  if (asset?.bytes && win?.navigator?.clipboard?.write && win.ClipboardItem) {
    try {
      const blob = new Blob([bytesToArrayBuffer(asset.bytes)], {
        type: asset.mimeType,
      });
      const item = new win.ClipboardItem({ [asset.mimeType]: blob });
      await win.navigator.clipboard.write([item]);
      return "image";
    } catch (err) {
      appLogger.debug("LLM: Image clipboard write failed, falling back:", err);
    }
  }

  const source =
    asset?.fileUrl ||
    asset?.path ||
    toFileUrl(image.path) ||
    image.path ||
    (isRenderableGeneratedImageSrc(image.src) ? image.src.trim() : "");
  if (!source) {
    throw new Error("Generated image source is unavailable");
  }
  await copyTextToClipboard(body, source);
  return "source";
}

type GeneratedImageSavePathResult =
  | { status: "selected"; path: string }
  | { status: "cancelled" }
  | { status: "unavailable" };

type GeneratedImageFilePicker = {
  init?: (parent: unknown, title: string, mode: number) => void;
  appendFilter?: (title: string, filter: string) => void;
  appendFilters?: (filterMask: number) => void;
  open?: (callback: (result: number) => void) => void;
  show?: () => number | Promise<number>;
  defaultString?: string;
  defaultExtension?: string;
  file?: string | { path?: string };
  modeSave?: number;
  returnOK?: number;
  returnReplace?: number;
  filterAll?: number;
};

type GeneratedImageFilePickerConstructor = new () => GeneratedImageFilePicker;

function getGeneratedImagePickerParentWindow(doc: Document): Window | null {
  const mainWindow = Zotero.getMainWindow?.() as Window | null | undefined;
  const candidates = [mainWindow, doc.defaultView].filter(Boolean) as Window[];
  const withBrowsingContext = candidates.find((candidate) =>
    Boolean(
      (candidate as unknown as { browsingContext?: unknown }).browsingContext,
    ),
  );
  return withBrowsingContext || candidates[0] || null;
}

function getZoteroFilePickerConstructor(): GeneratedImageFilePickerConstructor | null {
  const ZoteroFilePicker = (Zotero as any).FilePicker as
    | GeneratedImageFilePickerConstructor
    | undefined;
  if (typeof ZoteroFilePicker === "function") return ZoteroFilePicker;

  const CU = (globalThis as any).ChromeUtils;
  if (CU?.importESModule) {
    try {
      const mod = CU.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs",
      ) as { FilePicker?: GeneratedImageFilePickerConstructor };
      if (typeof mod?.FilePicker === "function") return mod.FilePicker;
    } catch (err) {
      appLogger.debug("LLM: Zotero FilePicker module import failed", err);
    }
  }
  return null;
}

function getGeneratedImagePickerFilePath(
  picker: GeneratedImageFilePicker,
): string {
  const file = picker.file;
  if (typeof file === "string") return file.trim();
  return typeof file?.path === "string" ? file.path.trim() : "";
}

function configureGeneratedImageFilePicker(
  picker: GeneratedImageFilePicker,
  parent: unknown,
  fileName: string,
  constants: {
    modeSave?: number;
    filterAll?: number;
  },
): void {
  picker.init?.(
    parent,
    "Save generated image",
    picker.modeSave ?? constants.modeSave ?? 0,
  );
  const defaultName = fileName || "generated-image.png";
  try {
    picker.defaultString = defaultName;
  } catch (err) {
    appLogger.debug("LLM: Failed to set generated image default filename", err);
  }
  const extMatch = defaultName.match(/\.([A-Za-z0-9]+)$/);
  if (extMatch?.[1]) {
    try {
      picker.defaultExtension = extMatch[1];
    } catch (err) {
      appLogger.debug(
        "LLM: Failed to set generated image default extension",
        err,
      );
    }
  }
  try {
    picker.appendFilter?.("Images", "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.svg");
  } catch (err) {
    appLogger.debug("LLM: Failed to add generated image file filter", err);
  }
  const filterAll = picker.filterAll ?? constants.filterAll;
  if (typeof filterAll === "number") {
    try {
      picker.appendFilters?.(filterAll);
    } catch (err) {
      appLogger.debug(
        "LLM: Failed to add generated image all-files filter",
        err,
      );
    }
  }
}

async function resolveGeneratedImageFilePickerResult(
  picker: GeneratedImageFilePicker,
  constants: {
    returnOK?: number;
    returnReplace?: number;
  },
): Promise<GeneratedImageSavePathResult> {
  const result = await new Promise<number>((resolve, reject) => {
    try {
      if (typeof picker.open === "function") {
        picker.open((value: number) => resolve(value));
        return;
      }
      if (typeof picker.show === "function") {
        void Promise.resolve(picker.show()).then(resolve, reject);
        return;
      }
      resolve(-1);
    } catch (err) {
      reject(err);
    }
  });
  const returnOK = picker.returnOK ?? constants.returnOK;
  const returnReplace = picker.returnReplace ?? constants.returnReplace;
  const ok =
    result === returnOK ||
    result === returnReplace ||
    (typeof returnOK !== "number" &&
      typeof returnReplace !== "number" &&
      result === 0);
  if (!ok) return { status: "cancelled" };
  const path = getGeneratedImagePickerFilePath(picker);
  return path ? { status: "selected", path } : { status: "unavailable" };
}

async function pickGeneratedImageSavePath(
  doc: Document,
  fileName: string,
): Promise<GeneratedImageSavePathResult> {
  const parentWindow = getGeneratedImagePickerParentWindow(doc);
  const ZoteroFilePicker = getZoteroFilePickerConstructor();
  if (ZoteroFilePicker) {
    try {
      const picker = new ZoteroFilePicker();
      if (!parentWindow) {
        return { status: "unavailable" };
      }
      configureGeneratedImageFilePicker(picker, parentWindow, fileName, {});
      return await resolveGeneratedImageFilePickerResult(picker, {});
    } catch (err) {
      appLogger.warn("LLM: Zotero file picker failed", err);
    }
  }

  const components = (globalThis as any).Components;
  const Cc = components?.classes;
  const Ci = components?.interfaces;
  const filePickerFactory = Cc?.["@mozilla.org/filepicker;1"];
  const nsIFilePicker = Ci?.nsIFilePicker;
  if (!filePickerFactory?.createInstance || !nsIFilePicker) {
    return { status: "unavailable" };
  }

  try {
    const picker = filePickerFactory.createInstance(
      nsIFilePicker,
    ) as GeneratedImageFilePicker;
    const parentBrowsingContext = (
      parentWindow as unknown as { browsingContext?: unknown } | null
    )?.browsingContext;
    configureGeneratedImageFilePicker(
      picker,
      parentBrowsingContext || null,
      fileName,
      {
        modeSave: nsIFilePicker.modeSave,
        filterAll: nsIFilePicker.filterAll,
      },
    );
    return await resolveGeneratedImageFilePickerResult(picker, {
      returnOK: nsIFilePicker.returnOK,
      returnReplace: nsIFilePicker.returnReplace,
    });
  } catch (err) {
    appLogger.warn("LLM: XPCOM file picker failed", err);
    return { status: "unavailable" };
  }
}

export function renderAssistantGeneratedImagesInto(
  container: HTMLElement,
  images: GeneratedChatImage[] | undefined,
  doc: Document,
  options: {
    onImageLoaded?: () => void;
    onImageActionStatus?: (
      message: string,
      level: "ready" | "warning" | "error",
    ) => void;
    wrapClassName?: string;
    frameClassName?: string;
  } = {},
): boolean {
  const normalized = normalizeGeneratedChatImages(images);
  const renderable = normalized
    .map((image) => ({ image, src: resolveGeneratedChatImageSrc(image) }))
    .filter((entry) => Boolean(entry.src));
  if (!renderable.length) return false;

  const wrap = doc.createElement("div") as HTMLDivElement;
  wrap.className = [
    "llm-assistant-generated-images",
    options.wrapClassName || "",
  ]
    .filter(Boolean)
    .join(" ");
  for (const { image, src } of renderable) {
    const figure = doc.createElement("figure") as HTMLElement;
    figure.className = [
      "llm-assistant-generated-image-frame",
      options.frameClassName || "",
    ]
      .filter(Boolean)
      .join(" ");

    const img = doc.createElement("img") as HTMLImageElement;
    img.className = "llm-assistant-generated-image";
    img.src = src;
    img.alt = image.label || "Generated image";
    img.title = image.revisedPrompt || image.label || "";
    img.loading = "lazy";
    if (options.onImageLoaded) {
      img.addEventListener("load", options.onImageLoaded);
      img.addEventListener("error", options.onImageLoaded);
    }
    figure.appendChild(img);

    const report = (
      message: string,
      level: "ready" | "warning" | "error" = "ready",
    ) => {
      options.onImageActionStatus?.(message, level);
    };
    const createActionButton = (
      className: string,
      title: string,
      onClick: () => Promise<void> | void,
    ): HTMLButtonElement => {
      const button = doc.createElementNS(
        HTML_NS,
        "button",
      ) as HTMLButtonElement;
      button.className = `llm-generated-image-action ${className}`;
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        return Promise.resolve(onClick()).catch((error) => {
          appLogger.warn("LLM: Generated image action failed:", error);
          report(
            error instanceof Error
              ? error.message
              : "Generated image action failed",
            "error",
          );
        });
      });
      return button;
    };

    if (isEmbeddableGeneratedImage(image)) {
      const actions = doc.createElement("div") as HTMLDivElement;
      actions.className = "llm-assistant-generated-image-actions";
      actions.appendChild(
        createActionButton(
          "llm-generated-image-action-copy",
          "Copy image",
          async () => {
            const result = await copyGeneratedImageToClipboard(
              container,
              image,
            );
            report(result === "image" ? "Copied image" : "Copied image source");
          },
        ),
      );
      actions.appendChild(
        createActionButton(
          "llm-generated-image-action-save",
          "Save image as...",
          async () => {
            const asset = await resolveGeneratedImageAsset(image);
            if (!asset) {
              report("Generated image file is unavailable", "error");
              return;
            }
            const saveTarget = await pickGeneratedImageSavePath(
              doc,
              asset.fileName,
            );
            if (saveTarget.status === "cancelled") {
              report("Image save cancelled", "ready");
              return;
            }
            if (saveTarget.status === "unavailable") {
              report("Save dialog unavailable", "warning");
              return;
            }
            await saveGeneratedImageAssetToPath(asset, saveTarget.path);
            report("Saved image", "ready");
          },
        ),
      );
      const localPath = resolveGeneratedImageLocalPath(image);
      const fileUrl = toFileUrl(localPath);
      const openButton = createActionButton(
        "llm-generated-image-action-open",
        "Show image in folder",
        () => {
          if (localPath && revealLocalPath(localPath)) {
            report("Showed image in folder", "ready");
          } else if (fileUrl && openGeneratedImageFileUrl(fileUrl)) {
            report("Opened image", "ready");
          } else {
            report("Generated image file is unavailable", "error");
          }
        },
      );
      if (!localPath && !fileUrl) {
        openButton.disabled = true;
        openButton.title = "Show image in folder unavailable";
        openButton.setAttribute(
          "aria-label",
          "Show image in folder unavailable",
        );
      }
      actions.appendChild(openButton);
      figure.appendChild(actions);
    }

    if (image.label) {
      const caption = doc.createElement("figcaption") as HTMLElement;
      caption.className = "llm-assistant-generated-image-caption";
      caption.textContent = image.label;
      caption.title = image.label;
      if (image.pdfLocation) {
        // The chat's click handler opens the PDF at this page.
        caption.classList.add("llm-pdf-page-caption");
        caption.setAttribute(
          PDF_LOCATION_ATTRIBUTES.contextItemId,
          String(image.pdfLocation.contextItemId),
        );
        caption.setAttribute(
          PDF_LOCATION_ATTRIBUTES.pageIndex,
          String(image.pdfLocation.pageIndex),
        );
        caption.setAttribute("role", "link");
        caption.title = `${image.label} — open page ${image.pdfLocation.pageIndex + 1} in the PDF`;
      }
      figure.appendChild(caption);
    }

    wrap.appendChild(figure);
  }
  container.appendChild(wrap);
  return true;
}
