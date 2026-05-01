const fs = require("fs");
const Module = require("module");

require.extensions[".md"] = (module, filename) => {
  module.exports = fs.readFileSync(filename, "utf8");
};

const zoteroPluginToolkitStub = {
  ZoteroToolkit: class ZoteroToolkit {
    constructor() {
      this.basicOptions = {
        log: {},
        api: {},
      };
      this.UI = {
        basicOptions: {
          ui: {},
        },
      };
      this.ProgressWindow = {
        setIconURI: () => {},
      };
    }
  },
  BasicTool: class BasicTool {},
  UITool: class UITool {
    constructor(parent) {
      this.parent = parent;
    }
  },
  unregister: () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "zotero-plugin-toolkit") {
    return zoteroPluginToolkitStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};
