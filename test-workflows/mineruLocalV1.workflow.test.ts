import { assert } from "chai";
import { createPdfFixture } from "../test/helpers/pdfFixture";
import { createMineruV1Zip } from "../test/helpers/mineruV1Fixture";
import {
  parsePdfWithMineru,
  publishMineruParsedResult,
} from "../src/services/mineru/mineruParser";
import {
  readCachedMineruMd,
  readManifest,
  getMineruItemDir,
} from "../src/services/mineru/mineruCache";
import { bindMineruLocalPreferences } from "../src/modules/mineruLocalPreferences";
import { getMineruLocalOptions } from "../src/utils/mineruConfig";
import { testMineruLocalConnection } from "../src/utils/mineruClient";
import {
  setMineruV1TimingForTests,
  type MineruLocalService,
} from "../src/utils/mineruLocalClient";
import { composeRetrievalCandidateInvalidation } from "../test/helpers/hostSurfaces";

const prefix = "extensions.zotero.llmforzotero.";
describe("workflow: local MinerU V1", function () {
  it("publishes V1 results into native Zotero storage and reopens figure/page metadata", async function () {
    const io = (globalThis as any).IOUtils;
    const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const oldToolkit = (globalThis as any).ztoolkit;
    const getGlobal = toolkit.getGlobal;
    const settings = {
      mineruMode: "local",
      mineruLocalTier: "flash",
      mineruLocalApiBase: "http://127.0.0.1:18746",
      mineruSyncEnabled: false,
      libraryTextIndexEnabled: false,
    };
    const old = Object.fromEntries(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(prefix + key, true),
      ]),
    );
    const source = PathUtils.join(
      Zotero.DataDirectory.dir,
      "mineru-v1-test.pdf",
    );
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "MinerU V1 compatibility fixture");
    await parent.saveTx();
    await io.write(source, createPdfFixture(2));
    const pdf = await Zotero.Attachments.linkFromFile({
      file: source,
      parentItemID: parent.id,
      contentType: "application/pdf",
    });
    const restoreInvalidator = composeRetrievalCandidateInvalidation();
    try {
      for (const [key, value] of Object.entries(settings))
        Zotero.Prefs.set(prefix + key, value, true);
      (globalThis as any).ztoolkit = toolkit;
      toolkit.getGlobal = function (name: string) {
        if (name !== "fetch") return getGlobal.call(this, name);
        return async (url: string) => {
          let body: unknown;
          if (url.endsWith("/health"))
            body = {
              status: "ok",
              version: "4.0.6",
              features: { sources: ["file_id"], output_formats: ["zip"] },
            };
          else if (url.endsWith("/tiers")) body = { data: [{ id: "flash" }] };
          else if (url.endsWith("/uploads"))
            body = {
              id: "upload-1",
              status: "completed",
              file: { id: "input-1" },
            };
          else if (url.endsWith("/jobs"))
            body = {
              job_id: "job-1",
              status: "completed",
              files: [
                {
                  file_id: "input-1",
                  status: "completed",
                  output_files: { zip: { file_id: "zip-1" } },
                },
              ],
            };
          else if (url.endsWith("/content"))
            return {
              ok: true,
              status: 200,
              arrayBuffer: async () => createMineruV1Zip().buffer,
            };
          else throw new Error(`Unexpected request ${url}`);
          return { ok: true, status: 200, json: async () => body };
        };
      };
      const result = await parsePdfWithMineru(source, undefined, undefined, {
        attachmentId: pdf.id,
      });
      assert.isNotNull(result);
      assert.equal(result!.pageCount, 2);
      await publishMineruParsedResult(pdf, result!);
      assert.include(await readCachedMineruMd(pdf.id), "Second page.");
      const manifest = await readManifest(pdf.id);
      assert.equal(manifest!.totalPages, 2);
      assert.equal(manifest!.sections[0].figures[0].page, 0);
      assert.equal(manifest!.sections[0].tables[0].caption, "Table 1. Counts.");
      assert.isTrue(
        await io.exists(
          PathUtils.join(getMineruItemDir(pdf.id), "images", "figure.png"),
        ),
      );
    } finally {
      toolkit.getGlobal = getGlobal;
      (globalThis as any).ztoolkit = oldToolkit;
      restoreInvalidator();
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, value as any, true);
      }
      await parent.eraseTx();
      await io.remove(source, { ignoreAbsent: true });
      await io.remove(getMineruItemDir(pdf.id), {
        recursive: true,
        ignoreAbsent: true,
      });
    }
  });
  it("persists local controls and switches visible options after API detection", async function () {
    const win = Zotero.getMainWindow();
    const doc =
      win.document.implementation.createHTMLDocument("MinerU controls");
    const container = doc.createElement("div");
    doc.body.append(container);
    const add = (tag: string, id: string) => {
      const element = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      element.id = `llmforzotero-mineru-${id}`;
      container.append(element);
      return element;
    };
    add("div", "legacy-options");
    add("div", "v1-options");
    const tierInput = add("select", "local-tier");
    for (const value of ["auto", "flash", "standard"]) {
      const option = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "option",
      );
      option.setAttribute("value", value);
      option.textContent = value;
      tierInput.append(option);
    }
    add("input", "local-imageAnalysis").setAttribute("type", "checkbox");
    add("span", "local-service");
    const keys = ["mineruLocalTier", "mineruLocalImageAnalysis"];
    const old = keys.map((key) => Zotero.Prefs.get(prefix + key, true));
    try {
      Zotero.Prefs.set(prefix + "mineruLocalTier", "auto", true);
      let changes = 0;
      const update = bindMineruLocalPreferences(doc, () => changes++);
      const flashOnly: MineruLocalService = {
        api: "v1",
        protocol: "jobs",
        version: "4.0.10",
        tiers: ["flash"],
      };
      update(flashOnly);
      assert.equal(
        doc.getElementById("llmforzotero-mineru-legacy-options")!.style.display,
        "none",
      );
      const status = doc.getElementById("llmforzotero-mineru-local-service")!;
      assert.equal(
        status.textContent,
        "MinerU 4.0.10 (V1) · tiers: flash · Auto will use flash (fastest)",
      );
      const tier = doc.getElementById(
        "llmforzotero-mineru-local-tier",
      ) as HTMLSelectElement;
      tier.value = "flash";
      tier.dispatchEvent(new win.Event("change"));
      assert.equal(getMineruLocalOptions().tier, "flash");
      assert.equal(changes, 1);
      assert.isTrue((tier.options[2] as HTMLOptionElement).disabled);
      assert.equal(
        status.textContent,
        "MinerU 4.0.10 (V1) · tiers: flash · flash (fastest) will be used",
      );
      // A saved tier the server lacks stays saved; the status names the fallback.
      tier.value = "standard";
      tier.dispatchEvent(new win.Event("change"));
      update(flashOnly);
      assert.equal(getMineruLocalOptions().tier, "standard");
      assert.equal(tier.value, "standard");
      assert.equal(
        status.textContent,
        "MinerU 4.0.10 (V1) · tiers: flash · standard isn't offered; flash (fastest) will be used",
      );
      update({
        api: "v1",
        protocol: "jobs",
        version: "4.0.10",
        tiers: ["flash", "basic", "standard", "advanced"],
      });
      assert.equal(
        status.textContent,
        "MinerU 4.0.10 (V1) · tiers: flash, basic, standard, advanced · standard (full models) will be used",
      );
      update({ api: "legacy", version: "3.4.5" });
      assert.equal(
        doc.getElementById("llmforzotero-mineru-v1-options")!.style.display,
        "none",
      );
      assert.equal(status.textContent, "MinerU 3.4.5 (Legacy API)");
      const shipped = (await Zotero.File.getContentsFromURLAsync(
        "chrome://llmforzotero/content/preferences.xhtml",
      )) as string;
      assert.include(
        shipped,
        '<html:option value="auto">Auto (best available)</html:option>',
      );
    } finally {
      keys.forEach((key, index) => {
        if (old[index] === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, old[index] as any, true);
      });
    }
  });
});

describe("workflow: local MinerU 4.1 Tasks", function () {
  const apiBase = "http://127.0.0.1:18746";
  const taskHealth = {
    status: "ok",
    version: "4.1.7",
    features: {
      webhook: false,
      task_output_formats: ["default", "docx", "html", "latex"],
      sources: ["upload", "url"],
    },
  };
  /** A MinerU 4.1 server fake: create, one PUT, poll, download. */
  const tasksFetch = (requests: Array<{ url: string; method: string }>) => {
    const reply = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    let polls = 0;
    return async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/v1/health")) return reply(taskHealth);
      if (url.endsWith("/v1/tiers"))
        return reply({ data: [{ id: "flash" }, { id: "basic" }] });
      if (url.endsWith("/v1/tasks") && method === "POST")
        return reply(
          {
            task_id: "job_1",
            status: "waiting-file",
            files: [
              {
                file_id: "file-1",
                file_name: "upload.pdf",
                status: "waiting-file",
                upload: {
                  url: `${apiBase}/v1/tasks/job_1/uploads/file-1`,
                  headers: { "Content-Type": "application/octet-stream" },
                  expires_at: 1800003600,
                },
              },
            ],
          },
          202,
        );
      if (method === "PUT")
        return reply({
          task_id: "job_1",
          file_id: "file-1",
          status: "pending",
        });
      if (url.endsWith("/v1/tasks/job_1"))
        return reply({
          task_id: "job_1",
          status: ++polls === 1 ? "running" : "completed",
          created_at: "2026-10-28T00:00:00Z",
          output_formats: ["default"],
          progress: { completed: polls === 1 ? 0 : 1, failed: 0, total: 1 },
          files: [
            {
              file_id: "file-1",
              file_name: "upload.pdf",
              status: polls === 1 ? "running" : "completed",
              ...(polls === 1
                ? {}
                : {
                    parse: { tier: "basic" },
                    result_url: `${apiBase}/v1/files/file-1/content`,
                  }),
            },
          ],
        });
      if (url.endsWith("/v1/files/file-1/content"))
        return {
          ok: true,
          status: 200,
          // The 4.1 default ZIP has an empty images/ directory entry.
          arrayBuffer: async () =>
            createMineruV1Zip(undefined, { "images/": new Uint8Array(0) })
              .buffer,
        };
      throw new Error(`Unexpected request ${method} ${url}`);
    };
  };

  it("publishes 4.1 Tasks results into native Zotero storage and reopens figure/page metadata", async function () {
    const io = (globalThis as any).IOUtils;
    const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const oldToolkit = (globalThis as any).ztoolkit;
    const getGlobal = toolkit.getGlobal;
    const settings = {
      mineruMode: "local",
      mineruLocalTier: "auto",
      mineruLocalApiBase: apiBase,
      mineruSyncEnabled: false,
      libraryTextIndexEnabled: false,
    };
    const old = Object.fromEntries(
      Object.keys(settings).map((key) => [
        key,
        Zotero.Prefs.get(prefix + key, true),
      ]),
    );
    const source = PathUtils.join(
      Zotero.DataDirectory.dir,
      "mineru-v1-tasks-test.pdf",
    );
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "MinerU 4.1 Tasks compatibility fixture");
    await parent.saveTx();
    await io.write(source, createPdfFixture(2));
    const pdf = await Zotero.Attachments.linkFromFile({
      file: source,
      parentItemID: parent.id,
      contentType: "application/pdf",
    });
    const restoreInvalidator = composeRetrievalCandidateInvalidation();
    const requests: Array<{ url: string; method: string }> = [];
    try {
      for (const [key, value] of Object.entries(settings))
        Zotero.Prefs.set(prefix + key, value, true);
      (globalThis as any).ztoolkit = toolkit;
      const fetch = tasksFetch(requests);
      toolkit.getGlobal = function (name: string) {
        return name === "fetch" ? fetch : getGlobal.call(this, name);
      };
      // Skip the real 2 s poll delays; the fake answers at once.
      setMineruV1TimingForTests({ pollDelay: () => 1 });
      const result = await parsePdfWithMineru(source, undefined, undefined, {
        attachmentId: pdf.id,
      });
      assert.isNotNull(result);
      assert.equal(result!.pageCount, 2);
      assert.lengthOf(
        requests.filter((r) => r.method === "PUT"),
        1,
      );
      assert.isFalse(requests.some((r) => r.url.includes("/parse/jobs")));
      await publishMineruParsedResult(pdf, result!);
      assert.include(await readCachedMineruMd(pdf.id), "Second page.");
      const manifest = await readManifest(pdf.id);
      assert.equal(manifest!.totalPages, 2);
      assert.equal(manifest!.sections[0].figures[0].page, 0);
      assert.equal(manifest!.sections[0].tables[0].caption, "Table 1. Counts.");
      assert.isTrue(
        await io.exists(
          PathUtils.join(getMineruItemDir(pdf.id), "images", "figure.png"),
        ),
      );
    } finally {
      setMineruV1TimingForTests(null);
      toolkit.getGlobal = getGlobal;
      (globalThis as any).ztoolkit = oldToolkit;
      restoreInvalidator();
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, value as any, true);
      }
      await parent.eraseTx();
      await io.remove(source, { ignoreAbsent: true });
      await io.remove(getMineruItemDir(pdf.id), {
        recursive: true,
        ignoreAbsent: true,
      });
    }
  });
  it("shows the V1 Tasks status line after Test Connection against a 4.1 server", async function () {
    const win = Zotero.getMainWindow();
    const doc = win.document.implementation.createHTMLDocument("MinerU 4.1");
    const add = (tag: string, id: string) => {
      const element = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      element.id = `llmforzotero-mineru-${id}`;
      doc.body.append(element);
      return element;
    };
    add("div", "legacy-options");
    add("div", "v1-options");
    add("span", "local-service");
    const toolkit = (Zotero as any).LLMForZotero.data.ztoolkit;
    const oldToolkit = (globalThis as any).ztoolkit;
    const getGlobal = toolkit.getGlobal;
    const oldTier = Zotero.Prefs.get(prefix + "mineruLocalTier", true);
    try {
      Zotero.Prefs.set(prefix + "mineruLocalTier", "auto", true);
      (globalThis as any).ztoolkit = toolkit;
      const fetch = tasksFetch([]);
      toolkit.getGlobal = function (name: string) {
        return name === "fetch" ? fetch : getGlobal.call(this, name);
      };
      const service = await testMineruLocalConnection(apiBase);
      assert.deepEqual(service, {
        api: "v1",
        protocol: "tasks",
        version: "4.1.7",
        tiers: ["flash", "basic"],
      });
      bindMineruLocalPreferences(doc, () => {})(service);
      assert.equal(
        doc.getElementById("llmforzotero-mineru-local-service")!.textContent,
        "MinerU 4.1.7 (V1 Tasks) · tiers: flash, basic · Auto will use basic (lightweight models)",
      );
      assert.equal(
        doc.getElementById("llmforzotero-mineru-v1-options")!.style.display,
        "flex",
      );
      assert.equal(
        doc.getElementById("llmforzotero-mineru-legacy-options")!.style.display,
        "none",
      );
    } finally {
      toolkit.getGlobal = getGlobal;
      (globalThis as any).ztoolkit = oldToolkit;
      if (oldTier === undefined)
        Zotero.Prefs.clear(prefix + "mineruLocalTier", true);
      else Zotero.Prefs.set(prefix + "mineruLocalTier", oldTier as any, true);
    }
  });
});

describe("workflow: MinerU local settings layout", function () {
  it("renders the shipped local settings for both APIs without clipped controls", async function () {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const source = await Zotero.File.getContentsFromURLAsync(
      "chrome://llmforzotero/content/preferences.xhtml",
    );
    const parsed = new win.DOMParser().parseFromString(
      (source as string).replace(
        "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
        "http://www.w3.org/1999/xhtml",
      ),
      "application/xhtml+xml",
    );
    assert.notExists(
      parsed.querySelector("parsererror"),
      parsed.documentElement.textContent || "XML parse failed",
    );
    const section = doc.importNode(
      parsed.getElementById("llmforzotero-mineru-local-section")!,
      true,
    ) as HTMLElement;
    const frame = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    frame.style.cssText =
      "position:fixed;left:10px;top:10px;width:650px;padding:20px;box-sizing:border-box;background:var(--material-background,#222);color:var(--fill-primary,#eee);z-index:2147483647;font:13px sans-serif;";
    section.style.display = "flex";
    frame.append(section);
    doc.documentElement.append(frame);
    const update = bindMineruLocalPreferences(doc, () => {});
    try {
      for (const api of ["legacy", "v1"] as const) {
        update(
          api === "v1"
            ? {
                api,
                protocol: "jobs",
                version: "4.0.6",
                tiers: ["flash", "standard"],
              }
            : { api, version: "3.4.5" },
        );
        await Zotero.Promise.delay(50);
        const bounds = frame.getBoundingClientRect();
        for (const control of Array.from(
          frame.querySelectorAll("input,select"),
        ) as HTMLElement[]) {
          const rect = control.getBoundingClientRect();
          if (!rect.width) continue;
          assert.isAtLeast(rect.left, bounds.left);
          assert.isAtMost(rect.right, bounds.right);
        }
        const canvas = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "canvas",
        ) as HTMLCanvasElement;
        canvas.width = Math.ceil(bounds.width);
        canvas.height = Math.ceil(bounds.height);
        const ctx = canvas.getContext("2d") as any;
        ctx.drawWindow(
          win,
          bounds.left,
          bounds.top,
          bounds.width,
          bounds.height,
          "white",
        );
        const data = win.atob(canvas.toDataURL("image/png").split(",")[1]);
        await (globalThis as any).IOUtils.write(
          PathUtils.join(
            Zotero.DataDirectory.dir,
            `mineru-${api}-settings.png`,
          ),
          Uint8Array.from(data, (char: string) => char.charCodeAt(0)),
        );
      }
    } finally {
      frame.remove();
    }
  });
});
