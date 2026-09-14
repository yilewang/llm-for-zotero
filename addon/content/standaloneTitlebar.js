"use strict";

/*
 * Drops the native title bar on macOS so the plugin's own top rows become the
 * top edge of the window and the traffic lights sit inside them.
 *
 * This runs while the document is still parsing on purpose. The attribute
 * changes how the window chrome is sized, so setting it after load flashes the
 * native bar and makes windows that persist their height shrink on every open.
 *
 * Windows and Linux keep their native title bar: there the same attribute also
 * removes the minimize, maximize and close buttons, and these windows draw no
 * replacements for them.
 */
(function () {
  try {
    const { AppConstants } = ChromeUtils.importESModule(
      "resource://gre/modules/AppConstants.sys.mjs",
    );
    if (AppConstants.platform !== "macosx") return;
    document.documentElement.setAttribute("customtitlebar", "true");
  } catch (error) {
    // A runtime without AppConstants keeps its native title bar rather than
    // failing to open the window at all.
    if (typeof console !== "undefined") {
      console.error("LLM-for-Zotero: custom title bar unavailable", error);
    }
  }
})();
