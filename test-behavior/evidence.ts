import { check, redact } from "./core";

export function validateReportLocation(
  root: string,
  reportDir: string,
  requestPath: string,
) {
  check(
    requestPath === `${reportDir}/request.json` &&
      reportDir.startsWith(
        `${root.replace(/\/$/, "")}/tmp/behavior-reports/`,
      ) &&
      !reportDir.split("/").includes(".."),
    "Invalid behavior report directory",
  );
}

type EvidenceIO = {
  makeDirectory: (
    path: string,
    options: { ignoreExisting: boolean; createAncestors: boolean },
  ) => Promise<unknown>;
  exists: (path: string) => Promise<boolean>;
  writeUTF8: (
    path: string,
    value: string,
    options: { mode: "append" | "overwrite" },
  ) => Promise<unknown>;
};

export function createEvidenceWriter(
  reportDir: string,
  secrets: string[],
  io: EvidenceIO,
) {
  return async (file: string, data: unknown, plain = false): Promise<void> => {
    check(
      !file.startsWith("/") && !file.split("/").includes(".."),
      "Invalid evidence path",
    );
    const path = `${reportDir}/${file}`;
    await io.makeDirectory(path.slice(0, path.lastIndexOf("/")), {
      ignoreExisting: true,
      createAncestors: true,
    });
    const clean = redact(data, secrets);
    const jsonl = file.endsWith(".jsonl");
    const text = plain
      ? String(clean)
      : JSON.stringify(clean, null, jsonl ? 0 : 2);
    // Gecko append mode requires an existing file, unlike Node appendFile.
    const append = jsonl && (await io.exists(path));
    await io.writeUTF8(path, text + (jsonl ? "\n" : ""), {
      mode: append ? "append" : "overwrite",
    });
  };
}
