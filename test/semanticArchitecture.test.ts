import { assert } from "chai";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path: string) => {
  const text = readFileSync(path, "utf8");
  // Every scan below is an absence check. A file that moved, emptied or was
  // reduced to a stub would satisfy all of them without proving anything.
  assert.isAbove(
    text.length,
    200,
    `${path} was read but looks empty; the scan would pass vacuously`,
  );
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
};

describe("direct Agent ownership boundary", function () {
  it("does not change host permission mode based on the provider entry point", function () {
    const source = read("src/agent/tools/registry.ts");
    const overrides: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isConditionalExpression(node) &&
        node.condition.getText(source).includes("callerKind") &&
        [
          node.whenTrue.getText(source),
          node.whenFalse.getText(source),
        ].includes('"yolo"')
      )
        overrides.push(node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.isEmpty(overrides);
  });
  it("does not revive the original request when a native bridge scope expires", function () {
    const source = read("src/agent/externalBackendBridge.ts");
    const staleFallbacks: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        node.left.getText(source).includes("currentMcpScope") &&
        node.right.getText(source) === "params.request"
      )
        staleFallbacks.push(node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.isEmpty(staleFallbacks);
  });
  it("checks verified action completion in both native provider owners", function () {
    const calls = (path: string, callee: string) => {
      const source = read(path);
      let found = false;
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === callee
        )
          found = true;
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    };
    // Each owner settles its turn through the one shared rule ...
    for (const path of [
      "src/codexAppServer/nativeClient.ts",
      "src/agent/externalBackendBridge.ts",
    ]) {
      assert.isTrue(calls(path, "settleExternalTurn"), path);
    }
    // ... and that rule is what verifies the turn's action contract.
    assert.isTrue(
      calls(
        "src/agent/execution/externalTurnSettlement.ts",
        "evaluatePreparedActionContract",
      ),
    );
  });
  it("supplies host execution context to every native Codex turn dispatch", function () {
    const source = read("src/modules/contextPanel/chat.ts");
    let count = 0;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "runCodexAppServerNativeTurn"
      ) {
        count++;
        const argument = node.arguments[0];
        assert.isTrue(ts.isObjectLiteralExpression(argument));
        const names = (argument as ts.ObjectLiteralExpression).properties.map(
          (p) => p.name?.getText(source),
        );
        for (const field of ["executionRequest"]) assert.include(names, field);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.isAtLeast(count, 2);
  });
  it("does not infer executable Plan effects from native provider step prose", function () {
    for (const path of [
      "src/agent/externalBackendBridge.ts",
      "src/modules/contextPanel/chat.ts",
    ]) {
      const offenders: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === "inferPlanStepEffect")
          offenders.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(read(path));
      assert.isEmpty(offenders, path);
    }
  });
  it("keeps downstream authority and routing consumers independent of raw request prose", function () {
    for (const path of [
      "src/agent/authorization/policy.ts",
      "src/agent/contracts/actionContract.ts",
    ]) {
      const offenders: string[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          ["skillClassifier", "actionIntent", "semanticIntentService"].some(
            (name) => node.moduleSpecifier.text.endsWith("/" + name),
          )
        )
          offenders.push(node.moduleSpecifier.text);
        if (
          ts.isPropertyAccessExpression(node) &&
          ["userText", "userRequest", "questionText"].includes(node.name.text)
        )
          offenders.push(node.getText());
        ts.forEachChild(node, visit);
      };
      visit(read(path));
      assert.isEmpty(offenders, path);
    }
  });
});
