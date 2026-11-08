import { assert } from "chai";
import {
  setNeutralStatus,
  setStatus,
} from "../src/modules/contextPanel/textUtils";

describe("textUtils setStatus", function () {
  const fakeStatus = () =>
    ({ textContent: "", className: "" }) as unknown as HTMLElement;

  it("shows the idle Ready line in the neutral style the panel mounts with", function () {
    const status = fakeStatus();
    setStatus(status, "Ready", "ready");
    assert.equal(status.textContent, "Ready");
    assert.equal(status.className, "llm-status");
  });

  it("keeps the accent for other ready messages", function () {
    const status = fakeStatus();
    setStatus(status, "Copied response", "ready");
    assert.equal(status.className, "llm-status llm-status-ready");
  });

  it("has a neutral variant for steady labels", function () {
    const status = fakeStatus();
    setNeutralStatus(status, "Read-only");
    assert.equal(status.className, "llm-status");
  });
});
