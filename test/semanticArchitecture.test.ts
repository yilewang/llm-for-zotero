import { assert } from "chai";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

describe("semantic ownership boundary", function () {
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
    for (const path of [
      "src/codexAppServer/nativeClient.ts",
      "src/agent/externalBackendBridge.ts",
    ]) {
      const source = read(path);
      let found = false;
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === "evaluatePreparedActionContract"
        )
          found = true;
        ts.forEachChild(node, visit);
      };
      visit(source);
      assert.isTrue(found, path);
    }
  });
  it("supplies semantic authority to every native Codex turn dispatch", function () {
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
        for (const field of ["semanticRequest"]) assert.include(names, field);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.isAtLeast(count, 2);
  });
  it("does not infer executable Plan effects from native provider step prose", function () {
    for (const path of [
      "src/agent/plans/coordinator.ts",
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
      "src/agent/model/requestClassifier.ts",
      "src/agent/documents/outcomePolicy.ts",
      "src/agent/skills/noteIntent.ts",
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
