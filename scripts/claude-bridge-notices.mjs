import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// bridge.mjs inlines @anthropic-ai/claude-agent-sdk/sdk.mjs, which Anthropic
// pre-bundled with code from the packages below. Their license texts must
// travel with the bundle. Order here is the order in the notices file.
export const CLAUDE_BRIDGE_NOTICE_PACKAGES = [
  {
    name: "@anthropic-ai/claude-agent-sdk",
    licenseFile: "LICENSE.md",
    licenseName:
      "Anthropic legal agreements (its own terms, not MIT; quoted below as shipped)",
  },
  { name: "@modelcontextprotocol/sdk", licenseFile: "LICENSE" },
  { name: "zod", licenseFile: "LICENSE" },
  { name: "mime-types", licenseFile: "LICENSE" },
  { name: "mime-db", licenseFile: "LICENSE" },
];

export const CLAUDE_BRIDGE_NOTICES_OUTPUT_PATH =
  ".scaffold/build/addon/content/claude-bridge/THIRD_PARTY_NOTICES.txt";

const DEFAULT_ROOTS = ["packages/claude-bridge/node_modules", "node_modules"];

function findPackageDir(name, roots) {
  for (const root of roots) {
    const dir = join(root, name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(
    `Claude bridge notices: package "${name}" is not installed (looked in ${roots.join(", ")}). Run npm install.`,
  );
}

function readRequired(path, what) {
  if (!existsSync(path)) {
    throw new Error(`Claude bridge notices: ${what} is missing at ${path}.`);
  }
  return readFileSync(path, "utf8");
}

export function buildClaudeBridgeNotices({
  roots = DEFAULT_ROOTS,
  adapterNoticePath = "packages/claude-bridge/NOTICE",
  adapterLicensePath = "packages/claude-bridge/LICENSE-MIT",
  packages = CLAUDE_BRIDGE_NOTICE_PACKAGES,
} = {}) {
  const rule = "=".repeat(72);
  const sections = [];
  sections.push(
    [
      "THIRD-PARTY NOTICES",
      "",
      "bridge.mjs in this folder bundles the following third-party code.",
      "Each entry gives the package, its version, its license, and the license text.",
    ].join("\n"),
  );
  sections.push(
    [
      rule,
      "cc-llm4zotero-adapter (the bridge itself)",
      "License: AGPL-3.0-or-later (earlier contributions also MIT)",
      rule,
      "",
      readRequired(adapterNoticePath, "adapter NOTICE").trim(),
      "",
      "MIT License text for the contributions made before the relicense:",
      "",
      readRequired(adapterLicensePath, "adapter LICENSE-MIT").trim(),
    ].join("\n"),
  );
  for (const entry of packages) {
    const dir = findPackageDir(entry.name, roots);
    const manifest = JSON.parse(
      readRequired(join(dir, "package.json"), `${entry.name} package.json`),
    );
    const licenseText = readRequired(
      join(dir, entry.licenseFile),
      `${entry.name} ${entry.licenseFile}`,
    );
    const licenseName =
      entry.licenseName ?? manifest.license ?? "see text below";
    sections.push(
      [
        rule,
        `${entry.name} ${manifest.version}`,
        `License: ${licenseName}`,
        rule,
        "",
        // Quoted exactly as shipped; only the trailing newline is trimmed.
        licenseText.replace(/\s+$/, ""),
      ].join("\n"),
    );
  }
  return sections.join("\n\n") + "\n";
}

export async function writeClaudeBridgeNotices(
  outputPath = CLAUDE_BRIDGE_NOTICES_OUTPUT_PATH,
  options,
) {
  const text = buildClaudeBridgeNotices(options);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, text, "utf8");
  return outputPath;
}
