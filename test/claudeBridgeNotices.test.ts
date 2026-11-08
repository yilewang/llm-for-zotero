import { assert } from "chai";
import { describe, it } from "mocha";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_BRIDGE_NOTICE_PACKAGES,
  buildClaudeBridgeNotices,
} from "../scripts/claude-bridge-notices.mjs";

function fixture(skip?: string) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-notices-"));
  const nm = join(dir, "node_modules");
  for (const p of CLAUDE_BRIDGE_NOTICE_PACKAGES) {
    if (p.name === skip) continue;
    const pdir = join(nm, p.name);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(
      join(pdir, "package.json"),
      JSON.stringify({ name: p.name, version: "9.9.9", license: "MIT" }),
    );
    writeFileSync(
      join(pdir, p.licenseFile),
      `LICENSE TEXT OF ${p.name}\n  keep  spacing\n`,
    );
  }
  const adapter = join(dir, "ADAPTER_LICENSE");
  writeFileSync(adapter, "ADAPTER MIT TEXT\n");
  const notice = join(dir, "ADAPTER_NOTICE");
  writeFileSync(notice, "ADAPTER RELICENSE NOTICE\n");
  return {
    roots: [nm],
    adapterLicensePath: adapter,
    adapterNoticePath: notice,
  };
}

describe("claude bridge third-party notices", () => {
  it("lists the adapter first, then the bundled packages in order", () => {
    const text = buildClaudeBridgeNotices(fixture());
    const order = [
      "cc-llm4zotero-adapter",
      "@anthropic-ai/claude-agent-sdk 9.9.9",
      "@modelcontextprotocol/sdk 9.9.9",
      "zod 9.9.9",
      "mime-types 9.9.9",
      "mime-db 9.9.9",
    ].map((n) => text.indexOf(n));
    assert.isTrue(order.every((i) => i >= 0));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
    assert.include(text, "ADAPTER MIT TEXT");
    assert.include(text, "ADAPTER RELICENSE NOTICE");
    assert.include(text, "AGPL-3.0-or-later");
    assert.include(text, "not MIT");
  });

  it("quotes the SDK LICENSE.md verbatim from the real install", () => {
    const real = readFileSync(
      "packages/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md",
      "utf8",
    ).trim();
    assert.include(buildClaudeBridgeNotices(), real);
  });

  it("states the adapter's relicense from the real NOTICE", () => {
    const text = buildClaudeBridgeNotices();
    assert.include(
      text,
      readFileSync("packages/claude-bridge/NOTICE", "utf8").trim(),
    );
    assert.include(text, "Permission is hereby granted");
  });

  it("keeps license text spacing", () => {
    assert.include(buildClaudeBridgeNotices(fixture()), "\n  keep  spacing");
  });

  it("throws when a package is missing", () => {
    assert.throws(
      () => buildClaudeBridgeNotices(fixture("zod")),
      /package "zod" is not installed/,
    );
  });
});
