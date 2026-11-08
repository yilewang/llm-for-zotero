import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFileTraceStore } from "../src/trace-store/trace-store.js";

describe("JsonFileTraceStore", () => {
  it("appends records in jsonl format and lists them back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-store-"));
    const filePath = join(dir, "trace.jsonl");
    const store = new JsonFileTraceStore(filePath);

    await store.append({
      runId: "run-1",
      conversationKey: "conv-1",
      event: { type: "status", ts: 1, payload: { text: "hello" } },
    });
    await store.append({
      runId: "run-1",
      conversationKey: "conv-1",
      event: { type: "final", ts: 2, payload: { output: "done" } },
    });
    await store.flush?.();

    const raw = await readFile(filePath, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);

    const records = await store.list("conv-1");
    expect(records).toHaveLength(2);
    expect(records[0]?.event.type).toBe("status");
    expect(records[1]?.event.type).toBe("final");
  });

  it("clears one conversation without removing others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-store-"));
    const filePath = join(dir, "trace.jsonl");
    const store = new JsonFileTraceStore(filePath);

    await store.append({
      runId: "run-a",
      conversationKey: "conv-a",
      event: { type: "status", ts: 1, payload: { text: "a" } },
    });
    await store.append({
      runId: "run-b",
      conversationKey: "conv-b",
      event: { type: "status", ts: 2, payload: { text: "b" } },
    });
    await store.flush?.();

    await store.clear("conv-a");

    expect(await store.list("conv-a")).toHaveLength(0);
    expect(await store.list("conv-b")).toHaveLength(1);
  });

  it("reads legacy json-array trace files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-store-"));
    const filePath = join(dir, "trace.json");
    await writeFile(
      filePath,
      JSON.stringify([
        {
          runId: "run-legacy",
          conversationKey: "conv-legacy",
          event: { type: "status", ts: 1, payload: { text: "legacy" } },
        },
      ]),
      "utf8",
    );

    const store = new JsonFileTraceStore(filePath);
    const records = await store.list("conv-legacy");
    expect(records).toHaveLength(1);
    expect(records[0]?.runId).toBe("run-legacy");
  });

  it("migrates legacy json-array files to pure jsonl before appending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-store-"));
    const filePath = join(dir, "trace.json");
    await writeFile(
      filePath,
      JSON.stringify([
        {
          runId: "run-legacy",
          conversationKey: "conv-legacy",
          event: { type: "status", ts: 1, payload: { text: "legacy" } },
        },
      ]),
      "utf8",
    );

    const store = new JsonFileTraceStore(filePath);
    await store.append({
      runId: "run-new",
      conversationKey: "conv-legacy",
      event: { type: "final", ts: 2, payload: { output: "done" } },
    });
    await store.flush?.();

    const raw = await readFile(filePath, "utf8");
    expect(raw.trim().startsWith("[")).toBe(false);
    expect(raw.trim().split("\n")).toHaveLength(2);

    const backup = await readFile(`${filePath}.legacy-array`, "utf8");
    expect(backup.trim().startsWith("[")).toBe(true);

    const records = await store.list("conv-legacy");
    expect(records.map((record) => record.runId)).toEqual([
      "run-legacy",
      "run-new",
    ]);
  });
});
