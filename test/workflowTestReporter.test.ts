import { assert } from "chai";
import {
  GENERATED_WORKFLOW_REPORTER_SCRIPT_FILENAME,
  patchWorkflowTestReporterSource,
  WORKFLOW_TEST_ERROR_SERIALIZER_SOURCE,
} from "../scripts/workflow-test-reporter.mjs";

const RAW_FAILURE_PAYLOAD =
  'await send({ type: "fail", data: { title: test.title, fulltest: test.fullTitle(), duration: test.duration, error, indents: indents + 1 } });';
const SEND_FUNCTION_ANCHOR = "async function send(data) {";

function generatedReporterSource(): string {
  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
    <!-- Setup Mocha -->
    <script>
async function send(data) {
  return data;
}

function Reporter(runner) {
  runner.on("fail", async function (test, error) {
    ${RAW_FAILURE_PAYLOAD}
  });
}
    </script>
</body>
</html>`;
}

function loadGeneratedSerializer(): (error: unknown) => {
  name: string;
  message: string;
  stack: string;
  actual: unknown;
  expected: unknown;
  operator: unknown;
} {
  return new Function(
    `${WORKFLOW_TEST_ERROR_SERIALIZER_SOURCE}\nreturn serializeWorkflowTestError;`,
  )() as ReturnType<typeof loadGeneratedSerializer>;
}

describe("workflow test reporter patch", function () {
  it("serializes native Error diagnostics that JSON.stringify would drop", function () {
    const serialize = loadGeneratedSerializer();
    const error = new Error("conversation provisioning failed");
    error.stack = "workflowTestHarness.ts:2003";

    const serialized = serialize(error);

    assert.equal(serialized.name, "Error");
    assert.include(serialized.message, "conversation provisioning failed");
    assert.include(serialized.message, "workflowTestHarness.ts:2003");
    assert.equal(serialized.stack, "workflowTestHarness.ts:2003");
    assert.equal(serialized.actual, "<not available>");
    assert.equal(serialized.expected, "<not available>");
  });

  it("preserves assertion fields including explicit undefined values", function () {
    const serialize = loadGeneratedSerializer();
    const error = Object.assign(new Error("values differ"), {
      actual: undefined,
      expected: undefined,
      operator: "strictEqual",
    });

    const serialized = serialize(error);

    assert.equal(serialized.actual, "<undefined>");
    assert.equal(serialized.expected, "<undefined>");
    assert.equal(serialized.operator, "strictEqual");
  });

  it("patches the generated reporter once and remains idempotent", function () {
    const source = generatedReporterSource();
    const patched = patchWorkflowTestReporterSource(source);

    assert.include(
      patched,
      `<script src="${GENERATED_WORKFLOW_REPORTER_SCRIPT_FILENAME}"></script>`,
    );
    assert.include(patched, "error: serializeWorkflowTestError(error)");
    assert.notInclude(patched, RAW_FAILURE_PAYLOAD);
    assert.equal(patchWorkflowTestReporterSource(patched), patched);
  });

  it("keeps the serializer out of the generated XHTML inline script", function () {
    const patched = patchWorkflowTestReporterSource(generatedReporterSource());

    assert.notInclude(patched, WORKFLOW_TEST_ERROR_SERIALIZER_SOURCE);
    assert.isBelow(
      patched.indexOf(GENERATED_WORKFLOW_REPORTER_SCRIPT_FILENAME),
      patched.indexOf("<!-- Setup Mocha -->"),
    );
  });

  it("upgrades an unsafe bare serializer left by an interrupted run", function () {
    const unsafe = generatedReporterSource()
      .replace(
        SEND_FUNCTION_ANCHOR,
        `${WORKFLOW_TEST_ERROR_SERIALIZER_SOURCE}\n\n${SEND_FUNCTION_ANCHOR}`,
      )
      .replace(
        RAW_FAILURE_PAYLOAD,
        RAW_FAILURE_PAYLOAD.replace(
          "error,",
          "error: serializeWorkflowTestError(error),",
        ),
      );

    const patched = patchWorkflowTestReporterSource(unsafe);

    assert.notInclude(patched, WORKFLOW_TEST_ERROR_SERIALIZER_SOURCE);
    assert.include(
      patched,
      `<script src="${GENERATED_WORKFLOW_REPORTER_SCRIPT_FILENAME}"></script>`,
    );
    assert.equal(patchWorkflowTestReporterSource(patched), patched);
  });

  it("fails loudly when scaffold changes the reporter contract", function () {
    assert.throws(
      () =>
        patchWorkflowTestReporterSource(
          generatedReporterSource().replace(RAW_FAILURE_PAYLOAD, ""),
        ),
      "failure payload was not found",
    );
  });
});
