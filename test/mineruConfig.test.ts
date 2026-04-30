import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import {
  DEFAULT_MINERU_LOCAL_BASE_URL,
  getMineruBackendMode,
  getMineruLocalOptions,
  normalizeMineruLocalBaseUrl,
  setMineruBackendMode,
  setMineruLocalBaseUrl,
  setMineruLocalFormulaEnable,
  setMineruLocalTableEnable,
} from "../src/utils/mineruConfig";

describe("mineruConfig", function () {
  const originalZotero = (globalThis as typeof globalThis & { Zotero?: unknown })
    .Zotero;
  let prefs: Map<string, unknown>;

  beforeEach(function () {
    prefs = new Map();
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          return prefs.get(key);
        },
        set(key: string, value: unknown) {
          prefs.set(key, value);
        },
      },
    };
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  it("defaults local MinerU to MinerU's FastAPI defaults", function () {
    assert.equal(getMineruBackendMode(), "cloud");
    assert.equal(getMineruLocalOptions().baseUrl, DEFAULT_MINERU_LOCAL_BASE_URL);
    assert.equal(getMineruLocalOptions().host, "127.0.0.1");
    assert.equal(getMineruLocalOptions().port, "8000");
  });

  it("normalizes local base URLs without requiring a scheme", function () {
    assert.equal(
      normalizeMineruLocalBaseUrl("127.0.0.1:8000/"),
      "http://127.0.0.1:8000",
    );
    assert.equal(
      normalizeMineruLocalBaseUrl("https://mineru.local:9443///"),
      "https://mineru.local:9443",
    );
  });

  it("persists local backend and connection options", function () {
    setMineruBackendMode("local");
    setMineruLocalBaseUrl("127.0.0.1:8000");
    setMineruLocalFormulaEnable(false);
    setMineruLocalTableEnable(true);

    assert.equal(
      prefs.get(`${config.prefsPrefix}.mineruBackend`),
      "local",
    );
    assert.equal(getMineruBackendMode(), "local");
    assert.deepInclude(getMineruLocalOptions(), {
      baseUrl: "http://127.0.0.1:8000",
      formulaEnable: false,
      tableEnable: true,
    });
  });
});
