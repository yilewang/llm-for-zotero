import { assert } from "chai";
import { createRequire } from "module";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const require = createRequire(import.meta.url);

type Boundary = { kind: "runtime" | "type"; from: string; to: string };

type SealedExportViolation = {
  from: string;
  module: string;
  export: string;
  sealed: string;
};

type CheckResult = {
  unclassifiedDirectories: string[];
  upwardRuntimeEdges: Boundary[];
  unexpectedUpwardEdges: Boundary[];
  staleObligations: Boundary[];
  upwardTypeWarnings: Boundary[];
  facadeViolations: Array<Boundary & { facade: string }>;
  sealedExportViolations: SealedExportViolation[];
};

type Layer = { tier: number; name: string; roots: string[] };

type Facade = {
  name: string;
  facade: string;
  internals: string;
  allow: string[];
};

type SealedExport = {
  name: string;
  module: string;
  exports: string[];
  importers: string[];
};

const {
  checkArchitectureBoundaries,
  formatBoundary,
  formatSealedExportViolation,
  validateLayers,
  validateFacades,
  validateSealedExports,
  LAYERS,
  FACADES,
  SEALED_EXPORTS,
} = require("../scripts/check-architecture-boundaries.cjs") as {
  checkArchitectureBoundaries: (
    root?: string,
    options?: {
      obligations?: string[];
      facades?: Facade[];
      sealedExports?: SealedExport[];
    },
  ) => CheckResult;
  formatBoundary: (boundary: Boundary) => string;
  formatSealedExportViolation: (violation: SealedExportViolation) => string;
  validateLayers: (layers: Layer[]) => Layer[];
  validateFacades: (facades: Facade[]) => Facade[];
  validateSealedExports: (entries: SealedExport[]) => SealedExport[];
  LAYERS: Layer[];
  FACADES: Facade[];
  SEALED_EXPORTS: SealedExport[];
};

function formatted(boundaries: Boundary[]): string[] {
  return boundaries.map((boundary) => formatBoundary(boundary));
}

function formattedSealed(violations: SealedExportViolation[]): string[] {
  return violations.map((violation) => formatSealedExportViolation(violation));
}

function writeFixture(root: string, files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
}

describe("architecture boundaries", function () {
  it("keeps the layer order clean apart from the recorded migration obligations", function () {
    this.timeout(20_000);
    const result = checkArchitectureBoundaries(process.cwd());
    assert.deepEqual(result.unclassifiedDirectories, []);
    assert.deepEqual(formatted(result.unexpectedUpwardEdges), []);
    assert.deepEqual(formatted(result.staleObligations), []);
    assert.deepEqual(formatted(result.facadeViolations), []);
    assert.deepEqual(formattedSealed(result.sealedExportViolations), []);
  });

  describe("layer table validation", function () {
    it("accepts the real layer table", function () {
      assert.equal(validateLayers(LAYERS), LAYERS);
    });

    it("rejects a directory claimed by two layers", function () {
      assert.throws(
        () =>
          validateLayers([
            { tier: 0, name: "core", roots: ["src/core/"] },
            { tier: 1, name: "foundation", roots: ["src/utils/", "src/core/"] },
          ]),
        /src\/core\/ is claimed by more than one layer/,
      );
    });

    it("rejects a duplicated directory inside one layer", function () {
      assert.throws(
        () =>
          validateLayers([
            { tier: 0, name: "core", roots: ["src/core/", "src/core/"] },
          ]),
        /src\/core\/ is claimed by more than one layer/,
      );
    });

    it("rejects a tier value that does not match its position", function () {
      assert.throws(
        () =>
          validateLayers([
            { tier: 0, name: "core", roots: ["src/core/"] },
            { tier: 2, name: "services", roots: ["src/services/"] },
          ]),
        /"services" declares tier 2 at position 1/,
      );
    });
  });

  describe("layer-order rule on a fixture tree", function () {
    let root = "";

    before(function () {
      root = mkdtempSync(join(tmpdir(), "architecture-layers-"));
      writeFixture(root, {
        // Foundation tier reaching up into services (runtime) and agent (type).
        "src/utils/foundation.ts": [
          'import { serve } from "../services/consumer";',
          'import type { Runner } from "../agent/runtime";',
          "export const helper = (runner: Runner) => serve(runner);",
          "",
        ].join("\n"),
        // Services reaching down into the foundation tier: allowed.
        "src/services/consumer.ts": [
          'import { helper } from "../utils/foundation";',
          "export const serve = (value: unknown) => helper(value as never);",
          "",
        ].join("\n"),
        // Agent reaching down into services: allowed.
        "src/agent/runtime.ts": [
          'import { serve } from "../services/consumer";',
          "export type Runner = { id: string };",
          "export const run = () => serve(null);",
          "",
        ].join("\n"),
      });
    });

    after(function () {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it("fails an upward runtime edge", function () {
      const result = checkArchitectureBoundaries(root, { obligations: [] });
      assert.include(
        formatted(result.unexpectedUpwardEdges),
        "runtime:src/utils/foundation.ts -> src/services/consumer.ts",
      );
    });

    it("passes downward runtime edges", function () {
      const result = checkArchitectureBoundaries(root, { obligations: [] });
      const upward = formatted(result.upwardRuntimeEdges);
      assert.notInclude(
        upward,
        "runtime:src/services/consumer.ts -> src/utils/foundation.ts",
      );
      assert.notInclude(
        upward,
        "runtime:src/agent/runtime.ts -> src/services/consumer.ts",
      );
    });

    it("reports an upward type-only edge as a warning, not a failure", function () {
      const result = checkArchitectureBoundaries(root, { obligations: [] });
      assert.include(
        formatted(result.upwardTypeWarnings),
        "type:src/utils/foundation.ts -> src/agent/runtime.ts",
      );
      assert.notInclude(
        formatted(result.unexpectedUpwardEdges),
        "type:src/utils/foundation.ts -> src/agent/runtime.ts",
      );
    });

    it("accepts a recorded obligation for an upward runtime edge", function () {
      const result = checkArchitectureBoundaries(root, {
        obligations: [
          "runtime:src/utils/foundation.ts -> src/services/consumer.ts",
        ],
      });
      assert.deepEqual(formatted(result.unexpectedUpwardEdges), []);
      assert.deepEqual(formatted(result.staleObligations), []);
    });

    it("reports an obligation that no longer matches a real edge as stale", function () {
      const result = checkArchitectureBoundaries(root, {
        obligations: ["runtime:src/utils/gone.ts -> src/services/consumer.ts"],
      });
      assert.deepEqual(formatted(result.staleObligations), [
        "runtime:src/utils/gone.ts -> src/services/consumer.ts",
      ]);
    });

    it("refuses to classify an unknown top-level directory", function () {
      const extra = join(root, "src/mystery");
      mkdirSync(extra, { recursive: true });
      writeFileSync(
        join(extra, "thing.ts"),
        "export const thing = 1;\n",
        "utf8",
      );
      try {
        const result = checkArchitectureBoundaries(root, { obligations: [] });
        assert.deepEqual(result.unclassifiedDirectories, ["src/mystery/"]);
      } finally {
        rmSync(extra, { recursive: true, force: true });
      }
    });
  });

  describe("facade internals rule", function () {
    let root = "";

    before(function () {
      root = mkdtempSync(join(tmpdir(), "architecture-facades-"));
      writeFixture(root, {
        "src/services/thing/internal/tables.ts": [
          "export const TABLE = { a: 1 };",
          "",
        ].join("\n"),
        // Internals reaching sideways into their own directory: allowed.
        "src/services/thing/internal/helpers.ts": [
          'import { TABLE } from "./tables";',
          "export const help = () => TABLE.a;",
          "",
        ].join("\n"),
        // The facade itself: allowed, including re-exporting its internals.
        "src/services/thingGateway.ts": [
          'import { help } from "./thing/internal/helpers";',
          'export { TABLE } from "./thing/internal/tables";',
          "export const run = () => help();",
          "",
        ].join("\n"),
        // A neighbour reaching past the facade: the edge the rule exists for.
        "src/services/neighbour.ts": [
          'import { help } from "./thing/internal/helpers";',
          "export const shortcut = () => help();",
          "",
        ].join("\n"),
        // Re-exporting someone else's internals hides the same edge.
        "src/services/reexporter.ts": [
          'export { TABLE } from "./thing/internal/tables";',
          "",
        ].join("\n"),
        // A type-only reach is the same leak: the facade re-exports every
        // type its callers need.
        "src/services/typeReader.ts": [
          'import type { TABLE } from "./thing/internal/tables";',
          "export type Alias = typeof TABLE;",
          "",
        ].join("\n"),
      });
    });

    after(function () {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    const facades: Facade[] = [
      {
        name: "thing",
        facade: "src/services/thingGateway.ts",
        internals: "src/services/thing/",
        allow: [],
      },
    ];

    function violations(allow: string[] = []): string[] {
      const result = checkArchitectureBoundaries(root, {
        obligations: [],
        facades: [{ ...facades[0], allow }],
      });
      return formatted(result.facadeViolations);
    }

    it("fails an import into another module's internals", function () {
      assert.include(
        violations(),
        "runtime:src/services/neighbour.ts -> src/services/thing/internal/helpers.ts",
      );
    });

    it("fails a re-export that hides the same edge", function () {
      assert.include(
        violations(),
        "runtime:src/services/reexporter.ts -> src/services/thing/internal/tables.ts",
      );
    });

    it("fails a type-only reach into the internals", function () {
      assert.include(
        violations(),
        "type:src/services/typeReader.ts -> src/services/thing/internal/tables.ts",
      );
    });

    it("passes the facade's own imports and re-exports", function () {
      const listed = violations();
      assert.notInclude(
        listed,
        "runtime:src/services/thingGateway.ts -> src/services/thing/internal/helpers.ts",
      );
      assert.notInclude(
        listed,
        "runtime:src/services/thingGateway.ts -> src/services/thing/internal/tables.ts",
      );
    });

    it("passes an edge from one internals file to another", function () {
      assert.notInclude(
        violations(),
        "runtime:src/services/thing/internal/helpers.ts -> src/services/thing/internal/tables.ts",
      );
    });

    it("passes a file the facade entry names in allow", function () {
      assert.notInclude(
        violations(["src/services/neighbour.ts"]),
        "runtime:src/services/neighbour.ts -> src/services/thing/internal/helpers.ts",
      );
    });

    it("reports the facade whose boundary was crossed", function () {
      const result = checkArchitectureBoundaries(root, {
        obligations: [],
        facades,
      });
      assert.deepEqual(
        Array.from(new Set(result.facadeViolations.map((v) => v.facade))),
        ["thing"],
      );
    });

    describe("facade table validation", function () {
      it("accepts the real facade table", function () {
        assert.equal(validateFacades(FACADES), FACADES);
      });

      it("rejects internals parked outside the facade's own directory", function () {
        assert.throws(
          () =>
            validateFacades([
              {
                name: "thing",
                facade: "src/services/thingGateway.ts",
                internals: "src/agent/elsewhere/",
                allow: [],
              },
            ]),
          /"thing" declares internals src\/agent\/elsewhere\/ outside its own directory src\/services\//,
        );
      });

      it("rejects internals written without a trailing slash", function () {
        assert.throws(
          () =>
            validateFacades([
              {
                name: "thing",
                facade: "src/services/thingGateway.ts",
                internals: "src/services/thing",
                allow: [],
              },
            ]),
          /"thing" declares internals src\/services\/thing without a trailing slash/,
        );
      });

      it("rejects a facade that sits inside its own internals", function () {
        assert.throws(
          () =>
            validateFacades([
              {
                name: "thing",
                facade: "src/services/thing/gateway.ts",
                internals: "src/services/thing/",
                allow: [],
              },
            ]),
          /"thing" places its facade inside its own internals/,
        );
      });

      it("rejects two entries claiming the same internals", function () {
        assert.throws(
          () =>
            validateFacades([
              {
                name: "thing",
                facade: "src/services/thingGateway.ts",
                internals: "src/services/thing/",
                allow: [],
              },
              {
                name: "other",
                facade: "src/services/otherGateway.ts",
                internals: "src/services/thing/",
                allow: [],
              },
            ]),
          /src\/services\/thing\/ is claimed by more than one facade/,
        );
      });
    });
  });

  describe("sealed export rule", function () {
    let root = "";

    before(function () {
      root = mkdtempSync(join(tmpdir(), "architecture-sealed-"));
      writeFixture(root, {
        // The module may use its own sealed export.
        "src/agent/store/runs.ts": [
          "export function finishRun(): void {}",
          "export function readRun(): string { return 'run'; }",
          "export const closeAll = () => finishRun();",
          "",
        ].join("\n"),
        // The owner the entry names: allowed.
        "src/agent/owner.ts": [
          'import { finishRun } from "./store/runs";',
          "export const end = () => finishRun();",
          "",
        ].join("\n"),
        // Another export of the same module: allowed.
        "src/agent/reader.ts": [
          'import { readRun } from "./store/runs";',
          "export const read = () => readRun();",
          "",
        ].join("\n"),
        // The edge the rule exists for.
        "src/agent/intruder.ts": [
          'import { finishRun } from "./store/runs";',
          "export const end = () => finishRun();",
          "",
        ].join("\n"),
        // Renaming the binding does not change what was taken.
        "src/agent/aliased.ts": [
          'import { finishRun as close } from "./store/runs";',
          "export const end = () => close();",
          "",
        ].join("\n"),
        // Re-exporting hands the export to files that never import it.
        "src/agent/reexporter.ts": [
          'export { finishRun } from "./store/runs";',
          "",
        ].join("\n"),
        // A type-only reach names the export all the same.
        "src/modules/typeReader.ts": [
          'import type { finishRun } from "../agent/store/runs";',
          "export type Finish = typeof finishRun;",
          "",
        ].join("\n"),
        // Taking the module whole carries the sealed export with it.
        "src/agent/barrel.ts": ['export * from "./store/runs";', ""].join("\n"),
        "src/agent/namespaced.ts": [
          'import * as runs from "./store/runs";',
          "export const read = () => runs.readRun();",
          "",
        ].join("\n"),
        "src/agent/dynamic.ts": [
          "export async function read() {",
          '  const runs = await import("./store/runs");',
          "  return runs.readRun();",
          "}",
          "",
        ].join("\n"),
      });
    });

    after(function () {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    const sealed: SealedExport = {
      name: "fixture-runs",
      module: "src/agent/store/runs.ts",
      exports: ["finishRun"],
      importers: ["src/agent/owner.ts"],
    };

    function violations(entry: SealedExport = sealed): string[] {
      const result = checkArchitectureBoundaries(root, {
        obligations: [],
        sealedExports: [entry],
      });
      return formattedSealed(result.sealedExportViolations);
    }

    it("fails a named import outside the owners", function () {
      assert.include(
        violations(),
        "src/agent/intruder.ts -> src/agent/store/runs.ts#finishRun",
      );
    });

    it("fails an aliased import", function () {
      assert.include(
        violations(),
        "src/agent/aliased.ts -> src/agent/store/runs.ts#finishRun",
      );
    });

    it("fails a re-export", function () {
      assert.include(
        violations(),
        "src/agent/reexporter.ts -> src/agent/store/runs.ts#finishRun",
      );
    });

    it("fails a type-only import of the export", function () {
      assert.include(
        violations(),
        "src/modules/typeReader.ts -> src/agent/store/runs.ts#finishRun",
      );
    });

    it("fails taking the module whole", function () {
      const listed = violations();
      for (const from of [
        "src/agent/barrel.ts",
        "src/agent/namespaced.ts",
        "src/agent/dynamic.ts",
      ])
        assert.include(listed, `${from} -> src/agent/store/runs.ts#*`);
    });

    it("passes the owners, the module itself, and other exports", function () {
      const listed = violations();
      for (const from of [
        "src/agent/owner.ts",
        "src/agent/store/runs.ts",
        "src/agent/reader.ts",
      ])
        assert.isFalse(
          listed.some((entry) => entry.startsWith(`${from} ->`)),
          `${from} must pass`,
        );
    });

    it("passes a file the entry names as an owner", function () {
      assert.notInclude(
        violations({
          ...sealed,
          importers: [...sealed.importers, "src/agent/intruder.ts"],
        }),
        "src/agent/intruder.ts -> src/agent/store/runs.ts#finishRun",
      );
    });

    it("reports the sealed entry whose export was taken", function () {
      const result = checkArchitectureBoundaries(root, {
        obligations: [],
        sealedExports: [sealed],
      });
      assert.deepEqual(
        Array.from(
          new Set(result.sealedExportViolations.map((entry) => entry.sealed)),
        ),
        ["fixture-runs"],
      );
    });

    describe("sealed export table validation", function () {
      it("accepts the real table", function () {
        assert.equal(validateSealedExports(SEALED_EXPORTS), SEALED_EXPORTS);
      });

      it("rejects an entry that seals no export", function () {
        assert.throws(
          () => validateSealedExports([{ ...sealed, exports: [] }]),
          /"fixture-runs" seals no export/,
        );
      });

      it("rejects an export sealed by two entries", function () {
        assert.throws(
          () =>
            validateSealedExports([
              sealed,
              { ...sealed, name: "fixture-copy" },
            ]),
          /src\/agent\/store\/runs\.ts#finishRun is sealed by more than one entry/,
        );
      });
    });
  });

  it("lets only the agent loop and the run-owning backends finish agent runs", function () {
    const entry = SEALED_EXPORTS.find((candidate) =>
      candidate.exports.includes("finishAgentRun"),
    );
    assert.isOk(entry, "finishAgentRun must be sealed");
    assert.equal(entry?.module, "src/agent/store/traceStore.ts");
    assert.sameMembers(entry?.importers || [], [
      "src/agent/runtime.ts",
      "src/agent/externalBackendBridge.ts",
      // The ACP backend drives its own run and finishes it.
      "src/acp/runtime.ts",
    ]);
  });

  it("seals exports of modules and owners that exist", function () {
    for (const entry of SEALED_EXPORTS) {
      assert.isTrue(
        existsSync(entry.module),
        `${entry.name} seals a module that does not exist: ${entry.module}`,
      );
      for (const owner of entry.importers) {
        assert.isTrue(
          existsSync(owner),
          `${entry.name} names an owner that does not exist: ${owner}`,
        );
      }
    }
  });

  it("guards the zotero gateway's internals", function () {
    const entry = FACADES.find(
      (candidate) => candidate.name === "zotero-gateway",
    );
    assert.isOk(entry, "the zotero gateway must declare its internals");
    assert.equal(entry?.facade, "src/agent/services/zoteroGateway.ts");
    assert.equal(entry?.internals, "src/agent/services/zotero/");
  });

  it("declares a facade and an internals directory that both exist", function () {
    for (const entry of FACADES) {
      assert.isTrue(
        existsSync(entry.facade),
        `${entry.name} names a facade that does not exist: ${entry.facade}`,
      );
      assert.isTrue(
        existsSync(entry.internals),
        `${entry.name} names internals that do not exist: ${entry.internals}`,
      );
      for (const allowed of entry.allow) {
        assert.isTrue(
          existsSync(allowed),
          `${entry.name} allows a file that does not exist: ${allowed}`,
        );
      }
    }
  });

  it("exposes the architecture check as a repository command", function () {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    assert.equal(
      packageJson.scripts?.["check:architecture"],
      "node scripts/check-architecture-boundaries.cjs",
    );
  });
});
