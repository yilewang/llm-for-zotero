import { mineruLegacyHealth } from "../../test/helpers/mineruLegacyHealth";
import { composeRetrievalCandidateInvalidation } from "../../test/helpers/hostSurfaces";
import { assert } from "chai";
import { unzipSync } from "fflate";
import { createPdfFixture } from "../../test/helpers/pdfFixture";
import { mineruResultFixture } from "../../test/helpers/mineruResultFixture";
import {
  parsePdfWithMineru,
  publishMineruParsedResult,
} from "../../src/services/mineru/mineruParser";
import {
  MineruCancelledError,
  MineruRateLimitError,
} from "../../src/utils/mineruClient";
import { getMineruCheckpointProgress } from "../../src/services/mineru/mineruCheckpoint";
import {
  readCachedMineruMd,
  readManifest,
  invalidateMineruMd,
  getMineruItemDir,
} from "../../src/services/mineru/mineruCache";
import {
  clearAllStatuses,
  getMineruStatus,
  runMineruTaskOnce,
  setItemProcessing,
  setItemFailed,
} from "../../src/modules/mineruProcessingStatus";
import {
  ensurePDFTextCached,
  invalidateCachedContextText,
} from "../../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../../src/services/paperContent/contextCache";
import { buildMineruSyncPackageBytes } from "../../src/services/mineru/sync";
import {
  closeLibraryTextIndexDb,
  refuseLibraryTextIndexOpensForQuit,
} from "../../src/services/libraryTextIndex/db";

export type RecoveryRecord = {
  id: number;
  key: string;
  path: string;
  mode: "cancel" | "quota";
  uploads: number[];
  interruptedChunk?: number;
};
const disposeInvalidation = composeRetrievalCandidateInvalidation();
const prefix = "extensions.zotero.llmforzotero.";

/**
 * Each workflow bundle owns a separate module graph. Text invalidation can
 * enqueue an index row through this graph without starting the addon's index
 * lifecycle, so the addon's quit blocker cannot close this bundle's handle.
 * Call once from the owning suite's after hook, including failure paths.
 */
export async function disposeRecoveryScenarioResources(): Promise<void> {
  // Refuse lazy invalidation imports that have not opened their handle yet,
  // then await and close any open already in flight. Never touch Zotero.DB.
  refuseLibraryTextIndexOpensForQuit();
  try {
    await closeLibraryTextIndexDb({ throwOnError: true });
  } finally {
    disposeInvalidation();
  }
}

async function run(record: RecoveryRecord, stop: boolean) {
  const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
  const originalToolkit = (globalThis as any).ztoolkit;
  const getGlobal = toolkit.getGlobal;
  const request = Zotero.HTTP.request;
  const settings: Record<string, string | boolean | number> = {
    mineruEnabled: true,
    mineruSyncEnabled: false,
    mineruMode: record.mode === "quota" ? "cloud" : "local",
    mineruApiKey: "acceptance-fixture-key",
    mineruMaxAutoPages: 0,
    mineruForceOcr: false,
  };
  const old = new Map(
    Object.keys(settings).map((k) => [k, Zotero.Prefs.get(prefix + k, true)]),
  );
  let active = 0;
  const controller = new AbortController();
  try {
    (globalThis as any).ztoolkit = toolkit;
    for (const [k, v] of Object.entries(settings))
      Zotero.Prefs.set(prefix + k, v, true);
    toolkit.getGlobal = function (name: string) {
      if (name !== "fetch") return getGlobal.call(this, name);
      return async (url: string, init?: RequestInit) => {
        const uri = String(url);
        const health = mineruLegacyHealth(uri);
        if (health) return health;
        if (init?.method === "PUT") {
          assert.include(uri, "mineru-recovery.invalid");
          record.uploads.push(active);
          return { status: 200, ok: true };
        }
        if (uri.endsWith("/file_parse") && stop && active === 2) {
          record.interruptedChunk = active;
          // Hold a real transport call open after the first chunk was saved.
          // Cancellation must settle that request and keep the first checkpoint.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("Fixture upload interrupted")),
              { once: true },
            );
            setTimeout(() => controller.abort(), 10);
          });
        }
        if (uri.endsWith("/file_parse")) record.uploads.push(active);
        else assert.include(uri, "mineru-recovery.invalid");
        const data = mineruResultFixture(active);
        return {
          status: 200,
          ok: true,
          headers: { get: () => "application/zip" },
          arrayBuffer: async () => data.buffer,
        };
      };
    };
    (Zotero.HTTP as any).request = async (
      method: string,
      url: string,
      options: any,
    ) => {
      if (!url.startsWith("https://mineru.net/api/v4/"))
        return request.call(Zotero.HTTP, method, url, options);
      if (method === "POST") {
        if (stop && active === 2)
          return {
            status: 429,
            responseText: '{"msg":"daily quota exceeded"}',
          };
        // An invalid URL scheme makes curl fail locally; the controlled fetch
        // transport then receives the actual extracted PDF bytes.
        return {
          status: 200,
          responseText: JSON.stringify({
            data: {
              batch_id: `part-${active}`,
              file_urls: ["fixture://mineru-recovery.invalid/upload"],
            },
          }),
        };
      }
      return {
        status: 200,
        responseText: JSON.stringify({
          data: {
            extract_result: [
              {
                state: "done",
                full_zip_url: "fixture://mineru-recovery.invalid/result.zip",
              },
            ],
          },
        }),
      };
    };
    const result = await runMineruTaskOnce(
      record.id,
      async (report, signal) => {
        setItemProcessing(record.id);
        const parsed = await parsePdfWithMineru(record.path, report, signal, {
          attachmentId: record.id,
          maxPages: 0,
        });
        assert.isNotNull(parsed, "all chunks parse");
        if (!stop)
          await publishMineruParsedResult(
            Zotero.Items.get(record.id),
            parsed!,
            signal,
          );
        return parsed;
      },
      (stage) => {
        const match = /^Uploading MinerU chunk (\d+)\//.exec(stage);
        if (match) active = Number(match[1]);
      },
      controller.signal,
    );
    assert.isFalse(stop, "the requested interruption must occur");
    return result;
  } catch (error) {
    if (!stop) throw error;
    assert.instanceOf(
      error,
      record.mode === "cancel" ? MineruCancelledError : MineruRateLimitError,
    );
    setItemFailed(record.id, String(error));
    assert.deepEqual(record.uploads, [1]);
    if (record.mode === "cancel")
      assert.equal(
        record.interruptedChunk,
        2,
        "cancel happens while chunk 2 is in flight",
      );
    assert.isNull(await readCachedMineruMd(record.id));
    assert.isNull(await readManifest(record.id));
    assert.deepEqual(await getMineruCheckpointProgress(record.id), {
      completedPages: 200,
      totalPages: 401,
      completedChunks: 1,
      totalChunks: 3,
    });
    assert.equal(await getMineruStatus(record.id), "partial");
    assert.isNull(
      await buildMineruSyncPackageBytes(Zotero.Items.get(record.id)),
    );
  } finally {
    toolkit.getGlobal = getGlobal;
    (Zotero.HTTP as any).request = request;
    (globalThis as any).ztoolkit = originalToolkit;
    for (const [k, v] of old) {
      if (v === undefined) Zotero.Prefs.clear(prefix + k, true);
      else Zotero.Prefs.set(prefix + k, v, true);
    }
  }
}

export async function interruptRecoveryScenario(
  mode: RecoveryRecord["mode"],
): Promise<RecoveryRecord> {
  const path = PathUtils.join(
    Zotero.DataDirectory.dir,
    `mineru-recovery-${mode}-${Date.now()}.pdf`,
  );
  await (globalThis as any).IOUtils.write(path, createPdfFixture(401));
  const item = await Zotero.Attachments.linkFromFile({
    file: path,
    contentType: "application/pdf",
  });
  item.setField("title", `MinerU recovery acceptance (${mode})`);
  await item.saveTx();
  const record = { id: item.id, key: item.key, path, mode, uploads: [] };
  await run(record, true);
  return record;
}

export async function resumeRecoveryScenario(
  record: RecoveryRecord,
): Promise<void> {
  clearAllStatuses();
  assert.equal(
    Zotero.Items.get(record.id).key,
    record.key,
    "native attachment identity survives restart",
  );
  assert.equal(
    await getMineruStatus(record.id),
    "partial",
    "durable status needs no in-memory task",
  );
  await run(record, false);
  await verifyRecoveryScenario(record);
}

export async function verifyRecoveryScenario(
  record: RecoveryRecord,
): Promise<void> {
  clearAllStatuses();
  assert.deepEqual(
    record.uploads,
    [1, 2, 3],
    "only unfinished chunks upload after restart",
  );
  assert.equal(await getMineruStatus(record.id), "cached");
  assert.isNull(await getMineruCheckpointProgress(record.id));
  const io = (globalThis as any).IOUtils;
  const root = getMineruItemDir(record.id);
  const md = new TextDecoder().decode(
    await io.read(PathUtils.join(root, "full.md")),
  );
  const manifest = JSON.parse(
    new TextDecoder().decode(
      await io.read(PathUtils.join(root, "manifest.json")),
    ),
  );
  assert.equal(manifest.totalPages, 401);
  assert.equal(manifest.totalChars, md.length);
  assert.deepEqual(
    manifest.sections.map((s: any) => s.page),
    [0, 200, 400],
  );
  assert.deepEqual(
    manifest.allFigures.map((f: any) => f.page),
    [0, 200, 400],
  );
  assert.deepEqual(
    manifest.allTables.map((f: any) => f.page),
    [0, 200, 400],
  );
  for (const [i, s] of manifest.sections.entries()) {
    assert.include(md.slice(s.charStart, s.charEnd), `CHUNK ${i + 1} START`);
    assert.include(md.slice(s.charStart, s.charEnd), `CHUNK ${i + 1} END`);
  }
  const content = JSON.parse(
    new TextDecoder().decode(
      await io.read(PathUtils.join(root, "content_list.json")),
    ),
  );
  const figures = content.filter((e: any) => e.type === "image");
  assert.equal(new Set(figures.map((e: any) => e.img_path)).size, 3);
  for (const [i, figure] of figures.entries())
    assert.equal(
      (await io.read(PathUtils.join(root, ...figure.img_path.split("/"))))[4],
      i + 1,
    );
  const enabled = Zotero.Prefs.get(prefix + "mineruEnabled", true);
  Zotero.Prefs.set(prefix + "mineruEnabled", true, true);
  const original = (globalThis as any).ztoolkit;
  (globalThis as any).ztoolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
  try {
    invalidateCachedContextText(record.id);
    await ensurePDFTextCached(Zotero.Items.get(record.id), {
      sourceMode: "mineru",
    });
    const context = pdfTextCache.get(record.id)!;
    assert.equal(context.sourceType, "mineru");
    for (const part of [1, 2, 3]) {
      const chunk = context.chunkMeta!.find((c) =>
        c.text.includes(`CHUNK ${part} START`),
      );
      assert.isOk(chunk, "agent/chat retrieval includes each chapter");
      assert.equal(chunk!.pageStart, (part - 1) * 200);
    }
    const archive = unzipSync(
      (await buildMineruSyncPackageBytes(Zotero.Items.get(record.id)))!,
    );
    assert.equal(new TextDecoder().decode(archive["full.md"]), md);
    assert.deepEqual(
      JSON.parse(new TextDecoder().decode(archive["manifest.json"])),
      manifest,
    );
  } finally {
    (globalThis as any).ztoolkit = original;
    if (enabled === undefined)
      Zotero.Prefs.clear(prefix + "mineruEnabled", true);
    else Zotero.Prefs.set(prefix + "mineruEnabled", enabled, true);
  }
}

export async function cleanupRecoveryScenario(
  record: RecoveryRecord,
): Promise<void> {
  invalidateCachedContextText(record.id);
  await invalidateMineruMd(record.id);
  await Zotero.Items.get(record.id)?.eraseTx();
  await (globalThis as any).IOUtils.remove(record.path, { ignoreAbsent: true });
  clearAllStatuses();
}
