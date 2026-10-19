import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve, join, isAbsolute } from "node:path";

const canonical = (value) =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
const hash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const read = (path) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
const save = (path, data) => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  renameSync(temp, path);
};
const continuing = (text) =>
  /^(?:请)?(?:继续|接着|恢复|continue|resume)(?:[\s，,。.！!]|$)/i.test(
    text.trim(),
  );

/** A binding selects a native SDK session; the journal protects the RPC acknowledgement gap. */
export class DurableConversation {
  constructor(config) {
    if (!isAbsolute(config.session.root) || !config.session.key)
      throw new Error(
        "Expected an absolute session directory and a conversation identity",
      );
    this.root = resolve(
      config.session.root,
      hash([config.session.key, config.apiBase, config.model, config.apiKey]),
    );
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.path = join(this.root, "binding.json");
    const prior = read(this.path);
    const users = (config.session.history || config.history || [])
      .filter((m) => m.role === "user")
      .map((m) => hash(m.content));
    const prompt = hash(config.session.userText ?? config.turnText);
    const same = prior && canonical(users) === canonical(prior.users);
    const next =
      prior && canonical(users) === canonical([...prior.users, prior.prompt]);
    const retry =
      same && prompt === prior.prompt && prior.status !== "completed";
    this.resumed = Boolean(prior && (retry || next));
    this.recovering =
      this.resumed &&
      prior.status !== "completed" &&
      (retry || continuing(config.session.userText ?? config.turnText));
    this.binding = this.resumed
      ? prior
      : {
          sessionId: `zotero-${hash([config.session.key, users, prompt, prior?.sessionId || "initial"])}`,
        };
    this.binding = {
      ...this.binding,
      users,
      prompt,
      status: "running",
      operation: this.recovering ? prior.operation : randomUUID(),
    };
    this.journalPath = join(this.root, `${this.binding.operation}.tools.json`);
    this.records = read(this.journalPath) || {};
    this.replay = new Set(this.recovering ? Object.keys(this.records) : []);
  }

  commit() {
    save(this.path, this.binding);
  }
  finish(status) {
    this.binding.status = status;
    this.commit();
  }
  recover() {
    this.recovering = true;
    this.replay = new Set(Object.keys(this.records));
  }

  async execute(tool, args, dispatch, notify) {
    // Input questions and internal controls retain their host-owned lifecycle.
    if (tool.executionClass === "control" || tool.interaction === "user_input")
      return dispatch();
    const key = hash([tool.name, args]);
    const prior = this.records[key];
    if (
      this.recovering &&
      prior?.result &&
      prior.result.ok &&
      (this.replay.has(key) ||
        prior.readOnly === false ||
        prior.result.effect !== "none")
    ) {
      notify(`Reused completed tool result: ${tool.name}`);
      return prior.result;
    }
    const readOnly =
      tool.executionClass === "read" ||
      (tool.name === "file_io" && args?.action === "read") ||
      (tool.name === "zotero_script" && args?.effect === "read");
    if (
      !readOnly &&
      Object.values(this.records).some((r) => r.pending && !r.readOnly)
    )
      throw new Error(
        "A previous tool outcome is unconfirmed. Automatic writes are blocked for this recovery. Inspect the target, then use a new instruction for any further write.",
      );
    this.records[key] = { pending: true, readOnly, name: tool.name };
    save(this.journalPath, this.records);
    const result = await dispatch();
    this.records[key] = { result, readOnly, name: tool.name };
    save(this.journalPath, this.records);
    if (result.effect && result.effect !== "none") this.replay.clear();
    return result;
  }
}
