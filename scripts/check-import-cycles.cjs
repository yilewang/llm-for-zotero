#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ALLOWED_RUNTIME_CYCLES = [];

const ALLOWED_STATIC_CYCLES = [];

function walkSourceFiles(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walkSourceFiles(abs, files);
    } else if (/\.tsx?$/.test(name)) {
      files.push(abs);
    }
  }
  return files;
}

function canonicalCycle(cycle) {
  const body = cycle[0] === cycle[cycle.length - 1] ? cycle.slice(0, -1) : cycle;
  const rotations = body.map((_, index) =>
    body.slice(index).concat(body.slice(0, index)).join(" -> "),
  );
  return rotations.sort()[0] || "";
}

function formatCycle(cycle) {
  const body = cycle[0] === cycle[cycle.length - 1] ? cycle : cycle.concat(cycle[0]);
  return body.join(" -> ");
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
  if (!clause || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

function resolveRelativeImport(file, specifier, fileSet) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(file), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function buildGraph({ root, runtimeOnly }) {
  const sourceRoot = path.join(root, "src");
  const files = walkSourceFiles(sourceRoot);
  const fileSet = new Set(files);
  const graph = new Map();

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
    );
    const deps = [];
    for (const statement of source.statements) {
      let specifier = null;
      let typeOnly = false;
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifier = statement.moduleSpecifier.text;
        typeOnly = isTypeOnlyImport(statement);
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifier = statement.moduleSpecifier.text;
        typeOnly = isTypeOnlyExport(statement);
      }
      if (!specifier || (runtimeOnly && typeOnly)) continue;
      const resolved = resolveRelativeImport(file, specifier, fileSet);
      if (resolved) deps.push(resolved);
    }
    graph.set(file, deps);
  }
  return { files, graph };
}

function findCycles(root, runtimeOnly) {
  const { files, graph } = buildGraph({ root, runtimeOnly });
  const visited = new Set();
  const onStack = new Set();
  const stack = [];
  const cycles = [];

  function dfs(file) {
    visited.add(file);
    stack.push(file);
    onStack.add(file);
    for (const dep of graph.get(file) || []) {
      if (!visited.has(dep)) {
        dfs(dep);
      } else if (onStack.has(dep)) {
        const cycle = stack
          .slice(stack.indexOf(dep))
          .map((entry) => path.relative(root, entry).replace(/\\/g, "/"));
        cycles.push(cycle);
      }
    }
    stack.pop();
    onStack.delete(file);
  }

  for (const file of files) {
    if (!visited.has(file)) dfs(file);
  }

  const seen = new Set();
  const unique = [];
  for (const cycle of cycles) {
    const canonical = canonicalCycle(cycle);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(cycle);
  }
  return unique;
}

function compareCycles(found, allowed) {
  const foundKeys = new Set(found.map(canonicalCycle));
  const allowedKeys = new Set(allowed.map(canonicalCycle));
  return {
    unexpected: found.filter((cycle) => !allowedKeys.has(canonicalCycle(cycle))),
    staleAllowed: allowed.filter((cycle) => !foundKeys.has(canonicalCycle(cycle))),
  };
}

function checkImportCycles(root = process.cwd()) {
  const runtime = findCycles(root, true);
  const staticCycles = findCycles(root, false);
  const runtimeComparison = compareCycles(runtime, ALLOWED_RUNTIME_CYCLES);
  const staticComparison = compareCycles(staticCycles, ALLOWED_STATIC_CYCLES);
  return {
    runtime,
    static: staticCycles,
    unexpectedRuntime: runtimeComparison.unexpected,
    staleAllowedRuntime: runtimeComparison.staleAllowed,
    unexpectedStatic: staticComparison.unexpected,
    staleAllowedStatic: staticComparison.staleAllowed,
  };
}

function printCycleList(title, cycles) {
  if (!cycles.length) return;
  console.error(title);
  for (const cycle of cycles) {
    console.error(`- ${formatCycle(cycle)}`);
  }
}

if (require.main === module) {
  const result = checkImportCycles(process.cwd());
  const failed =
    result.unexpectedRuntime.length ||
    result.unexpectedStatic.length ||
    result.staleAllowedRuntime.length ||
    result.staleAllowedStatic.length;
  if (failed) {
    printCycleList("Unexpected runtime import cycles:", result.unexpectedRuntime);
    printCycleList("Unexpected static import cycles:", result.unexpectedStatic);
    printCycleList("Stale allowed runtime cycles:", result.staleAllowedRuntime);
    printCycleList("Stale allowed static cycles:", result.staleAllowedStatic);
    process.exit(1);
  }
  console.log(
    `Import-cycle check passed (${result.runtime.length} runtime, ${result.static.length} static allowlisted).`,
  );
}

module.exports = {
  checkImportCycles,
  canonicalCycle,
  formatCycle,
};
