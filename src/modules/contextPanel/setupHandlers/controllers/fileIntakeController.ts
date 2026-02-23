import {
  MAX_SELECTED_IMAGES,
  MAX_UPLOAD_PDF_SIZE_BYTES,
} from "../../constants";
import type { ChatAttachment } from "../../types";

type StatusLevel = "ready" | "warning" | "error";

type FileIntakeControllerDeps = {
  body: Element;
  getItem: () => Zotero.Item | null;
  getCurrentModel: () => string;
  isScreenshotUnsupportedModel: (modelName: string) => boolean;
  optimizeImageDataUrl: (win: Window, dataUrl: string) => Promise<string>;
  persistAttachmentBlob: (
    fileName: string,
    bytes: Uint8Array,
  ) => Promise<{ storedPath: string; contentHash: string }>;
  selectedImageCache: Map<number, string[]>;
  selectedFileAttachmentCache: Map<number, ChatAttachment[]>;
  updateImagePreview: () => void;
  updateFilePreview: () => void;
  scheduleAttachmentGc: () => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
};

const createAttachmentId = () =>
  `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const isTextLikeFile = (file: File): boolean => {
  const lowerName = (file.name || "").toLowerCase();
  const mime = (file.type || "").toLowerCase();
  if (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("javascript") ||
    mime.includes("typescript")
  ) {
    return true;
  }
  return /\.(md|markdown|txt|json|ya?ml|xml|html?|css|scss|less|js|jsx|ts|tsx|py|java|c|cc|cpp|h|hpp|go|rs|rb|php|swift|kt|scala|sh|bash|zsh|sql|r|m|mm|lua|toml|ini|cfg|conf)$/i.test(
    lowerName,
  );
};

const resolveAttachmentCategory = (
  file: File,
): ChatAttachment["category"] => {
  const lowerName = (file.name || "").toLowerCase();
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf";
  if (/\.(md|markdown)$/i.test(lowerName)) return "markdown";
  if (
    /\.(js|jsx|ts|tsx|py|java|c|cc|cpp|h|hpp|go|rs|rb|php|swift|kt|scala|sh|bash|zsh|sql|r|m|mm|lua)$/i.test(
      lowerName,
    )
  ) {
    return "code";
  }
  if (isTextLikeFile(file)) return "text";
  return "file";
};

const readFileAsDataURL = async (
  owner: Element,
  file: File,
): Promise<string> => {
  const view = owner.ownerDocument?.defaultView;
  const FileReaderCtor = view?.FileReader || globalThis.FileReader;
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReaderCtor();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Invalid data URL result"));
    };
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsDataURL(file);
  });
};

const readFileAsText = async (owner: Element, file: File): Promise<string> => {
  const view = owner.ownerDocument?.defaultView;
  const FileReaderCtor = view?.FileReader || globalThis.FileReader;
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReaderCtor();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Invalid text result"));
    };
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsText(file);
  });
};

const readFileAsArrayBuffer = async (
  owner: Element,
  file: File,
): Promise<ArrayBuffer> => {
  const withArrayBuffer = file as File & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof withArrayBuffer.arrayBuffer === "function") {
    return await withArrayBuffer.arrayBuffer();
  }
  const view = owner.ownerDocument?.defaultView;
  const FileReaderCtor = view?.FileReader || globalThis.FileReader;
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReaderCtor();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("Invalid arrayBuffer result"));
    };
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsArrayBuffer(file);
  });
};

export function isFileDragEvent(event: DragEvent): boolean {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) return true;
  const types = Array.from(dataTransfer.types || []);
  return types.includes("Files");
}

export function extractFilesFromClipboard(event: ClipboardEvent): File[] {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return [];
  const files: File[] = [];
  if (clipboardData.files && clipboardData.files.length > 0) {
    files.push(...Array.from(clipboardData.files));
  }
  const items = Array.from(clipboardData.items || []);
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const duplicated = files.some(
      (existing) =>
        existing.name === file.name &&
        existing.size === file.size &&
        existing.type === file.type,
    );
    if (!duplicated) files.push(file);
  }
  return files;
}

export function createFileIntakeController(deps: FileIntakeControllerDeps): {
  processIncomingFiles: (incomingFiles: File[]) => Promise<void>;
} {
  const processIncomingFiles = async (incomingFiles: File[]) => {
    const item = deps.getItem();
    if (!item || !incomingFiles.length) return;
    const imageUnsupported = deps.isScreenshotUnsupportedModel(
      deps.getCurrentModel(),
    );
    const nextImages = [...(deps.selectedImageCache.get(item.id) || [])];
    const nextFiles = [...(deps.selectedFileAttachmentCache.get(item.id) || [])];
    let addedCount = 0;
    let replacedCount = 0;
    let rejectedPdfCount = 0;
    let skippedImageCount = 0;
    let failedPersistCount = 0;

    for (const [index, file] of incomingFiles.entries()) {
      const fileName =
        (file.name || "").trim() || `uploaded-file-${Date.now()}-${index + 1}`;
      const lowerName = fileName.toLowerCase();
      const isPdf =
        file.type === "application/pdf" || lowerName.endsWith(".pdf");
      if (isPdf && file.size > MAX_UPLOAD_PDF_SIZE_BYTES) {
        rejectedPdfCount += 1;
        continue;
      }
      const normalizedFile = new File([file], fileName, {
        type: file.type || "application/octet-stream",
        lastModified: file.lastModified || Date.now(),
      });
      const category = resolveAttachmentCategory(normalizedFile);
      if (category === "image") {
        if (imageUnsupported || nextImages.length >= MAX_SELECTED_IMAGES) {
          skippedImageCount += 1;
          continue;
        }
        try {
          const dataUrl = await readFileAsDataURL(deps.body, normalizedFile);
          const panelWindow = deps.body.ownerDocument?.defaultView;
          const optimizedDataUrl = panelWindow
            ? await deps.optimizeImageDataUrl(panelWindow, dataUrl)
            : dataUrl;
          nextImages.push(optimizedDataUrl);
          addedCount += 1;
        } catch (err) {
          ztoolkit.log("LLM: Failed to read image upload", err);
        }
        continue;
      }

      let textContent: string | undefined;
      if (
        category === "markdown" ||
        category === "code" ||
        category === "text"
      ) {
        try {
          textContent = await readFileAsText(deps.body, normalizedFile);
        } catch (err) {
          ztoolkit.log("LLM: Failed to read text upload", err);
        }
      }

      let storedPath: string | undefined;
      let contentHash: string | undefined;
      try {
        const buffer = await readFileAsArrayBuffer(deps.body, normalizedFile);
        const persisted = await deps.persistAttachmentBlob(
          fileName,
          new Uint8Array(buffer),
        );
        storedPath = persisted.storedPath;
        contentHash = persisted.contentHash;
      } catch (err) {
        failedPersistCount += 1;
        ztoolkit.log("LLM: Failed to persist uploaded attachment", err);
        continue;
      }

      const existingIndex = nextFiles.findIndex(
        (entry) =>
          entry &&
          typeof entry.name === "string" &&
          entry.name.trim().toLowerCase() === fileName.toLowerCase(),
      );
      const nextEntry: ChatAttachment = {
        id: createAttachmentId(),
        name: fileName || "untitled",
        mimeType: normalizedFile.type || "application/octet-stream",
        sizeBytes: normalizedFile.size || 0,
        category,
        textContent,
        storedPath,
        contentHash,
      };
      if (existingIndex >= 0) {
        const existing = nextFiles[existingIndex];
        nextFiles[existingIndex] = {
          ...nextEntry,
          id: existing.id,
        };
        replacedCount += 1;
      } else {
        nextFiles.push(nextEntry);
        addedCount += 1;
      }
    }

    if (nextImages.length) {
      deps.selectedImageCache.set(item.id, nextImages);
    }
    if (nextFiles.length) {
      deps.selectedFileAttachmentCache.set(item.id, nextFiles);
    }
    if (addedCount > 0 || replacedCount > 0) {
      deps.scheduleAttachmentGc();
    }

    deps.updateImagePreview();
    deps.updateFilePreview();

    if (!deps.setStatusMessage) return;
    if (
      (addedCount > 0 || replacedCount > 0) &&
      (rejectedPdfCount > 0 || skippedImageCount > 0 || failedPersistCount > 0)
    ) {
      const replaceText = replacedCount > 0 ? `, replaced ${replacedCount}` : "";
      deps.setStatusMessage(
        `Uploaded ${addedCount} attachment(s)${replaceText}, skipped ${rejectedPdfCount} PDF(s) > 50MB, ${skippedImageCount} image(s), ${failedPersistCount} file(s) not persisted`,
        "warning",
      );
      return;
    }
    if (addedCount > 0 || replacedCount > 0) {
      const replaceText = replacedCount > 0 ? `, replaced ${replacedCount}` : "";
      deps.setStatusMessage(
        `Uploaded ${addedCount} attachment(s)${replaceText}`,
        "ready",
      );
      return;
    }
    if (rejectedPdfCount > 0) {
      deps.setStatusMessage(
        `PDF exceeds 50MB limit (${rejectedPdfCount} file(s) skipped)`,
        "error",
      );
      return;
    }
    if (failedPersistCount > 0) {
      deps.setStatusMessage(
        `Failed to persist ${failedPersistCount} file(s) to local chat-attachments`,
        "error",
      );
    }
  };

  return { processIncomingFiles };
}
