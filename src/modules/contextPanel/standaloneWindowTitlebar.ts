import { HTML_NS } from "../../utils/domHelpers";

/**
 * Adds the strip the native traffic lights sit in, for windows that have no
 * toolbar of their own to host them: the response and plan document windows
 * and the diagram window.
 *
 * `addon/content/standaloneTitlebar.js` decides whether this window has given
 * up its native title bar, so the attribute it sets is the only gate here.
 *
 * The caller chooses the host because these windows differ: the document
 * windows keep the strip outside their render root, which is replaced whole on
 * every render, while the diagram window puts it inside its root so the strip
 * inherits the canvas surface colour.
 */
export function installStandaloneWindowTitlebar(
  doc: Document,
  host: HTMLElement | null | undefined,
): void {
  if (!doc.documentElement?.hasAttribute("customtitlebar")) return;
  if (!host || host.querySelector(".llm-window-titlebar")) return;
  const strip = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  strip.className = "llm-window-titlebar";
  const windowButtons = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  windowButtons.className = "llm-window-buttons";
  windowButtons.setAttribute("aria-hidden", "true");
  strip.appendChild(windowButtons);
  host.appendChild(strip);
}
