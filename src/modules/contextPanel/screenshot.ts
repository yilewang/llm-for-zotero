import { HTML_NS } from "../../utils/domHelpers";

async function optimizeImageDataUrl(
  win: Window,
  dataUrl: string,
): Promise<string> {
  const maxDimension = 1024;
  const jpegQuality = 0.7;

  try {
    const ImageCtor = win.Image as typeof Image;
    const img = new ImageCtor();
    img.src = dataUrl;
    await img.decode();

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return dataUrl;

    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = win.document.createElement("canvas") as HTMLCanvasElement;
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return dataUrl;

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    return canvas.toDataURL("image/jpeg", jpegQuality);
  } catch (err) {
    ztoolkit.log("Screenshot optimize failed:", err);
    return dataUrl;
  }
}

/**
 * Screenshot selection overlay for capturing regions from the PDF reader
 */
async function captureScreenshotSelection(win: Window): Promise<string | null> {
  return new Promise((resolve) => {
    const doc = win.document;

    // Find the appropriate container (body for HTML, documentElement for XUL)
    const container = doc.body || doc.documentElement;
    if (!container) {
      ztoolkit.log("Screenshot: No container found");
      resolve(null);
      return;
    }

    // Create overlay with inline styles using HTML namespace
    const overlay = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
    overlay.id = "llm-screenshot-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      width: "100vw",
      height: "100vh",
      zIndex: "10000",
      cursor: "crosshair",
      background: "rgba(0, 0, 0, 0.3)",
    });

    // Instructions
    const instructions = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
    Object.assign(instructions.style, {
      position: "fixed",
      top: "20px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(0, 0, 0, 0.8)",
      color: "white",
      padding: "12px 20px",
      borderRadius: "8px",
      fontSize: "14px",
      fontWeight: "500",
      zIndex: "10001",
      pointerEvents: "none",
    });
    instructions.textContent =
      "Click and drag to select a region, then release";

    // Cancel button
    const cancelBtn = doc.createElementNS(
      HTML_NS,
      "button",
    ) as HTMLButtonElement;
    Object.assign(cancelBtn.style, {
      position: "fixed",
      bottom: "20px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#dc2626",
      color: "white",
      border: "none",
      padding: "10px 24px",
      borderRadius: "8px",
      fontSize: "14px",
      fontWeight: "500",
      cursor: "pointer",
      zIndex: "10001",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      lineHeight: "1",
      minWidth: "120px",
    });
    cancelBtn.textContent = "Cancel (Esc)";

    // Selection rectangle
    const selection = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
    Object.assign(selection.style, {
      position: "absolute",
      border: "2px dashed #2563eb",
      background: "rgba(37, 99, 235, 0.2)",
      pointerEvents: "none",
      display: "none",
    });

    overlay.append(instructions, cancelBtn, selection);

    try {
      container.appendChild(overlay);
      ztoolkit.log("Screenshot: Overlay appended to", container.tagName);
    } catch (err) {
      ztoolkit.log("Screenshot: Failed to append overlay", err);
      resolve(null);
      return;
    }

    let startX = 0;
    let startY = 0;
    let isSelecting = false;
    let isReady = false;
    let resolved = false;

    const cleanup = () => {
      if (overlay.parentNode) {
        overlay.remove();
      }
      doc.removeEventListener("keydown", onKeyDown);
    };

    const safeResolve = (value: string | null, reason: string) => {
      if (resolved) return;
      resolved = true;
      ztoolkit.log(
        "Screenshot: Resolving with",
        value ? "image" : "null",
        "-",
        reason,
      );
      cleanup();
      resolve(value);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      ztoolkit.log("Screenshot: Key pressed:", e.key);
      if (e.key === "Escape") {
        safeResolve(null, "Escape pressed");
      }
    };

    doc.addEventListener("keydown", onKeyDown);

    cancelBtn.addEventListener("click", (e: MouseEvent) => {
      ztoolkit.log("Screenshot: Cancel button clicked");
      e.preventDefault();
      e.stopPropagation();
      safeResolve(null, "Cancel clicked");
    });

    // Wait before accepting mouse events to prevent button click from triggering
    setTimeout(() => {
      isReady = true;
      ztoolkit.log("Screenshot: Now ready for selection");
    }, 200);

    overlay.addEventListener("mousedown", (e: MouseEvent) => {
      ztoolkit.log(
        "Screenshot: mousedown, isReady:",
        isReady,
        "target:",
        (e.target as Element)?.tagName,
      );
      if (!isReady) {
        ztoolkit.log("Screenshot: Ignoring mousedown - not ready yet");
        return;
      }
      if (e.target === cancelBtn) return;
      e.preventDefault();
      e.stopPropagation();
      isSelecting = true;
      startX = e.clientX;
      startY = e.clientY;
      selection.style.left = `${startX}px`;
      selection.style.top = `${startY}px`;
      selection.style.width = "0px";
      selection.style.height = "0px";
      selection.style.display = "block";
      ztoolkit.log("Screenshot: Selection started at", startX, startY);
    });

    overlay.addEventListener("mousemove", (e: MouseEvent) => {
      if (!isSelecting) return;
      e.preventDefault();
      const currentX = e.clientX;
      const currentY = e.clientY;

      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);
      const width = Math.abs(currentX - startX);
      const height = Math.abs(currentY - startY);

      selection.style.left = `${left}px`;
      selection.style.top = `${top}px`;
      selection.style.width = `${width}px`;
      selection.style.height = `${height}px`;
    });

    overlay.addEventListener("mouseup", async (e: MouseEvent) => {
      ztoolkit.log(
        "Screenshot: mouseup, isReady:",
        isReady,
        "isSelecting:",
        isSelecting,
      );
      if (!isReady) {
        ztoolkit.log("Screenshot: Ignoring mouseup - not ready yet");
        return;
      }
      if (!isSelecting) {
        ztoolkit.log("Screenshot: Ignoring mouseup - not selecting");
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      isSelecting = false;

      const endX = e.clientX;
      const endY = e.clientY;

      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);

      ztoolkit.log("Screenshot: Selection size:", width, "x", height);

      // Minimum selection size - just reset if too small
      if (width < 20 || height < 20) {
        ztoolkit.log("Screenshot: Selection too small, resetting");
        selection.style.display = "none";
        return;
      }

      // Hide overlay before capture
      overlay.style.display = "none";

      try {
        const dataUrl = await captureRegion(win, left, top, width, height);
        safeResolve(dataUrl, "Capture complete");
      } catch (err) {
        ztoolkit.log("Screenshot capture failed:", err);
        safeResolve(null, "Capture error");
      }
    });
  });
}

/**
 * Capture a region of the window using canvas
 */
async function captureRegion(
  win: Window,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<string | null> {
  try {
    // Try to find the PDF canvas in the reader
    const readerFrame = win.document.querySelector(
      'iframe[src*="reader"]',
    ) as HTMLIFrameElement | null;

    let targetDoc = win.document;
    if (readerFrame?.contentDocument) {
      targetDoc = readerFrame.contentDocument;
    }

    // Look for the PDF viewer canvas
    const pdfCanvas = targetDoc.querySelector(
      ".pdfViewer canvas, .canvasWrapper canvas, canvas.pdfViewer",
    ) as HTMLCanvasElement | null;

    if (pdfCanvas) {
      const canvasRect = pdfCanvas.getBoundingClientRect();
      const relX = x - canvasRect.left;
      const relY = y - canvasRect.top;

      const scaleX = pdfCanvas.width / canvasRect.width;
      const scaleY = pdfCanvas.height / canvasRect.height;

      const srcX = Math.max(0, relX * scaleX);
      const srcY = Math.max(0, relY * scaleY);
      const srcWidth = Math.min(width * scaleX, pdfCanvas.width - srcX);
      const srcHeight = Math.min(height * scaleY, pdfCanvas.height - srcY);

      if (srcWidth > 0 && srcHeight > 0) {
        const tempCanvas = win.document.createElement(
          "canvas",
        ) as HTMLCanvasElement;
        tempCanvas.width = srcWidth;
        tempCanvas.height = srcHeight;
        const ctx = tempCanvas.getContext(
          "2d",
        ) as CanvasRenderingContext2D | null;

        if (ctx) {
          ctx.drawImage(
            pdfCanvas,
            srcX,
            srcY,
            srcWidth,
            srcHeight,
            0,
            0,
            srcWidth,
            srcHeight,
          );
          return tempCanvas.toDataURL("image/png");
        }
      }
    }

    // Fallback: use Firefox's drawWindow if available
    ztoolkit.log("No PDF canvas found, using fallback capture");

    const canvas = win.document.createElement("canvas") as HTMLCanvasElement;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;

    if (!ctx) {
      return null;
    }

    if ("drawWindow" in ctx) {
      try {
        (
          ctx as CanvasRenderingContext2D & {
            drawWindow: (
              win: Window,
              x: number,
              y: number,
              w: number,
              h: number,
              bg: string,
            ) => void;
          }
        ).drawWindow(win, x, y, width, height, "white");
        return canvas.toDataURL("image/png");
      } catch (err) {
        ztoolkit.log("drawWindow failed:", err);
      }
    }

    return null;
  } catch (err) {
    ztoolkit.log("Capture region error:", err);
    return null;
  }
}

export { optimizeImageDataUrl, captureScreenshotSelection, captureRegion };
