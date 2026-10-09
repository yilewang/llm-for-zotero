import { assert } from "chai";
import fs from "fs";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const { checkImportCycles, formatCycle } =
  require("../scripts/check-import-cycles.cjs") as {
    checkImportCycles: (root?: string) => {
      runtime: string[][];
      static: string[][];
      unexpectedRuntime: string[][];
      staleAllowedRuntime: string[][];
      unexpectedStatic: string[][];
      staleAllowedStatic: string[][];
      diagnostics: {
        fileCount: number;
        parseCount: number;
        elapsedMs: number;
      };
    };
    formatCycle: (cycle: string[]) => string;
  };

function formatCycles(cycles: string[][]): string[] {
  return cycles.map((cycle) => formatCycle(cycle));
}

const scaffoldRoot = path.resolve(process.cwd(), ".scaffold");
const fixtureRoot = path.resolve(scaffoldRoot, "import-cycle-scanner-test");

function assertFixtureRoot() {
  const relative = path.relative(scaffoldRoot, fixtureRoot);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Refusing to modify fixture root outside .scaffold: ${fixtureRoot}`,
    );
  }
}

function writeFixture(relativePath: string, source: string) {
  const file = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

describe("import cycles", function () {
  before(function () {
    assertFixtureRoot();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    writeFixture(
      "src/runtime-a.ts",
      'export { runtimeB } from "./runtime-b";\nexport const runtimeA = 1;\n',
    );
    writeFixture(
      "src/runtime-b.ts",
      'import { runtimeA } from "./runtime-a";\nexport const runtimeB = runtimeA;\n',
    );
    writeFixture(
      "src/type-a.ts",
      'export type { TypeB } from "./type-b";\nexport type TypeA = string;\n',
    );
    writeFixture(
      "src/type-b.ts",
      'import type { TypeA } from "./type-a";\nexport type TypeB = { value: TypeA };\n',
    );
    writeFixture(
      "src/mixed-a.ts",
      'import { mixedB, type MixedB } from "./mixed-b";\nexport const mixedA = mixedB;\nexport type MixedA = { value: MixedB };\n',
    );
    writeFixture(
      "src/mixed-b.ts",
      'import { mixedA } from "./mixed-a";\nexport const mixedB = mixedA;\nexport type MixedB = { value: string };\n',
    );
    writeFixture("src/no-cycle.ts", "export const noCycle = true;\n");
  });

  after(function () {
    try {
      assertFixtureRoot();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `Left labelled import-cycle test fixture at ${fixtureRoot}: ${String(error)}`,
      );
    }
  });

  it("classifies runtime, type-only static, mixed, and acyclic fixtures", function () {
    const result = checkImportCycles(fixtureRoot);

    assert.deepEqual(formatCycles(result.runtime).sort(), [
      "src/mixed-a.ts -> src/mixed-b.ts -> src/mixed-a.ts",
      "src/runtime-a.ts -> src/runtime-b.ts -> src/runtime-a.ts",
    ]);
    assert.deepEqual(formatCycles(result.static).sort(), [
      "src/mixed-a.ts -> src/mixed-b.ts -> src/mixed-a.ts",
      "src/runtime-a.ts -> src/runtime-b.ts -> src/runtime-a.ts",
      "src/type-a.ts -> src/type-b.ts -> src/type-a.ts",
    ]);
    assert.equal(result.diagnostics.fileCount, 7);
    assert.equal(result.diagnostics.parseCount, result.diagnostics.fileCount);
    assert.isAtLeast(result.diagnostics.elapsedMs, 0);
  });

  it("does not introduce cycles outside the current allowlist", function () {
    // This checks two complete source graphs, not an individual import.
    // The scan diagnostics below make the bounded CI timeout observable.
    this.timeout(30_000);
    const result = checkImportCycles(process.cwd());
    console.info(
      `Import-cycle scan diagnostics: ${result.diagnostics.fileCount} files, ${result.diagnostics.parseCount} parses, ${result.diagnostics.elapsedMs.toFixed(1)}ms.`,
    );
    assert.equal(result.diagnostics.parseCount, result.diagnostics.fileCount);
    assert.deepEqual(formatCycles(result.unexpectedRuntime), []);
    assert.deepEqual(formatCycles(result.unexpectedStatic), []);
    assert.deepEqual(formatCycles(result.staleAllowedRuntime), []);
    assert.deepEqual(formatCycles(result.staleAllowedStatic), []);
  });
});
