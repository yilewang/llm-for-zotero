/**
 * Webchat preloading screen.
 *
 * Shows an animated overlay on the chat area that verifies connectivity
 * to the relay server, Chrome extension, and ChatGPT tab before enabling
 * webchat mode.  Self-contained module for easy transfer to llm-for-zotero.
 */

import { createElement } from "../utils/domHelpers";
import {
  relayGetExtensionLiveness,
  relayGetExtensionStatus,
  relayClearExtensionStatus,
} from "./relayServer";
import { WEBCHAT_TARGETS } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXTENSION_ALIVE_THRESHOLD_MS = 15_000;
const CHECK_POLL_INTERVAL_MS = 500;
const STEP_PAUSE_MS = 300;

interface PreloadStep {
  key: string;
  label: string;
  check: () => boolean;
  maxAttempts: number;
  failHint: string;
}

const STEPS: PreloadStep[] = [
  {
    key: "relay",
    label: "Relay server",
    check: () => !!(Zotero as any).Server?.Endpoints,
    maxAttempts: 1,
    failHint: "Zotero relay server is not available.",
  },
  {
    key: "extension",
    label: "Extension connection",
    check: () =>
      relayGetExtensionLiveness().aliveSinceMs < EXTENSION_ALIVE_THRESHOLD_MS,
    maxAttempts: 20, // 10 seconds
    failHint:
      "Install the Sync for Zotero Chrome extension and reload the page.",
  },
];

/** Build the chatsite step dynamically so it can filter by the target hostname. */
function makeChatSiteStep(targetHost?: string): PreloadStep {
  return {
    key: "chatsite",
    label: "Chat site tab",
    check: () => {
      const status = relayGetExtensionStatus();
      if (!status?.chatTabAlive) return false;
      if (targetHost && status.chatUrl) {
        try {
          return new URL(status.chatUrl).hostname.includes(targetHost);
        } catch {
          /* fall through */
        }
      }
      return !targetHost; // pass only when no specific target is required
    },
    maxAttempts: 30,
    failHint: targetHost
      ? `Open ${targetHost} in your Chrome browser.`
      : `Open the corresponding chat site (${WEBCHAT_TARGETS.map((wt) => wt.modelName).join(", ")}) in your Chrome browser.`,
  };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(
  doc: Document,
  tag: keyof HTMLElementTagNameMap,
  cls: string,
  props?: Record<string, unknown>,
): HTMLElement {
  return createElement(doc, tag, cls, props as any);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Show the webchat preloading overlay on the given chat shell element.
 * Resolves when all checks pass.  Rejects on abort or unrecoverable failure.
 */
export async function showWebChatPreloadScreen(
  chatShell: HTMLElement,
  signal?: { aborted: boolean },
  targetLabel?: string,
  targetHost?: string,
): Promise<void> {
  const doc = chatShell.ownerDocument!;
  const siteName = targetLabel || "ChatGPT";

  // Clear stale extension status so we wait for a fresh heartbeat
  relayClearExtensionStatus();

  // Remove any leftover preload overlay
  chatShell.querySelector(".llm-webchat-preload")?.remove();

  // Build overlay DOM
  const overlay = el(doc, "div", "llm-webchat-preload");
  const content = el(doc, "div", "llm-webchat-preload-content");
  const title = el(doc, "div", "llm-webchat-preload-title", {
    textContent: `Connecting to ${siteName}\u2026`,
  });

  const stepsContainer = el(doc, "div", "llm-webchat-preload-steps");
  const stepEls: { row: HTMLElement; icon: HTMLElement; label: HTMLElement }[] =
    [];

  const allSteps = [...STEPS, makeChatSiteStep(targetHost)];
  for (const step of allSteps) {
    const row = el(doc, "div", "llm-webchat-preload-step");
    row.dataset.step = step.key;
    row.style.opacity = "0";
    const icon = el(doc, "span", "llm-webchat-preload-icon", {
      textContent: "\u25CF",
    }); // ●
    const label = el(doc, "span", "llm-webchat-preload-label", {
      textContent: step.label,
    });
    row.append(icon, label);
    stepsContainer.appendChild(row);
    stepEls.push({ row, icon, label });
  }

  const readyEl = el(doc, "div", "llm-webchat-preload-ready", {
    textContent: "Ready! Starting webchat\u2026",
  });
  readyEl.style.display = "none";

  const errorEl = el(doc, "div", "llm-webchat-preload-error");
  errorEl.style.display = "none";
  const errorMsg = el(doc, "span", "llm-webchat-preload-error-msg");
  const retryBtn = el(doc, "button", "llm-webchat-preload-retry", {
    textContent: "Retry",
    type: "button",
  });
  errorEl.append(errorMsg, retryBtn);

  content.append(title, stepsContainer, readyEl, errorEl);
  overlay.appendChild(content);
  chatShell.appendChild(overlay);

  // Ensure chat shell is positioned for absolute overlay
  const prev = chatShell.style.position;
  if (!prev || prev === "static") chatShell.style.position = "relative";

  // Run checks (with retry support)
  const runChecks = async (): Promise<boolean> => {
    // Reset UI
    errorEl.style.display = "none";
    readyEl.style.display = "none";
    for (const s of stepEls) {
      s.row.style.opacity = "0";
      s.icon.className = "llm-webchat-preload-icon";
      s.icon.textContent = "\u25CF";
    }

    for (let i = 0; i < allSteps.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const step = allSteps[i];
      const ui = stepEls[i];

      // Show step with fade-in
      ui.row.style.opacity = "1";
      ui.icon.className = "llm-webchat-preload-icon is-checking";

      // Poll for check to pass
      let passed = false;
      for (let attempt = 0; attempt < step.maxAttempts; attempt++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (step.check()) {
          passed = true;
          break;
        }
        if (attempt < step.maxAttempts - 1) {
          await sleep(CHECK_POLL_INTERVAL_MS);
        }
      }

      if (passed) {
        // Mark step as passed
        ui.icon.className = "llm-webchat-preload-icon is-pass";
        ui.icon.textContent = "\u2713"; // ✓
        await sleep(STEP_PAUSE_MS);
      } else {
        // Mark step as failed
        ui.icon.className = "llm-webchat-preload-icon is-fail";
        ui.icon.textContent = "\u2717"; // ✗
        errorMsg.textContent = step.failHint;
        errorEl.style.display = "";
        return false;
      }
    }

    return true;
  };

  try {
    let success = await runChecks();

    // Retry loop
    while (!success) {
      await new Promise<void>((resolve) => {
        let abortPoll: ReturnType<typeof setInterval> | null = null;
        const cleanup = () => {
          retryBtn.removeEventListener("click", onClick);
          if (abortPoll !== null) clearInterval(abortPoll);
        };
        const onClick = () => {
          cleanup();
          resolve();
        };
        retryBtn.addEventListener("click", onClick);
        if (signal) {
          abortPoll = setInterval(() => {
            if (signal.aborted) {
              cleanup();
              resolve();
            }
          }, 200);
        }
      });

      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      success = await runChecks();
    }

    // All checks passed — show "Ready!" then fade out
    readyEl.style.display = "";
    await sleep(800);
    overlay.classList.add("llm-webchat-preload-fade-out");
    await sleep(400);
  } finally {
    overlay.remove();
    if (prev) chatShell.style.position = prev;
    else chatShell.style.removeProperty("position");
  }
}
