import { assert } from "chai";
import {
  canUseSkillClassifierModel,
  parseClassifierResponse,
} from "../src/agent/model/skillClassifier";
import type { AgentSkill } from "../src/agent/skills/skillLoader";

const SKILLS: AgentSkill[] = [
  {
    id: "write-note",
    description: "Create or edit notes",
    version: 1,
    patterns: [],
    instruction: "",
    source: "system",
  },
  {
    id: "compare-papers",
    description: "Compare two papers",
    version: 1,
    patterns: [],
    instruction: "",
    source: "system",
  },
  {
    id: "analyze-figures",
    description: "Analyze figures",
    version: 1,
    patterns: [],
    instruction: "",
    source: "system",
  },
];

describe("parseClassifierResponse", function () {
  it("returns the listed skill IDs for a clean JSON response", function () {
    const raw = '{"skillIds": ["write-note", "analyze-figures"]}';
    const result = parseClassifierResponse(raw, SKILLS);
    assert.deepEqual(result, ["write-note", "analyze-figures"]);
  });

  it("returns an empty array when the classifier says no skills apply", function () {
    const raw = '{"skillIds": []}';
    assert.deepEqual(parseClassifierResponse(raw, SKILLS), []);
  });

  it("tolerates surrounding prose or code fences", function () {
    const raw =
      'Sure, here is the classification:\n```json\n{"skillIds": ["compare-papers"]}\n```';
    assert.deepEqual(parseClassifierResponse(raw, SKILLS), ["compare-papers"]);
  });

  it("drops IDs that aren't in the known skill set", function () {
    const raw =
      '{"skillIds": ["write-note", "made-up-skill", "analyze-figures"]}';
    const result = parseClassifierResponse(raw, SKILLS);
    assert.deepEqual(result, ["write-note", "analyze-figures"]);
  });

  it("returns null for completely malformed input (caller should fall back)", function () {
    assert.isNull(parseClassifierResponse("not JSON at all", SKILLS));
    assert.isNull(parseClassifierResponse("", SKILLS));
    assert.isNull(parseClassifierResponse('{"wrongKey": []}', SKILLS));
    assert.isNull(
      parseClassifierResponse('{"skillIds": "not-an-array"}', SKILLS),
    );
  });

  it("strips non-string entries from the skillIds array", function () {
    const raw = '{"skillIds": ["write-note", 42, null, "compare-papers"]}';
    assert.deepEqual(parseClassifierResponse(raw, SKILLS), [
      "write-note",
      "compare-papers",
    ]);
  });

  it("allows blank apiBase for Codex app-server skill classification", function () {
    assert.isTrue(
      canUseSkillClassifierModel({
        model: "gpt-5.4",
        apiBase: "",
        authMode: "codex_app_server",
      }),
    );
    assert.isFalse(
      canUseSkillClassifierModel({
        model: "gpt-5.4",
        apiBase: "",
        authMode: "api_key",
      }),
    );
  });
});
