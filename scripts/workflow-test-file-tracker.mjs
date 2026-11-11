import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Per-file results for the workflow runner. Every selected test file runs in
// one Zotero, and the scaffold prints test titles without their file. This
// patch tags each file's suites and root hooks as the test page loads them,
// then sends one marker line per test result, file start and file end through
// the scaffold's debug channel. scripts/run-workflow-tests.mjs reads the
// markers to say which files passed, failed, were skipped or never ran.

export const WORKFLOW_FILE_MARKER = "@@workflow-file";
export const GENERATED_TEST_PAGE_PATH =
  ".scaffold/test/resource/content/index.xhtml";
export const FILE_TRACKER_SCRIPT_FILENAME = "workflow-test-file-tracker.js";

const UNIT_TESTS_ANCHOR = "    <!-- Unit tests -->";
const TRACKER_SCRIPT_TAG = `    <!-- Report each workflow test file's results to the runner. -->
    <script src="${FILE_TRACKER_SCRIPT_FILENAME}"></script>

`;
const END_PAYLOAD = `    await send({
      type: "end",`;
// Marker sends are not awaited by mocha; the run must not quit before they land.
const FLUSHED_END_PAYLOAD = `    await workflowFileFlush();
${END_PAYLOAD}`;
const UNIT_SCRIPT = /^([ \t]*)<script src="(units\/[^"]+)"><\/script>$/gm;

export const FILE_TRACKER_SOURCE = `const workflowFilePending = new Set();

function workflowFileSend(data) {
  const message = "${WORKFLOW_FILE_MARKER} " + JSON.stringify(data);
  const request = send({ type: "debug", data: message }).catch(() => null);
  workflowFilePending.add(request);
  request.finally(() => workflowFilePending.delete(request));
}

function workflowFileFlush() {
  return Promise.allSettled([...workflowFilePending]);
}

// Runs right after each unit script: whatever that script added at the root
// belongs to it.
function workflowTagFile(unit) {
  const root = mocha.suite;
  for (const node of [
    ...root.suites,
    ...root.tests,
    ...root._beforeAll,
    ...root._afterAll,
    ...root._beforeEach,
    ...root._afterEach,
  ]) {
    if (node.workflowFile === undefined) node.workflowFile = unit;
  }
}

function workflowFileOf(runnable) {
  let node = runnable;
  while (node.parent && !node.parent.root) node = node.parent;
  return node.workflowFile ?? null;
}

function workflowFirstLine(error) {
  const text = String((error && error.message) || error || "Unknown error");
  const line = text.split("\\n").find((part) => part.trim()) ?? text;
  return line.length > 300 ? line.slice(0, 297) + "..." : line;
}

function workflowTrackFiles(runner) {
  const isTopSuite = (suite) => suite.parent && suite.parent.root;
  // How many tests each file registered, so a file that never starts can be
  // told apart from a file that has no tests in this run.
  runner.on("start", () => {
    const planned = {};
    for (const unit of new Set(
      [...mocha.suite.suites, ...mocha.suite.tests].map((n) => n.workflowFile),
    ))
      if (unit) planned[unit] = 0;
    for (const suite of mocha.suite.suites)
      if (suite.workflowFile) planned[suite.workflowFile] += suite.total();
    for (const test of mocha.suite.tests)
      if (test.workflowFile) planned[test.workflowFile] += 1;
    workflowFileSend({ event: "plan", planned });
  });
  runner.on("suite", (suite) => {
    if (isTopSuite(suite) && suite.workflowFile)
      workflowFileSend({ event: "start", unit: suite.workflowFile });
  });
  runner.on("suite end", (suite) => {
    if (isTopSuite(suite) && suite.workflowFile)
      workflowFileSend({ event: "end", unit: suite.workflowFile });
  });
  for (const result of ["pass", "pending"]) {
    runner.on(result, (test) =>
      workflowFileSend({ event: result, unit: workflowFileOf(test) }),
    );
  }
  runner.on("fail", (test, error) =>
    workflowFileSend({
      event: "fail",
      unit: workflowFileOf(test),
      title: test.fullTitle(),
      message: workflowFirstLine(error),
    }),
  );
}

(function () {
  const reporter = mocha._reporter;
  mocha.reporter(function WorkflowFileReporter(runner, options) {
    const base = new reporter(runner, options);
    workflowTrackFiles(runner);
    return base;
  });
})();`;

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0)
    throw new Error(`Unable to add workflow file tracking: ${label}`);
  return source.replace(search, replacement);
}

export function patchFileTrackerSource(source) {
  if (source.includes(TRACKER_SCRIPT_TAG)) return source;
  let patched = replaceOnce(
    source,
    UNIT_TESTS_ANCHOR,
    `${TRACKER_SCRIPT_TAG}${UNIT_TESTS_ANCHOR}`,
    "unit test anchor not found once",
  );
  patched = replaceOnce(
    patched,
    END_PAYLOAD,
    FLUSHED_END_PAYLOAD,
    "end payload not found once",
  );
  return patched.replace(
    UNIT_SCRIPT,
    (tag, indent, unit) =>
      `${tag}\n${indent}<script>workflowTagFile("${unit}");</script>`,
  );
}

export async function patchGeneratedFileTracker(
  path = GENERATED_TEST_PAGE_PATH,
) {
  const source = await readFile(path, "utf8");
  await writeFile(
    join(dirname(path), FILE_TRACKER_SCRIPT_FILENAME),
    `${FILE_TRACKER_SOURCE}\n`,
    "utf8",
  );
  const patched = patchFileTrackerSource(source);
  if (patched !== source) await writeFile(path, patched, "utf8");
}

/** The marker in one output line, or null. */
export function readFileMarker(line) {
  const at = line.indexOf(`${WORKFLOW_FILE_MARKER} {`);
  if (at < 0) return null;
  try {
    return JSON.parse(line.slice(at + WORKFLOW_FILE_MARKER.length + 1).trim());
  } catch {
    return null;
  }
}

/** "units/foo/bar.workflow.test.js" -> "foo/bar.workflow.test" */
export function unitStem(unit) {
  return unit.replace(/^units\//, "").replace(/\.[jt]s$/, "");
}
