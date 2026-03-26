import fs from "node:fs";

(globalThis as any).ztoolkit = {
    log: () => undefined,
};

require.extensions[".md"] = function (module: any, filename: string) {
    const content = fs.readFileSync(filename, "utf8");
    module._compile(`module.exports = ${JSON.stringify(content)};`, filename);
};
