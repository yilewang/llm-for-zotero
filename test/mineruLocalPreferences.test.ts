import { assert } from "chai";
import { config } from "../package.json";
import { bindMineruLocalPreferences } from "../src/modules/mineruLocalPreferences";
import { initI18n } from "../src/utils/i18n";
import type { MineruLocalService } from "../src/utils/mineruLocalClient";

describe("MinerU local preferences status line", function () {
  const globals = globalThis as unknown as { Zotero?: unknown };
  let previousZotero: unknown;
  let store: Map<string, unknown>;
  let locale = "en-US";

  const element = (value = "") => ({
    value,
    checked: false,
    textContent: "",
    style: { display: "" } as Record<string, string>,
    options: [] as Array<{ value: string; disabled: boolean }>,
    addEventListener() {},
  });
  type Stub = ReturnType<typeof element>;
  let elements: Record<string, Stub>;

  const id = (name: string) => `${config.addonRef}-${name}`;
  const bind = (savedTier: string) => {
    store.set(`${config.prefsPrefix}.mineruLocalTier`, savedTier);
    const tier = element();
    tier.options = ["auto", "flash", "basic", "standard", "advanced"].map(
      (value) => ({ value, disabled: false }),
    );
    elements = {
      [id("mineru-local-tier")]: tier,
      [id("mineru-local-service")]: element(),
      [id("mineru-legacy-options")]: element(),
      [id("mineru-v1-options")]: element(),
    };
    const doc = {
      getElementById: (key: string) => elements[key] ?? null,
    } as unknown as Document;
    const update = bindMineruLocalPreferences(doc, () => {});
    return (service?: MineruLocalService) => {
      update(service);
      return elements[id("mineru-local-service")].textContent;
    };
  };
  const v1 = (tiers: string[]): MineruLocalService => ({
    api: "v1",
    protocol: "jobs",
    version: "4.0.10",
    tiers,
  });

  before(function () {
    previousZotero = globals.Zotero;
    globals.Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith(".locale") ? locale : store.get(key),
        set: (key: string, value: unknown) => store.set(key, value),
      },
      get locale() {
        return locale;
      },
    };
  });
  beforeEach(function () {
    store = new Map();
    locale = "en-US";
    initI18n();
  });
  after(function () {
    if (previousZotero === undefined) delete globals.Zotero;
    else globals.Zotero = previousZotero;
    initI18n();
  });

  it("states what Auto will use on a flash-only server", function () {
    const status = bind("auto")(v1(["flash"]));
    assert.equal(
      status,
      "MinerU 4.0.10 (V1) · tiers: flash · Auto will use flash (fastest)",
    );
  });

  it("names an explicitly chosen tier on a server that offers all four", function () {
    const all = ["flash", "basic", "standard", "advanced"];
    const expected: Record<string, string> = {
      flash: "flash (fastest)",
      basic: "basic (lightweight models)",
      standard: "standard (full models)",
      advanced: "advanced (highest quality)",
    };
    for (const tier of all)
      assert.equal(
        bind(tier)(v1(all)),
        `MinerU 4.0.10 (V1) · tiers: ${all.join(", ")} · ${expected[tier]} will be used`,
        tier,
      );
  });

  it("explains the fallback with requested tier first, used tier second", function () {
    assert.equal(
      bind("standard")(v1(["flash"])),
      "MinerU 4.0.10 (V1) · tiers: flash · standard isn't offered; flash (fastest) will be used",
    );
  });

  it("disables unoffered tiers but keeps the saved one selected", function () {
    bind("standard")(v1(["flash"]));
    const options = elements[id("mineru-local-tier")].options;
    assert.deepEqual(
      options.map((o) => [o.value, o.disabled]),
      [
        ["auto", false],
        ["flash", false],
        ["basic", true],
        ["standard", true],
        ["advanced", true],
      ],
    );
    assert.equal(elements[id("mineru-local-tier")].value, "standard");
  });

  it("labels a MinerU 4.1 Tasks server and keeps the V1 section visible", function () {
    const status = bind("auto")({
      api: "v1",
      protocol: "tasks",
      version: "4.1.7",
      tiers: ["flash", "basic"],
    });
    assert.equal(
      status,
      "MinerU 4.1.7 (V1 Tasks) · tiers: flash, basic · Auto will use basic (lightweight models)",
    );
    assert.equal(elements[id("mineru-v1-options")].style.display, "flex");
    assert.equal(elements[id("mineru-legacy-options")].style.display, "none");
  });

  it("describes a legacy server and hides the V1 section", function () {
    const status = bind("auto")({ api: "legacy", version: "2.6.0" });
    assert.equal(status, "MinerU 2.6.0 (Legacy API)");
    assert.equal(elements[id("mineru-v1-options")].style.display, "none");
    assert.equal(elements[id("mineru-legacy-options")].style.display, "flex");
  });

  it("returns to the prompt when no server is detected", function () {
    const update = bind("auto");
    update(v1(["flash"]));
    assert.equal(
      update(),
      "Test Connection detects the local API and available options.",
    );
  });

  it("localizes the status line in zh-CN", function () {
    locale = "zh-CN";
    initI18n();
    const update = bind("standard");
    const status = update(v1(["flash"]));
    assert.equal(
      status,
      "MinerU 4.0.10 (V1) · 档位：flash · 服务器未提供 standard；将使用 flash (最快)",
    );
    assert.equal(
      bind("auto")(v1(["flash"])),
      "MinerU 4.0.10 (V1) · 档位：flash · 自动将使用 flash (最快)",
    );
  });
});
