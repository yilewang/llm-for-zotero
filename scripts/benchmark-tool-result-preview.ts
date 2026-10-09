import { assert } from "chai";
import {
  buildToolResultPreview,
  PREVIEW_MAX_BYTES,
} from "../src/agent/store/truncatedToolResult";
import {
  previewListing,
  previewRows,
} from "../test/helpers/toolResultPreviewPerformance";

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

// This entry point runs in its own process, never through the unit harness.
// Reject timing under the work observers instead of reporting distorted costs.
const nativeBuiltins = {
  "JSON.stringify": JSON.stringify,
  "Object.entries": Object.entries,
  "Object.values": Object.values,
  "String.prototype.slice": String.prototype.slice,
};
for (const [name, implementation] of Object.entries(nativeBuiltins)) {
  assert.match(
    Function.prototype.toString.call(implementation),
    /\{\s*\[native code\]\s*\}/,
    `${name} must be uninstrumented for performance validation`,
  );
}

const cases = [
  { name: "3,000 rows", content: previewRows(3_000), limit: 50 },
  { name: "1,000 rows", content: previewRows(1_000), limit: undefined },
  { name: "1,000 items", content: previewListing(1_000), limit: 30 },
];
const originals = cases.map(({ content }) => JSON.stringify(content));
const samples = cases.map(() => ({
  runs: [] as number[],
  preview: undefined as unknown,
}));
const forward = cases.map((_, index) => index);
const backward = [...forward].reverse();
// Fixed, equally warmed rounds; run separately from the unit suite and
// other heavy validation. The deterministic unit test also checks traversal
// work, while this clean process retains an independent end-to-end scaling
// guard.
for (let round = 0; round < 8; round += 1) {
  for (const index of round % 2 === 0 ? forward : backward) {
    buildToolResultPreview(cases[index].content);
  }
}
for (let round = 0; round < 8; round += 1) {
  for (const index of round % 2 === 0 ? forward : backward) {
    const start = performance.now();
    const preview = buildToolResultPreview(cases[index].content);
    samples[index].runs.push(performance.now() - start);
    samples[index].preview = preview;
  }
}
const results = samples.map((sample, index) => ({
  name: cases[index].name,
  limit: cases[index].limit,
  ms: median(sample.runs),
  runs: sample.runs,
}));
const pairedRatios = samples[0].runs.map(
  (ms, index) => ms / Math.max(samples[1].runs[index], 0.25),
);
console.log(
  JSON.stringify({
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    nativeBuiltins: Object.keys(nativeBuiltins),
    warmupRounds: 8,
    measuredRounds: 8,
    results,
  }),
);
for (const { name, limit, ms } of results) {
  if (limit !== undefined)
    assert.isBelow(ms, limit, `${name} took ${ms.toFixed(1)} ms`);
}
assert.isBelow(
  median(pairedRatios),
  5,
  `paired 3,000/1,000-row ratios ${pairedRatios
    .map((ratio) => ratio.toFixed(2))
    .join(", ")}`,
);
for (const [index, { preview }] of samples.entries()) {
  assert.exists(preview);
  assert.isAtMost(JSON.stringify(preview).length, PREVIEW_MAX_BYTES);
  assert.equal(JSON.stringify(cases[index].content), originals[index]);
}
console.log(
  "Preview performance validation passed (50 ms / 30 ms / <5x scaling).",
);
