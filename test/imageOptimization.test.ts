import { assert } from "chai";
import {
  IMAGE_OPTIMIZATION_PROFILES,
  estimateDataUrlByteLength,
} from "../src/utils/imageOptimization";

describe("image optimization", function () {
  it("estimates the decoded byte length of a base64 data URL", function () {
    // 8 base64 chars decode to 6 bytes
    assert.equal(
      estimateDataUrlByteLength("data:image/png;base64,AAAAAAAA"),
      6,
    );
  });

  it("keeps embedding images within Qwen3-VL max_pixels and 4 MB", function () {
    const profile = IMAGE_OPTIMIZATION_PROFILES.embedding;
    assert.isAtMost(profile.maxDimension ** 2, 1843200);
    assert.equal(profile.maxLosslessBytes, 4 * 1024 * 1024);
    assert.equal(profile.maxPassthroughBytes, 4 * 1024 * 1024);
  });
});
