import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Third-party files the plugin loads by URL at run time, so the bundler
// cannot inline them: mermaid's browser build, and KaTeX's stylesheet with
// its fonts. The build copies them out of node_modules, so the shipped copy
// is always the installed version (KaTeX's JavaScript is bundled from the
// same package, and its stylesheet has to match it).

function requireFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Vendor assets: ${path} is missing. Run npm install.`);
  }
  return path;
}

/**
 * KaTeX's stylesheet with only the woff2 source of each font. KaTeX lists
 * woff2, woff and ttf so old browsers have a fallback; every Zotero the
 * plugin supports reads woff2, so the other two are never fetched.
 *
 * Throws when a font is left without exactly one woff2 source, so a KaTeX
 * release that lists its fonts differently fails the build instead of
 * shipping math without fonts.
 */
export function buildKatexStylesheet(css) {
  const fallbackSource =
    /,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g;
  const stripped = css.replace(fallbackSource, "");
  const fontFaces = stripped.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  if (!fontFaces.length) {
    throw new Error("Vendor assets: the KaTeX stylesheet declares no fonts.");
  }
  for (const fontFace of fontFaces) {
    const sources = fontFace.match(/url\([^)]*\)/g) ?? [];
    if (
      sources.length !== 1 ||
      !/^url\(fonts\/[^)]+\.woff2\)$/.test(sources[0])
    ) {
      throw new Error(
        `Vendor assets: expected one woff2 source per KaTeX font, got: ${fontFace}`,
      );
    }
  }
  return stripped;
}

/** The font files a stylesheet from `buildKatexStylesheet` refers to. */
export function listKatexFontFiles(css) {
  const names = new Set();
  for (const match of css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * Writes the vendored files under `vendorDir`, the built add-on's
 * `content/vendor` folder.
 */
export async function writeVendorAssets(
  vendorDir,
  { packageRoot = "node_modules" } = {},
) {
  await mkdir(join(vendorDir, "mermaid"), { recursive: true });
  await copyFile(
    requireFile(join(packageRoot, "mermaid/dist/mermaid.min.js")),
    join(vendorDir, "mermaid/mermaid.min.js"),
  );

  const katexDist = join(packageRoot, "katex/dist");
  const katexCss = buildKatexStylesheet(
    readFileSync(requireFile(join(katexDist, "katex.min.css")), "utf8"),
  );
  await mkdir(join(vendorDir, "katex/fonts"), { recursive: true });
  await writeFile(join(vendorDir, "katex/katex.min.css"), katexCss, "utf8");
  for (const name of listKatexFontFiles(katexCss)) {
    await copyFile(
      requireFile(join(katexDist, "fonts", name)),
      join(vendorDir, "katex/fonts", name),
    );
  }
}
