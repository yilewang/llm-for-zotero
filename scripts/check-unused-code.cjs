#!/usr/bin/env node

// Fails when src/ holds a top-level declaration (function, class, constant,
// type, interface or enum) that nothing reaches: not the plugin, not the PDF
// worker, not a test and not a script. A re-export that nothing imports is
// reported too, since it is the last thing naming the code behind it.
//
// It walks the import graph from every entry point and marks what each
// reached declaration refers to. References are matched by name, so a local
// variable that shares a top-level name keeps that declaration alive: the
// check can miss dead code, but it does not report code that is referred to.
//
//   node scripts/check-unused-code.cjs          report and set the exit code
//   node scripts/check-unused-code.cjs --json   the same findings as JSON
/* global __dirname -- CommonJS script; eslint config only declares console/process */

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = [
  "src",
  "test",
  "test-workflows",
  "test-behavior",
  "test-isolated",
  "test-live",
  "scripts",
];
const EXTRA_FILES = ["zotero-plugin.config.ts"];
// Entry points inside src/: everything they declare or re-export is
// reachable. The first two are bundle entries. extensionApi.ts is the public
// API other Zotero plugins import, so its users are outside this repository.
// Every file outside src/ (tests, scripts) is an entry point too.
const SOURCE_ENTRY_FILES = [
  "src/index.ts",
  "src/utils/pdfSplitterWorker.ts",
  "src/agent/extensionApi.ts",
];

const SCRIPT_FILE = /\.(?:tsx?|mts|cts|mjs|cjs|js)$/;

function walk(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) walk(abs, files);
    else if (SCRIPT_FILE.test(name) && !name.endsWith(".d.ts")) files.push(abs);
  }
  return files;
}

function resolveImport(file, specifier, fileSet) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(file), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

/** True when `id` names something rather than referring to a binding. */
function isNameOnly(id) {
  const parent = id.parent;
  if (!parent) return false;
  switch (parent.kind) {
    case ts.SyntaxKind.PropertyAccessExpression:
      return parent.name === id;
    case ts.SyntaxKind.QualifiedName:
      return parent.right === id;
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.EnumMember:
    case ts.SyntaxKind.NamedTupleMember:
    case ts.SyntaxKind.JsxAttribute:
    case ts.SyntaxKind.LabeledStatement:
    case ts.SyntaxKind.BreakStatement:
    case ts.SyntaxKind.ContinueStatement:
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.ModuleDeclaration:
    case ts.SyntaxKind.TypeParameter:
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.Parameter:
      return parent.name === id;
    case ts.SyntaxKind.BindingElement:
      return parent.name === id || parent.propertyName === id;
    case ts.SyntaxKind.ImportSpecifier:
    case ts.SyntaxKind.ExportSpecifier:
    case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.NamespaceImport:
    case ts.SyntaxKind.NamespaceExport:
      return true;
    default:
      return false;
  }
}

/**
 * What a piece of code refers to: plain names, `namespace.member` pairs, and
 * the modules it loads with `import()` or `require()`.
 */
function collectReferences(node, file, fileSet) {
  const names = new Set();
  const members = [];
  const dynamic = [];
  const visit = (current) => {
    if (ts.isIdentifier(current)) {
      if (!isNameOnly(current)) {
        const parent = current.parent;
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === current
        ) {
          members.push([current.text, parent.name.text]);
        } else if (ts.isQualifiedName(parent) && parent.left === current) {
          members.push([current.text, parent.right.text]);
        } else {
          names.add(current.text);
        }
      }
      return;
    }
    const loaded = loadedModule(current, file, fileSet);
    if (loaded) dynamic.push(loaded);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return { names, members, dynamic };
}

/** The module an `import()`, `require()` or `import("x").T` loads, if any. */
function loadedModule(node, file, fileSet) {
  let specifier = null;
  let wanted = null;
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    specifier = node.arguments[0].text;
    wanted = dynamicImportNames(node);
  } else if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    specifier = node.argument.literal.text;
    let qualifier = node.qualifier;
    while (qualifier && ts.isQualifiedName(qualifier)) {
      qualifier = qualifier.left;
    }
    wanted = qualifier && !node.isTypeOf ? [qualifier.text] : null;
  }
  if (!specifier) return null;
  const target = resolveImport(file, specifier, fileSet);
  return target ? { target, names: wanted } : null;
}

/**
 * The exports a dynamic import picks, when the code makes that plain:
 * `const { a } = await import("x")` or `(await import("x")).a`. Otherwise
 * null, which means all of them.
 */
function dynamicImportNames(call) {
  let outer = call.parent;
  while (
    outer &&
    (ts.isAwaitExpression(outer) || ts.isParenthesizedExpression(outer))
  ) {
    outer = outer.parent;
  }
  if (!outer) return null;
  if (ts.isPropertyAccessExpression(outer)) {
    return outer.name.text === "then" ? null : [outer.name.text];
  }
  if (
    ts.isVariableDeclaration(outer) &&
    ts.isObjectBindingPattern(outer.name)
  ) {
    const names = [];
    for (const element of outer.name.elements) {
      if (element.dotDotDotToken) return null;
      const key = element.propertyName || element.name;
      if (!ts.isIdentifier(key)) return null;
      names.push(key.text);
    }
    return names;
  }
  return null;
}

function declarationKind(statement) {
  if (ts.isFunctionDeclaration(statement)) return "function";
  if (ts.isClassDeclaration(statement)) return "class";
  if (ts.isInterfaceDeclaration(statement)) return "interface";
  if (ts.isTypeAliasDeclaration(statement)) return "type";
  if (ts.isEnumDeclaration(statement)) return "enum";
  if (ts.isVariableStatement(statement)) return "variable";
  return null;
}

function parseFile(file, fileSet) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : undefined,
  );
  const info = {
    file,
    source,
    // name -> { statements, kind, references[] }
    declarations: new Map(),
    // references of statements that run when the module loads
    rootReferences: [],
    // local name -> { target, name } ("*" for a namespace import)
    imports: new Map(),
    // export name -> { local } | { target, name }
    exports: new Map(),
    starExports: [],
    // `export { a } from "./m"` and `export { a }` entries, by export name
    exportSpecifiers: [],
  };
  const declare = (name, statement, kind, references) => {
    let entry = info.declarations.get(name);
    if (!entry) {
      entry = { statements: [], kind, references: [] };
      info.declarations.set(name, entry);
    }
    if (!entry.statements.includes(statement)) entry.statements.push(statement);
    entry.references.push(references);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const target = ts.isStringLiteral(statement.moduleSpecifier)
        ? resolveImport(file, statement.moduleSpecifier.text, fileSet)
        : null;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) {
        info.imports.set(clause.name.text, { target, name: "default" });
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        info.imports.set(bindings.name.text, { target, name: "*" });
      } else if (bindings) {
        for (const element of bindings.elements) {
          info.imports.set(element.name.text, {
            target,
            name: (element.propertyName || element.name).text,
          });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const target =
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? resolveImport(file, statement.moduleSpecifier.text, fileSet)
          : null;
      const clause = statement.exportClause;
      if (!clause) {
        if (target) info.starExports.push(target);
      } else if (ts.isNamespaceExport(clause)) {
        info.exports.set(clause.name.text, { target, name: "*" });
      } else {
        for (const element of clause.elements) {
          const source = (element.propertyName || element.name).text;
          info.exports.set(
            element.name.text,
            statement.moduleSpecifier
              ? { target, name: source }
              : { local: source },
          );
          info.exportSpecifiers.push({
            name: element.name.text,
            element,
            local: statement.moduleSpecifier ? null : source,
          });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      // `export default <expression>`
      declare(
        "default",
        statement,
        "default export",
        collectReferences(statement.expression, file, fileSet),
      );
      info.exports.set("default", { local: "default" });
      continue;
    }

    const kind = declarationKind(statement);
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (kind === "variable") {
      const declarators = statement.declarationList.declarations;
      if (declarators.every((declarator) => ts.isIdentifier(declarator.name))) {
        for (const declarator of declarators) {
          declare(
            declarator.name.text,
            statement,
            kind,
            collectReferences(declarator, file, fileSet),
          );
          if (exported) {
            info.exports.set(declarator.name.text, {
              local: declarator.name.text,
            });
          }
        }
        continue;
      }
    } else if (kind && (statement.name || isDefault)) {
      const name = statement.name ? statement.name.text : "default";
      declare(
        name,
        statement,
        kind,
        collectReferences(statement, file, fileSet),
      );
      if (exported)
        info.exports.set(isDefault ? "default" : name, { local: name });
      continue;
    }
    // Anything else runs, or declares something global, when the module loads.
    info.rootReferences.push(collectReferences(statement, file, fileSet));
  }
  return info;
}

function analyze() {
  const files = [
    ...SOURCE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))),
    ...EXTRA_FILES.map((file) => path.join(ROOT, file)),
  ];
  const fileSet = new Set(files);
  const modules = new Map(
    files.map((file) => [file, parseFile(file, fileSet)]),
  );
  const sourceRoot = path.join(ROOT, "src") + path.sep;
  const entryFiles = new Set(
    SOURCE_ENTRY_FILES.map((file) => path.join(ROOT, file)),
  );
  const isEntry = (file) =>
    !file.startsWith(sourceRoot) || entryFiles.has(file);

  const alive = new Set();
  const queue = [];
  const key = (file, name) => `${file}\u0000${name}`;
  const markDeclaration = (file, name) => {
    const id = key(file, name);
    if (alive.has(id)) return;
    const entry = modules.get(file)?.declarations.get(name);
    if (!entry) return;
    alive.add(id);
    for (const references of entry.references) queue.push([file, references]);
  };
  const seenExports = new Set();
  const markExport = (file, name) => {
    const info = file && modules.get(file);
    if (!info) return;
    const id = key(file, name);
    if (seenExports.has(id)) return;
    seenExports.add(id);
    if (name === "*") {
      for (const exportName of info.exports.keys())
        markExport(file, exportName);
      for (const target of info.starExports) markExport(target, "*");
      return;
    }
    const found = info.exports.get(name);
    if (!found) {
      for (const target of info.starExports) markExport(target, name);
    } else if ("local" in found) {
      markDeclaration(file, found.local);
      // `import { a } from "./m"; export { a };` passes the import on.
      const imported = info.imports.get(found.local);
      if (imported) markExport(imported.target, imported.name);
    } else {
      markExport(found.target, found.name);
    }
  };
  const follow = (file, references) => {
    const info = modules.get(file);
    for (const name of references.names) {
      markDeclaration(file, name);
      const imported = info.imports.get(name);
      if (imported) markExport(imported.target, imported.name);
    }
    for (const [name, member] of references.members) {
      markDeclaration(file, name);
      const imported = info.imports.get(name);
      if (!imported) continue;
      // `ns.member` on a namespace import picks one export.
      markExport(
        imported.target,
        imported.name === "*" ? member : imported.name,
      );
    }
    for (const { target, names } of references.dynamic) {
      for (const name of names || ["*"]) markExport(target, name);
    }
  };

  for (const info of modules.values()) {
    for (const references of info.rootReferences) {
      queue.push([info.file, references]);
    }
    if (isEntry(info.file)) {
      for (const name of info.declarations.keys()) {
        markDeclaration(info.file, name);
      }
      // What an entry point re-exports is reachable too.
      markExport(info.file, "*");
    }
  }
  while (queue.length) {
    const [file, references] = queue.pop();
    follow(file, references);
  }

  const findings = [];
  for (const info of modules.values()) {
    if (isEntry(info.file)) continue;
    // A statement goes only when every name it declares is unreachable.
    const deadStatements = new Map();
    for (const [name, entry] of info.declarations) {
      const dead = !alive.has(key(info.file, name));
      for (const statement of entry.statements) {
        const state = deadStatements.get(statement) || {
          names: [],
          dead: true,
          kind: entry.kind,
        };
        state.names.push(name);
        state.dead = state.dead && dead;
        deadStatements.set(statement, state);
      }
    }
    const report = (node, names, kind, exported) => {
      const start = info.source.getLineAndCharacterOfPosition(
        node.getStart(info.source),
      );
      const end = info.source.getLineAndCharacterOfPosition(node.end);
      findings.push({
        file: path.relative(ROOT, info.file),
        names,
        kind,
        exported,
        line: start.line + 1,
        endLine: end.line + 1,
        start: node.getStart(info.source),
        end: node.end,
      });
    };
    for (const [statement, state] of deadStatements) {
      if (!state.dead) continue;
      report(
        statement,
        state.names,
        state.kind,
        hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      );
    }
    for (const { name, element, local } of info.exportSpecifiers) {
      if (seenExports.has(key(info.file, name))) continue;
      // `export { a }` of a declaration in this file only widens its reach.
      if (local !== null && !info.imports.has(local)) continue;
      report(element, [name], "re-export", true);
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}

function main() {
  const findings = analyze();
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
  } else if (findings.length) {
    for (const finding of findings) {
      console.error(
        `${finding.file}:${finding.line}  ${finding.names.join(", ")} (${finding.kind})`,
      );
    }
    const lines = findings.reduce(
      (sum, finding) => sum + finding.endLine - finding.line + 1,
      0,
    );
    console.error(
      `\nUnused-code check failed: ${findings.length} top-level declaration(s) or re-export(s) in src/ (${lines} lines) are not reached from the plugin, the PDF worker, a test or a script. Remove them, or use them.`,
    );
  } else {
    console.log(
      "Unused-code check passed (every top-level declaration in src/ is reachable).",
    );
  }
  process.exitCode = findings.length ? 1 : 0;
}

main();
