import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Llm4ZoteroToolDescriptor } from "./llm4zotero-contract.js";

type ParsedFrontmatter = {
  description?: string;
  allowedTools?: string[];
};

function parseFrontmatter(content: string): ParsedFrontmatter {
  const parsed: ParsedFrontmatter = {};
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return parsed;
  }
  const lines = trimmed.split("\n");
  if (lines.length < 3) {
    return parsed;
  }
  let idx = 1;
  for (; idx < lines.length; idx += 1) {
    const line = lines[idx].trim();
    if (line === "---") break;
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === "description") {
      parsed.description = value.replace(/^["']|["']$/g, "");
    } else if (key === "allowed-tools") {
      parsed.allowedTools = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }
  return parsed;
}

function inferRisk(allowedTools: string[] | undefined): {
  mutability: "read" | "write";
  riskLevel: "low" | "medium" | "high";
  requiresConfirmation: boolean;
} {
  const set = new Set((allowedTools || []).map((entry) => entry.toLowerCase()));
  const hasWrite =
    set.has("bash") ||
    set.has("write") ||
    set.has("edit") ||
    set.has("multiedit") ||
    set.has("notebookedit");
  if (hasWrite) {
    return {
      mutability: "write",
      riskLevel: "high",
      requiresConfirmation: true,
    };
  }
  if (set.size > 0) {
    return {
      mutability: "read",
      riskLevel: "medium",
      requiresConfirmation: false,
    };
  }
  return { mutability: "read", riskLevel: "low", requiresConfirmation: false };
}

function walkDirsForCommands(root: string, maxDepth = 6): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "commands") {
          out.push(full);
        }
        visit(full, depth + 1);
      }
    }
  };
  visit(root, 0);
  return out;
}

type ToolCatalogOptions = {
  runtimeCwd?: string;
  settingSources?: Array<"user" | "project" | "local">;
};

const TOOL_CATALOG_CACHE_TTL_MS = 15_000;
const toolCatalogCache = new Map<
  string,
  { expiresAt: number; tools: Llm4ZoteroToolDescriptor[] }
>();

function normalizeSettingSources(
  settingSources: Array<"user" | "project" | "local"> | undefined,
): Array<"user" | "project" | "local"> {
  if (!Array.isArray(settingSources) || settingSources.length === 0) {
    return ["user", "project", "local"];
  }
  const accepted: Array<"user" | "project" | "local"> = [];
  for (const source of settingSources) {
    if (
      (source === "user" || source === "project" || source === "local") &&
      !accepted.includes(source)
    ) {
      accepted.push(source);
    }
  }
  return accepted.length > 0 ? accepted : ["user", "project", "local"];
}

function getCommandDirs(options?: ToolCatalogOptions): string[] {
  const settingSources = normalizeSettingSources(options?.settingSources);
  const roots: string[] = [];
  const home = homedir();
  const runtimeCwd = resolve(options?.runtimeCwd || process.cwd());

  if (settingSources.includes("user")) {
    roots.push(
      join(home, ".claude", "commands"),
      ...walkDirsForCommands(join(home, ".claude", "plugins", "marketplaces")),
    );
  }

  if (settingSources.includes("project") || settingSources.includes("local")) {
    roots.push(
      join(runtimeCwd, ".claude", "commands"),
      ...walkDirsForCommands(
        join(runtimeCwd, ".claude", "plugins", "marketplaces"),
      ),
    );
  }

  return [...new Set(roots)].filter((dir) => existsSync(dir));
}

function listCommandFiles(options?: ToolCatalogOptions): string[] {
  const files: string[] = [];
  for (const dir of getCommandDirs(options)) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (extname(entry.name).toLowerCase() !== ".md") continue;
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function parseCommandDescriptor(
  filePath: string,
): Llm4ZoteroToolDescriptor | null {
  let content = "";
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const commandName = basename(filePath, ".md").trim();
  if (!commandName) {
    return null;
  }
  const frontmatter = parseFrontmatter(content);
  const risk = inferRisk(frontmatter.allowedTools);
  return {
    name: commandName,
    description:
      frontmatter.description || `Claude Code slash command: /${commandName}`,
    inputSchema: {
      type: "object",
      properties: {
        arguments: {
          type: "string",
          description: `Arguments after /${commandName}`,
        },
      },
      required: [],
    },
    mutability: risk.mutability,
    riskLevel: risk.riskLevel,
    requiresConfirmation: risk.requiresConfirmation,
    source: "claude-runtime",
  };
}

export function getToolCatalog(
  options?: ToolCatalogOptions,
): Llm4ZoteroToolDescriptor[] {
  const settingSources = normalizeSettingSources(options?.settingSources);
  const runtimeCwd = resolve(options?.runtimeCwd || process.cwd());
  const cacheKey = `${runtimeCwd}|${settingSources.join(",")}`;
  const cached = toolCatalogCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.tools;
  }

  const seen = new Set<string>();
  const tools: Llm4ZoteroToolDescriptor[] = [];
  for (const file of listCommandFiles({ runtimeCwd, settingSources })) {
    const descriptor = parseCommandDescriptor(file);
    if (!descriptor) continue;
    if (seen.has(descriptor.name)) continue;
    seen.add(descriptor.name);
    tools.push(descriptor);
  }
  const sorted = tools.sort((a, b) => a.name.localeCompare(b.name));
  toolCatalogCache.set(cacheKey, {
    expiresAt: Date.now() + TOOL_CATALOG_CACHE_TTL_MS,
    tools: sorted,
  });
  return sorted;
}

export function findToolByName(
  name: string,
  options?: ToolCatalogOptions,
): Llm4ZoteroToolDescriptor | undefined {
  return getToolCatalog(options).find((tool) => tool.name === name);
}
