#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

/**
 * The layer order of the source tree, lowest tier first.
 *
 * A module may import anything in its own tier or below it. A runtime import
 * that points *up* the order (a lower layer reaching into a higher one) is a
 * failure; a type-only import that points up is reported as a warning, because
 * it disappears at build time and only signals a contract that lives in the
 * wrong place.
 *
 * Every top-level directory under `src/` must appear in exactly one tier. A
 * directory that is missing from the table fails the check rather than being
 * silently exempt. Files directly under `src/` (`hooks.ts`, `index.ts`,
 * `addon.ts`) are the composition root: they wire the whole plugin together and
 * therefore sit above every tier below.
 */
const LAYERS = [
  {
    tier: 0,
    name: "core",
    roots: ["src/core/"],
  },
  {
    tier: 1,
    name: "foundation",
    roots: [
      // Shared value/type vocabulary and low-level helpers.
      "src/shared/",
      "src/utils/",
      // Pure Codex catalog-selection logic.
      "src/codex/",
      // Codex credential and model-catalog storage.
      "src/codexAuth/",
      // Prompt-cache manager.
      "src/contextCache/",
      // Model registry and capability lookup.
      "src/modelCapabilities/",
      // Provider registry and tier tables.
      "src/providers/",
      // Web-search client, prefs, and attribution helpers.
      "src/webAccess/",
    ],
  },
  {
    tier: 2,
    name: "services",
    roots: ["src/services/"],
  },
  {
    tier: 3,
    name: "agent",
    roots: [
      "src/agent/",
      // Conversation backends the agent layer drives and imports back.
      "src/claudeCode/",
      "src/codexAppServer/",
      // ACP agent backend: answers agent turns over an ACP agent's stdio.
      "src/acp/",
      "src/webchat/",
    ],
  },
  {
    tier: 4,
    name: "modules",
    roots: ["src/modules/"],
  },
];

/**
 * Reject a malformed layer table rather than a verdict computed from one.
 * A root claimed by two tiers, or a tier value out of step with its position,
 * would silently mis-place a whole directory and make the check pass for the
 * wrong reason. Returns the table so it can wrap a declaration.
 */
function validateLayers(layers) {
  const claimed = new Set();
  layers.forEach((layer, index) => {
    if (layer.tier !== index) {
      throw new Error(
        `Layer "${layer.name}" declares tier ${layer.tier} at position ${index}.`,
      );
    }
    for (const root of layer.roots) {
      if (claimed.has(root)) {
        throw new Error(`Directory ${root} is claimed by more than one layer.`);
      }
      claimed.add(root);
    }
  });
  return layers;
}

validateLayers(LAYERS);

/** Tier of files that live directly under `src/` (the composition root). */
const COMPOSITION_ROOT_TIER = LAYERS.length;

/**
 * Modules whose inside is private, and where that inside lives.
 *
 * This is orthogonal to `LAYERS`: tiers say which direction an import may
 * point, a facade says who is allowed to reach a particular set of files at
 * all. A module too big to read is split into an owner per responsibility, and
 * those owners only stay owners if the rest of the tree keeps talking to the
 * facade — otherwise the split hands every caller a second, narrower thing to
 * depend on and the module is harder to move than before it was split.
 *
 * `allow` names extra files permitted to import the internals, for a
 * transition that cannot be done in one change. It is empty today and should
 * stay that way.
 */
const FACADES = [
  {
    name: "zotero-gateway",
    facade: "src/agent/services/zoteroGateway.ts",
    internals: "src/agent/services/zotero/",
    allow: [],
  },
];

/**
 * Reject a facade entry that cannot describe a real boundary: internals that
 * do not sit beside the facade, a facade parked inside the directory it is
 * meant to guard (which would exempt it from its own rule by the
 * internals-to-internals clause), or two entries claiming one directory.
 * Returns the table so it can wrap a declaration.
 */
function validateFacades(facades) {
  const claimed = new Set();
  for (const entry of facades) {
    if (!entry.internals.endsWith("/")) {
      throw new Error(
        `Facade "${entry.name}" declares internals ${entry.internals} without a trailing slash.`,
      );
    }
    const directory = entry.facade.slice(0, entry.facade.lastIndexOf("/") + 1);
    if (!entry.internals.startsWith(directory)) {
      throw new Error(
        `Facade "${entry.name}" declares internals ${entry.internals} outside its own directory ${directory}.`,
      );
    }
    if (entry.facade.startsWith(entry.internals)) {
      throw new Error(
        `Facade "${entry.name}" places its facade inside its own internals.`,
      );
    }
    if (claimed.has(entry.internals)) {
      throw new Error(
        `Directory ${entry.internals} is claimed by more than one facade.`,
      );
    }
    claimed.add(entry.internals);
  }
  return facades;
}

validateFacades(FACADES);

/**
 * Exports only their named owners may take.
 *
 * A facade seals a directory; this seals single exports of a module that many
 * files import for other reasons. `finishAgentRun` ends an agent run, and the
 * Original Agent loop names the stop rule of every run it ends from one place,
 * so a run ended anywhere else would stop for a reason nothing records. The
 * module that defines an export may always use it.
 */
const SEALED_EXPORTS = [
  {
    name: "run-termination",
    module: "src/agent/store/traceStore.ts",
    exports: ["finishAgentRun"],
    importers: [
      // The Original Agent loop, through its one terminateRun path.
      "src/agent/runtime.ts",
      // Codex and Claude Code bridge runs finish their own runs.
      "src/agent/externalBackendBridge.ts",
      // The ACP backend finishes the run it drove over the agent's stdio.
      "src/acp/runtime.ts",
    ],
  },
];

/**
 * Reject a sealed-export entry that cannot describe a real boundary: one that
 * seals nothing, or an export two entries both claim to own. Returns the
 * table so it can wrap a declaration.
 */
function validateSealedExports(entries) {
  const claimed = new Set();
  for (const entry of entries) {
    if (!entry.exports.length) {
      throw new Error(`Sealed entry "${entry.name}" seals no export.`);
    }
    for (const name of entry.exports) {
      const key = `${entry.module}#${name}`;
      if (claimed.has(key)) {
        throw new Error(`${key} is sealed by more than one entry.`);
      }
      claimed.add(key);
    }
  }
  return entries;
}

validateSealedExports(SEALED_EXPORTS);

/**
 * Exact upward runtime imports present when the layer rule was introduced.
 * Every entry is a migration obligation, not a directory exemption: an entry
 * that no longer matches a real edge is reported as stale so the list shrinks
 * as the debt is paid off, and it can never grow without an explicit edit here.
 */
const MIGRATION_OBLIGATIONS = [
  // Conversation backends reach into panel state instead of being called by it.
  "runtime:src/claudeCode/runtimeRetention.ts -> src/modules/contextPanel/conversationIdentity.ts",
  "runtime:src/claudeCode/runtimeRetention.ts -> src/modules/contextPanel/portalScope.ts",
  "runtime:src/claudeCode/store.ts -> src/modules/contextPanel/agentConversationCleanup.ts",
  "runtime:src/codexAppServer/store.ts -> src/modules/contextPanel/agentConversationCleanup.ts",
  "runtime:src/webchat/pipeline.ts -> src/modules/contextPanel/setupHandlers/controllers/pdfAttachmentPolicy.ts",
  // src/core/conversations is an orchestrator, not a contract: it reaches up
  // into the shared vocabulary, the chat store, and all three backends.
  "runtime:src/core/conversations/pendingDeletionStore.ts -> src/shared/conversationWriteFence.ts",
  "runtime:src/core/conversations/repository.ts -> src/agent/documents/store.ts",
  "runtime:src/core/conversations/repository.ts -> src/agent/mcp/server.ts",
  "runtime:src/core/conversations/repository.ts -> src/claudeCode/store.ts",
  "runtime:src/core/conversations/repository.ts -> src/codexAppServer/constants.ts",
  "runtime:src/core/conversations/repository.ts -> src/codexAppServer/forkService.ts",
  "runtime:src/core/conversations/repository.ts -> src/codexAppServer/store.ts",
  "runtime:src/core/conversations/repository.ts -> src/shared/conversationForkLinks.ts",
  "runtime:src/core/conversations/repository.ts -> src/shared/conversationKeyLedger.ts",
  "runtime:src/core/conversations/repository.ts -> src/shared/conversationKeySpace.ts",
  "runtime:src/core/conversations/repository.ts -> src/shared/conversationRegistry.ts",
  "runtime:src/core/conversations/repository.ts -> src/shared/conversationWriteFence.ts",
  "runtime:src/core/conversations/repository.ts -> src/utils/chatStore.ts",
  // Note targeting resolves backend portal items directly.
  "runtime:src/services/notes/noteTarget.ts -> src/claudeCode/portal.ts",
  "runtime:src/services/notes/noteTarget.ts -> src/codexAppServer/portal.ts",
  // The Zotero change dispatcher writes straight into the agent change journal.
  "runtime:src/services/zoteroChangeDispatcher.ts -> src/agent/store/changeJournal.ts",
  // Library-chat read strategy reads the agent research policy.
  "runtime:src/shared/libraryChatReadStrategy.ts -> src/agent/context/researchPolicy.ts",
  // src/utils holds application code (chat store, LLM client, provider probes)
  // that belongs above the services layer.
  "runtime:src/utils/attachmentRefStore.ts -> src/services/attachmentStorage.ts",
  "runtime:src/utils/chatStore.ts -> src/modules/contextPanel/agentConversationCleanup.ts",
  "runtime:src/utils/chatStore.ts -> src/modules/contextPanel/constants.ts",
  "runtime:src/utils/chatStore.ts -> src/services/context/normalizers.ts",
  "runtime:src/utils/chatStore.ts -> src/services/quotes/quoteCitations.ts",
  "runtime:src/utils/codexAppServerProcess.ts -> src/agent/privacy/localDocumentPathRedaction.ts",
  "runtime:src/utils/llmClient.ts -> src/agent/model/shared.ts",
  "runtime:src/utils/migrations.ts -> src/codexAppServer/permissionState.ts",
  "runtime:src/utils/migrations.ts -> src/services/mineru/mineruCache.ts",
  "runtime:src/utils/modelProviders.ts -> src/webchat/types.ts",
  "runtime:src/utils/providerConnectionTest.ts -> src/agent/context/resolvedAgentRequest.ts",
  "runtime:src/utils/providerConnectionTest.ts -> src/agent/model/factory.ts",
  "runtime:src/utils/providerConnectionTest.ts -> src/codexAppServer/mcpSetup.ts",
  "runtime:src/utils/providerConnectionTest.ts -> src/codexAppServer/permissionProfiles.ts",
  "runtime:src/utils/providerConnectionTest.ts -> src/codexAppServer/runtimeCwd.ts",
  "runtime:src/utils/providerProtocol.ts -> src/webchat/types.ts",
];

function slash(value) {
  return value.replace(/\\/g, "/");
}

function walkSourceFiles(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    const absolute = path.join(dir, name);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walkSourceFiles(absolute, files);
    } else if (/\.(?:[cm]?ts|tsx)$/.test(name)) {
      files.push(absolute);
    }
  }
  return files;
}

/** `src/agent/tools/x.ts` -> `src/agent/`; `src/hooks.ts` -> `null`. */
function topLevelRoot(relativePath) {
  const rest = relativePath.slice("src/".length);
  const marker = rest.indexOf("/");
  return marker < 0 ? null : `src/${rest.slice(0, marker)}/`;
}

function layerOf(relativePath) {
  const root = topLevelRoot(relativePath);
  if (root === null) {
    return { tier: COMPOSITION_ROOT_TIER, name: "composition root" };
  }
  for (const layer of LAYERS) {
    if (layer.roots.includes(root)) return layer;
  }
  return null;
}

function isTypeOnlyImport(statement) {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings) return true;
  if (ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(statement) {
  if (statement.isTypeOnly) return true;
  const clause = statement.exportClause;
  return Boolean(
    clause &&
    ts.isNamedExports(clause) &&
    clause.elements.length &&
    clause.elements.every((element) => element.isTypeOnly),
  );
}

function loadAliases(root) {
  const file = path.join(root, "tsconfig.json");
  if (!fs.existsSync(file)) return [];
  const parsed = ts.parseConfigFileTextToJson(
    file,
    fs.readFileSync(file, "utf8"),
  );
  const options = parsed.config?.compilerOptions || {};
  const baseUrl = path.resolve(root, options.baseUrl || ".");
  return Object.entries(options.paths || {}).flatMap(([pattern, targets]) =>
    (targets || []).map((target) => ({ pattern, target, baseUrl })),
  );
}

function aliasCandidate(specifier, alias) {
  const marker = alias.pattern.indexOf("*");
  if (marker < 0) {
    return specifier === alias.pattern
      ? path.resolve(alias.baseUrl, alias.target)
      : null;
  }
  const prefix = alias.pattern.slice(0, marker);
  const suffix = alias.pattern.slice(marker + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  const value = specifier.slice(
    prefix.length,
    specifier.length - suffix.length,
  );
  return path.resolve(alias.baseUrl, alias.target.replace("*", value));
}

function resolveCandidate(base, fileSet) {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function resolveImport(root, file, specifier, fileSet, aliases) {
  if (specifier.startsWith(".")) {
    return resolveCandidate(
      path.resolve(path.dirname(file), specifier),
      fileSet,
    );
  }
  if (specifier.startsWith("src/")) {
    return resolveCandidate(path.resolve(root, specifier), fileSet);
  }
  for (const alias of aliases) {
    const candidate = aliasCandidate(specifier, alias);
    const resolved = candidate && resolveCandidate(candidate, fileSet);
    if (resolved) return resolved;
  }
  return null;
}

function collectImportEdges(root = process.cwd()) {
  const sourceRoot = path.join(root, "src");
  const files = walkSourceFiles(sourceRoot);
  const fileSet = new Set(files);
  const aliases = loadAliases(root);
  const edges = [];
  const add = (file, specifier, kind) => {
    const resolved = resolveImport(root, file, specifier, fileSet, aliases);
    if (!resolved) return;
    edges.push({
      from: slash(path.relative(root, file)),
      to: slash(path.relative(root, resolved)),
      kind,
    });
  };

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        add(
          file,
          statement.moduleSpecifier.text,
          isTypeOnlyImport(statement) ? "type" : "runtime",
        );
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        add(
          file,
          statement.moduleSpecifier.text,
          isTypeOnlyExport(statement) ? "type" : "runtime",
        );
      }
    }
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        add(file, node.arguments[0].text, "runtime");
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        add(file, node.argument.literal.text, "type");
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  return [
    ...new Map(edges.map((edge) => [formatBoundary(edge), edge])).values(),
  ].sort((left, right) =>
    formatBoundary(left).localeCompare(formatBoundary(right)),
  );
}

function formatBoundary(boundary) {
  return `${boundary.kind}:${boundary.from} -> ${boundary.to}`;
}

function parseBoundary(value) {
  const match = /^(runtime|type):(.+) -> (.+)$/.exec(value);
  if (!match) throw new Error(`Invalid architecture baseline entry: ${value}`);
  return { kind: match[1], from: match[2], to: match[3] };
}

function describeBoundary(boundary) {
  const from = layerOf(boundary.from);
  const to = layerOf(boundary.to);
  const arrow = from && to ? ` (${from.name} -> ${to.name})` : "";
  return `${formatBoundary(boundary)}${arrow}`;
}

/** Top-level directories under `src/` that no tier claims. */
function findUnclassifiedDirectories(root) {
  const sourceRoot = path.join(root, "src");
  if (!fs.existsSync(sourceRoot)) return [];
  const claimed = new Set(LAYERS.flatMap((layer) => layer.roots));
  return fs
    .readdirSync(sourceRoot)
    .filter((name) => {
      if (name === "node_modules" || name.startsWith(".")) return false;
      return fs.statSync(path.join(sourceRoot, name)).isDirectory();
    })
    .map((name) => `src/${name}/`)
    .filter((directory) => !claimed.has(directory))
    .sort();
}

/**
 * Every edge that reaches into a facade's internals from somewhere that is
 * neither the facade, another file under those internals, nor listed in
 * `allow`. Type-only edges count: the facade re-exports the types its callers
 * need, so importing one straight from the internals is the same dependency
 * wearing a hat that disappears at build time.
 */
function findFacadeViolations(edges, facades) {
  const violations = [];
  for (const edge of edges) {
    for (const entry of facades) {
      if (!edge.to.startsWith(entry.internals)) continue;
      if (edge.from === entry.facade) continue;
      if (edge.from.startsWith(entry.internals)) continue;
      if ((entry.allow || []).includes(edge.from)) continue;
      violations.push({ ...edge, facade: entry.name });
    }
  }
  return violations;
}

/** `src/x.ts -> src/y.ts#name`, or `#*` when the module is taken whole. */
function formatSealedExportViolation(violation) {
  return `${violation.from} -> ${violation.module}#${violation.export}`;
}

/**
 * Every file outside an entry's owners that takes one of its sealed exports:
 * by name (aliased, re-exported, type-only, or read off a namespace), or by
 * taking the whole module -- `import * as`, `export *`, `import()` or
 * `require` -- which hands the export to code this check never reads.
 */
function findSealedExportViolations(root, edges, sealedExports) {
  const fileSet = new Set(walkSourceFiles(path.join(root, "src")));
  const aliases = loadAliases(root);
  const violations = [];
  for (const entry of sealedExports) {
    const sealed = new Set(entry.exports);
    const candidates = new Set(
      edges
        .filter(
          (edge) =>
            edge.to === entry.module &&
            edge.from !== entry.module &&
            !entry.importers.includes(edge.from),
        )
        .map((edge) => edge.from),
    );
    for (const from of candidates) {
      const file = path.join(root, from);
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const isModule = (specifier) => {
        if (!specifier || !ts.isStringLiteralLike(specifier)) return false;
        const resolved = resolveImport(
          root,
          file,
          specifier.text,
          fileSet,
          aliases,
        );
        return (
          Boolean(resolved) &&
          slash(path.relative(root, resolved)) === entry.module
        );
      };
      const taken = new Set();
      const visit = (node) => {
        if (ts.isIdentifier(node) && sealed.has(node.text))
          taken.add(node.text);
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : undefined;
        if (
          (bindings &&
            ts.isNamespaceImport(bindings) &&
            isModule(node.moduleSpecifier)) ||
          (ts.isExportDeclaration(node) &&
            (!node.exportClause || ts.isNamespaceExport(node.exportClause)) &&
            isModule(node.moduleSpecifier)) ||
          (ts.isCallExpression(node) &&
            node.arguments.length === 1 &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) &&
                node.expression.text === "require")) &&
            isModule(node.arguments[0]))
        ) {
          taken.add("*");
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      for (const name of [...taken].sort()) {
        violations.push({
          from,
          module: entry.module,
          export: name,
          sealed: entry.name,
        });
      }
    }
  }
  return violations.sort((left, right) =>
    formatSealedExportViolation(left).localeCompare(
      formatSealedExportViolation(right),
    ),
  );
}

function checkArchitectureBoundaries(root = process.cwd(), options = {}) {
  const obligationValues = options.obligations || MIGRATION_OBLIGATIONS;
  const facades = validateFacades(options.facades || FACADES);
  const sealedExports = validateSealedExports(
    options.sealedExports || SEALED_EXPORTS,
  );
  const edges = collectImportEdges(root);
  const upward = [];
  for (const edge of edges) {
    const from = layerOf(edge.from);
    const to = layerOf(edge.to);
    if (!from || !to) continue;
    if (to.tier > from.tier) upward.push(edge);
  }
  const upwardRuntimeEdges = upward.filter((edge) => edge.kind === "runtime");
  const upwardTypeWarnings = upward.filter((edge) => edge.kind === "type");
  const present = new Set(upwardRuntimeEdges.map(formatBoundary));
  const obligations = new Map(
    obligationValues.map((value) => [value, parseBoundary(value)]),
  );
  return {
    layers: LAYERS,
    facades,
    sealedExports,
    unclassifiedDirectories: findUnclassifiedDirectories(root),
    facadeViolations: findFacadeViolations(edges, facades),
    sealedExportViolations: findSealedExportViolations(
      root,
      edges,
      sealedExports,
    ),
    upwardRuntimeEdges,
    upwardTypeWarnings,
    unexpectedUpwardEdges: upwardRuntimeEdges.filter(
      (edge) => !obligations.has(formatBoundary(edge)),
    ),
    staleObligations: [...obligations.entries()]
      .filter(([value]) => !present.has(value))
      .map(([, edge]) => edge),
  };
}

function printList(title, boundaries) {
  if (!boundaries.length) return;
  console.error(title);
  for (const boundary of boundaries) {
    console.error(`- ${describeBoundary(boundary)}`);
  }
}

if (require.main === module) {
  const result = checkArchitectureBoundaries(process.cwd());
  if (result.upwardTypeWarnings.length) {
    console.warn(
      `Warning: ${result.upwardTypeWarnings.length} type-only import(s) point up the layer order:`,
    );
    for (const boundary of result.upwardTypeWarnings) {
      console.warn(`- ${describeBoundary(boundary)}`);
    }
  }
  const failed =
    result.unclassifiedDirectories.length ||
    result.unexpectedUpwardEdges.length ||
    result.staleObligations.length ||
    result.facadeViolations.length ||
    result.sealedExportViolations.length;
  if (failed) {
    if (result.unclassifiedDirectories.length) {
      console.error(
        "Top-level directories missing from the layer table (add each one to LAYERS):",
      );
      for (const directory of result.unclassifiedDirectories) {
        console.error(`- ${directory}`);
      }
    }
    printList(
      "Runtime imports that point up the layer order:",
      result.unexpectedUpwardEdges,
    );
    printList("Stale migration obligations:", result.staleObligations);
    if (result.facadeViolations.length) {
      console.error(
        "Imports that reach past a facade into its internals (import the facade instead):",
      );
      for (const violation of result.facadeViolations) {
        console.error(`- ${describeBoundary(violation)} [${violation.facade}]`);
      }
    }
    if (result.sealedExportViolations.length) {
      console.error(
        "Sealed exports taken outside their owners (go through an owner instead):",
      );
      for (const violation of result.sealedExportViolations) {
        console.error(
          `- ${formatSealedExportViolation(violation)} [${violation.sealed}]`,
        );
      }
    }
    process.exit(1);
  }
  const order = LAYERS.map((layer) => layer.name).join(" < ");
  const sealedExportCount = SEALED_EXPORTS.reduce(
    (count, entry) => count + entry.exports.length,
    0,
  );
  console.log(
    `Architecture-boundary check passed (${order} < composition root; ` +
      `${result.upwardRuntimeEdges.length} migration obligations remain, ` +
      `${result.upwardTypeWarnings.length} type-only warnings, ` +
      `${FACADES.length} facade(s) sealed, ` +
      `${sealedExportCount} export(s) sealed).`,
  );
}

module.exports = {
  FACADES,
  LAYERS,
  MIGRATION_OBLIGATIONS,
  SEALED_EXPORTS,
  checkArchitectureBoundaries,
  collectImportEdges,
  formatBoundary,
  formatSealedExportViolation,
  validateFacades,
  validateLayers,
  validateSealedExports,
};
