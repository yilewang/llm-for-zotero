import { check } from "./core";

export function assertHumanCitationLabels(labels: string[], count: number) {
  check(
    labels.length === count,
    `Interactive quote citation count: expected ${count}, got ${labels.length}`,
  );
  for (const label of labels) {
    check(
      label.trim() && !/\bPaper\s+\d+\b/i.test(label),
      `Citation exposes an internal item ID or empty label: ${label}`,
    );
  }
}

export async function snapshotFiles(
  root: string,
  io: {
    getChildren: (path: string) => Promise<string[]>;
    stat: (path: string, options?: unknown) => Promise<{ type: string }>;
    read: (path: string) => Promise<Uint8Array>;
  },
  hash: (bytes: Uint8Array) => Promise<string>,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const path of (await io.getChildren(directory)).sort()) {
      check(
        path.startsWith(`${root}/`) && !path.split("/").includes(".."),
        "File snapshot escaped the test vault",
      );
      const stat = await io.stat(path, { followSymlinks: false });
      if (stat.type === "directory") await visit(path);
      else {
        check(
          stat.type === "regular",
          `Unexpected non-regular vault file: ${path}`,
        );
        files[path.slice(root.length + 1)] = await hash(await io.read(path));
      }
    }
  };
  await visit(root);
  return files;
}

export function assertConversationSummary(text: string) {
  for (const token of [
    "hypothesis",
    "methods",
    "figure",
    "results",
    "limitations",
    "implications",
    "amber",
    "cobalt",
    "violet",
    "silver",
    "copper",
    "jade",
    "teal",
    "23",
    "ochre",
  ]) {
    check(
      text.toLowerCase().includes(token),
      `Conversation summary lost ${token}`,
    );
  }
  check(
    /0\.8(?:0)?|80\s*%/.test(text) && /0\.52|52\s*%/.test(text),
    "Conversation summary lost the quantitative result",
  );
  check(
    /propos|follow.up|discussion|our /i.test(text),
    "Discussion-only decisions are not identified as such",
  );
}
