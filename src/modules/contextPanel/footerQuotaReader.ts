import { createQuotaReader, readApiQuota } from "../../providers/quota";
import { readCodexQuota } from "../../codexAppServer/quota";
import { readClaudeQuota } from "../../claudeCode/quota";
import { readAntigravityQuota } from "../../antigravity/quota";

// Shared by all panels; the view owns only presentation and selection races.
export const readFooterQuota = createQuotaReader((target) =>
  target.kind === "codex"
    ? readCodexQuota(target.codexPath)
    : target.kind === "claude"
      ? readClaudeQuota(target)
      : target.kind === "antigravity"
        ? readAntigravityQuota(target)
        : readApiQuota(target),
);
