import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config, version } from "../package.json";
import { shouldReplaceAddonInstance } from "./utils/pluginReload";

const basicTool = new BasicTool();

// An in-place update loads this script while the previous version's object
// may still be on Zotero (its shutdown threw before deleting it). Bootstrap
// calls the hooks of whatever object is there, so a dead or older one must be
// replaced, never reused.
if (
  shouldReplaceAddonInstance(
    // @ts-expect-error - Plugin instance is not typed
    basicTool.getGlobal("Zotero")[config.addonInstance],
    version,
  )
) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
