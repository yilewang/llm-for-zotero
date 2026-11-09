import { assert } from "chai";
import {
  buildDirectConnectionVariables,
  formatManualProxyUrl,
  getCliProxyOverride,
} from "../src/utils/cliProxy";

describe("CLI network proxy", function () {
  it("formats a manual proxy and rejects an unusable one", function () {
    assert.equal(
      formatManualProxyUrl({
        protocol: "http",
        host: "127.0.0.1",
        port: "7890",
      }),
      "http://127.0.0.1:7890",
    );
    assert.equal(
      formatManualProxyUrl({
        protocol: "socks5",
        host: "socks5://10.0.0.2/",
        port: " 1080 ",
      }),
      "socks5://10.0.0.2:1080",
    );
    assert.equal(
      formatManualProxyUrl({ protocol: "http", host: "::1", port: "8080" }),
      "http://[::1]:8080",
    );
    assert.equal(
      formatManualProxyUrl({ protocol: "http", host: "", port: "7890" }),
      "",
    );
    assert.equal(
      formatManualProxyUrl({ protocol: "http", host: "a", port: "70000" }),
      "",
    );
  });

  it("imposes nothing in system mode or with an incomplete manual proxy", function () {
    const base = { protocol: "http" as const, host: "", port: "" };
    assert.isNull(getCliProxyOverride({ ...base, mode: "system" }));
    assert.isNull(getCliProxyOverride({ ...base, mode: "manual" }));
  });

  it("points every proxy variable at a manual proxy", function () {
    const env = getCliProxyOverride({
      mode: "manual",
      protocol: "socks5",
      host: "127.0.0.1",
      port: "7891",
    });
    assert.deepInclude(env, {
      HTTPS_PROXY: "socks5://127.0.0.1:7891",
      http_proxy: "socks5://127.0.0.1:7891",
      ALL_PROXY: "socks5://127.0.0.1:7891",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("clears inherited proxies and bypasses every proxy in none mode", function () {
    const env = getCliProxyOverride({
      mode: "none",
      protocol: "http",
      host: "127.0.0.1",
      port: "7890",
    });
    assert.deepEqual(env, buildDirectConnectionVariables());
    assert.equal(env?.HTTPS_PROXY, "");
    assert.equal(env?.all_proxy, "");
    assert.equal(env?.NO_PROXY, "*");
  });
});
