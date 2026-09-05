import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const GENERATED_WORKFLOW_REPORTER_PATH =
  ".scaffold/test/resource/content/index.xhtml";

export const GENERATED_WORKFLOW_REPORTER_SCRIPT_FILENAME =
  "workflow-test-error-serializer.js";

const SETUP_SCRIPT_ANCHOR = "    <!-- Setup Mocha -->";
const SERIALIZER_SCRIPT_TAG = `    <!-- Preserve workflow Error diagnostics across JSON transport. -->
    <script src="${GENERATED_WORKFLOW_REPORTER_SCRIPT_FILENAME}"></script>

`;
const RAW_FAILURE_PAYLOAD =
  'await send({ type: "fail", data: { title: test.title, fulltest: test.fullTitle(), duration: test.duration, error, indents: indents + 1 } });';
const SERIALIZED_FAILURE_PAYLOAD =
  'await send({ type: "fail", data: { title: test.title, fulltest: test.fullTitle(), duration: test.duration, error: serializeWorkflowTestError(error), indents: indents + 1 } });';

export const WORKFLOW_TEST_ERROR_SERIALIZER_SOURCE = `function serializeWorkflowTestError(error) {
  const objectError =
    error !== null &&
    (typeof error === "object" || typeof error === "function")
      ? error
      : null;
  const rawMessage =
    objectError &&
    typeof objectError.message === "string" &&
    objectError.message
      ? objectError.message
      : String(error ?? "Unknown workflow test error");
  const stack =
    objectError && typeof objectError.stack === "string"
      ? objectError.stack.trim()
      : "";
  const message = stack
    ? stack.includes(rawMessage)
      ? stack
      : rawMessage + "\\n" + stack
    : rawMessage;
  const readField = (name) => {
    if (!objectError || !(name in objectError)) return "<not available>";
    const value = objectError[name];
    return value === undefined ? "<undefined>" : value;
  };
  return {
    name:
      objectError && typeof objectError.name === "string"
        ? objectError.name
        : "Error",
    message,
    stack,
    actual: readField("actual"),
    expected: readField("expected"),
    operator: readField("operator"),
  };
}`;

const LEGACY_XHTML_SERIALIZER_SOURCE = `// <![CDATA[
${WORKFLOW_TEST_ERROR_SERIALIZER_SOURCE}
// ]]>`;

function replaceExactlyOnce(source, search, replacement, label) {
  const firstIndex = source.indexOf(search);
  if (firstIndex < 0) {
    throw new Error(
      `Unable to patch workflow reporter: ${label} was not found`,
    );
  }
  if (source.indexOf(search, firstIndex + search.length) >= 0) {
    throw new Error(
      `Unable to patch workflow reporter: ${label} was ambiguous`,
    );
  }
  return source.replace(search, replacement);
}

export function patchWorkflowTestReporterSource(source) {
  let patched = source;
  for (const legacySerializer of [
    `${LEGACY_XHTML_SERIALIZER_SOURCE}\n\n`,
    `${WORKFLOW_TEST_ERROR_SERIALIZER_SOURCE}\n\n`,
  ]) {
    if (patched.includes(legacySerializer)) {
      patched = replaceExactlyOnce(
        patched,
        legacySerializer,
        "",
        "legacy inline serializer",
      );
    }
  }

  const hasSerializerScript = patched.includes(SERIALIZER_SCRIPT_TAG);
  const hasSerializedPayload = source.includes(SERIALIZED_FAILURE_PAYLOAD);
  const hasRawPayload = source.includes(RAW_FAILURE_PAYLOAD);
  if (hasSerializedPayload && hasRawPayload) {
    throw new Error(
      "Unable to patch workflow reporter: failure payload was ambiguous",
    );
  }

  if (!hasSerializerScript) {
    patched = replaceExactlyOnce(
      patched,
      SETUP_SCRIPT_ANCHOR,
      `${SERIALIZER_SCRIPT_TAG}${SETUP_SCRIPT_ANCHOR}`,
      "setup script anchor",
    );
  }
  if (!hasSerializedPayload) {
    patched = replaceExactlyOnce(
      patched,
      RAW_FAILURE_PAYLOAD,
      SERIALIZED_FAILURE_PAYLOAD,
      "failure payload",
    );
  }
  return patched;
}

export async function patchGeneratedWorkflowTestReporter(
  path = GENERATED_WORKFLOW_REPORTER_PATH,
) {
  const source = await readFile(path, "utf8");
  const patched = patchWorkflowTestReporterSource(source);
  await writeFile(
    join(dirname(path), GENERATED_WORKFLOW_REPORTER_SCRIPT_FILENAME),
    `${WORKFLOW_TEST_ERROR_SERIALIZER_SOURCE}\n`,
    "utf8",
  );
  if (patched !== source) await writeFile(path, patched, "utf8");
}
