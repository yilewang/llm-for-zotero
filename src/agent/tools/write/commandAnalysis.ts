import type { ActionRiskSignal } from "../../authorization/types";
import {
  ambiguousInvocationPlan,
  prohibitedInvocationPlan,
  readOnlyInvocationPlan,
  stateChangeInvocationPlan,
} from "../../authorization/invocationPlan";
import {
  parseShellCommands,
  parseSimpleShellWords,
  isReadOnlyCommand,
} from "./shellSyntax";
import { reachesAuthorizationState } from "./authorizationTampering";

export type RunCommandInput = {
  command: string;
  cwd?: string;
  timeoutMs: number;
};
type ReversibleCommandWrite = {
  kind: "file" | "directory";
  path: string;
  sourcePath?: string;
  description: string;
};

/** Downloading code into a shell requires Auto's contextual risk review. */
const NETWORK_TO_SHELL_PATTERN =
  /(?:(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b|(?:sh|bash|zsh)\b[\s\S]*<\s*\(\s*(?:curl|wget)\b|(?:sh|bash|zsh)\b[\s\S]*(?:\$\(\s*(?:curl|wget)\b|`\s*(?:curl|wget)\b))/i;

/** macOS/system automation commands can mutate external app or OS state. */
const SYSTEM_AUTOMATION_PATTERN =
  /(?:^|\||;|&&)\s*(?:(?:osascript|launchctl)\b|defaults\s+(?:write|delete|import|rename)\b)/i;

const PACKAGE_SYSTEM_MODIFICATION_PATTERN =
  /(?:^|\||;|&&)\s*(?:(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update|upgrade)\b|(?:pip|pip3)\s+install\b|python3?\s+-m\s+pip\s+install\b|uv\s+pip\s+install\b|brew\s+(?:install|upgrade|update|uninstall)\b|(?:apt|apt-get|dnf|yum|pacman|conda|mamba)\s+(?:install|remove|update|upgrade)\b|cargo\s+install\b|gem\s+install\b|date\s+(?:-s|--set)\b|timedatectl\b|systemsetup\s+-set(?:date|time|timezone)\b)/i;

const RECOGNIZED_STATE_CHANGE_COMMANDS =
  /(?:^|\||;|&&)\s*(?:(?:touch|mkdir|cp|mv|rm|rmdir|chmod|chown|tee)\b|(?:copy|move|del|erase|ren|rename|md|mkdir|rd|rmdir)\b|git\s+(?:add|commit|push|reset|checkout|switch|clean|rebase|merge|cherry-pick|revert|rm|branch|tag)\b|git\s+diff\b[^\n;&|]*--output(?:=|\s)|(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update|upgrade)\b|(?:pip|pip3)\s+install\b|python3?\s+-m\s+pip\s+install\b|uv\s+pip\s+install\b|brew\s+(?:install|upgrade|update|uninstall)\b|(?:apt|apt-get|dnf|yum|pacman|conda|mamba)\s+(?:install|remove|update|upgrade)\b|cargo\s+install\b|gem\s+install\b|date\s+(?:-s|--set)\b|timedatectl\b|systemsetup\s+-set(?:date|time|timezone)\b)/i;

/** An append is a state change, including when it creates a new file. */
const APPEND_REDIRECT_PATTERN =
  /(?:^|[^<])(?:\d*>>|&>>)\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/;

const OVERWRITE_REDIRECT_TARGET_PATTERN =
  /(?:^|[^<>=])(?:\d?>|&>)(?!=)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/;

const ANY_REDIRECT_TARGET_PATTERN =
  /(?:^|[^<>=])(?:\d*>>|&>>|\d?>|&>)(?!=)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;

const TEE_TARGET_PATTERN =
  /(?:^|[|;&])\s*tee(?:\s+-[A-Za-z]+)*\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;

export async function pathExists(path: string): Promise<boolean | null> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.exists) {
    try {
      return Boolean(await IOUtils.exists(path));
    } catch {
      return null;
    }
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.exists) {
    try {
      return Boolean(await OSFile.exists(path));
    } catch {
      return null;
    }
  }
  return null;
}

async function pathKind(path: string): Promise<"file" | "directory" | null> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.stat) {
    try {
      const stat = await IOUtils.stat(path);
      if (stat?.type === "directory") return "directory";
      if (stat?.type === "regular" || stat?.type === "file") return "file";
    } catch {
      return null;
    }
  }
  const OSFile = (globalThis as any).OS?.File;
  if (OSFile?.stat) {
    try {
      const stat = await OSFile.stat(path);
      if (stat?.isDir === true) return "directory";
      if (stat) return "file";
    } catch {
      return null;
    }
  }
  return null;
}

function childPath(directory: string, sourcePath: string): string {
  const sourceName = sourcePath
    .replace(/[\\/]+$/g, "")
    .split(/[\\/]/)
    .pop();
  if (!sourceName) return directory;
  const separator =
    directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/g, "")}${separator}${sourceName}`;
}

export async function resolveReversibleOutputPath(
  write: ReversibleCommandWrite,
  cwd: string | undefined,
): Promise<string> {
  const destination = resolveCommandPath(write.path, cwd);
  if (write.sourcePath && (await pathKind(destination)) === "directory") {
    return childPath(destination, write.sourcePath);
  }
  return destination;
}

function hasGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

export function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  );
}

export function resolveCommandPath(
  path: string,
  cwd: string | undefined,
): string {
  const normalize = (value: string): string => {
    const slash = value.replace(/\\/g, "/");
    const drive = slash.match(/^([A-Za-z]:)(?:\/|$)/)?.[1];
    const unc = slash.startsWith("//");
    const absolute = slash.startsWith("/") || Boolean(drive);
    const prefix = drive ? `${drive}/` : unc ? "//" : absolute ? "/" : "";
    const body = drive
      ? slash.slice(drive.length + 1)
      : slash.replace(/^\/+/, "");
    const segments: string[] = [];
    for (const segment of body.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (segments.length && segments.at(-1) !== "..") segments.pop();
        else if (!absolute) segments.push(segment);
        continue;
      }
      segments.push(segment);
    }
    return `${prefix}${segments.join("/")}` || (absolute ? prefix : ".");
  };
  if (path.startsWith("~")) return path;
  if (isAbsolutePath(path)) return normalize(path);
  return normalize(cwd ? `${cwd.replace(/[\\/]+$/g, "")}/${path}` : path);
}

export function resolvedCommandTargets(
  input: Pick<RunCommandInput, "command" | "cwd">,
): string[] {
  const targets = parseCommandWriteTargets(input.command).map((path) =>
    resolveCommandPath(path, input.cwd),
  );
  return [...new Set([...(input.cwd ? [input.cwd] : []), ...targets])];
}

function targetsProtectedBoundary(targets: string[], command: string): boolean {
  if (
    /\b(?:rm|rmdir)\s+(?:-[^\s]+\s+)*(?:\/|~|\$HOME|%USERPROFILE%)(?=[\s"']|$)/i.test(
      command,
    )
  ) {
    return true;
  }
  return targets.some((target) => {
    const normalized = target.replace(/\\/g, "/").replace(/\/+$/g, "");
    return (
      normalized === "" ||
      normalized === "/" ||
      normalized === "~" ||
      /^[A-Za-z]:$/.test(normalized) ||
      ["/System", "/usr", "/bin", "/sbin", "/etc"].some(
        (root) => normalized === root || normalized.startsWith(`${root}/`),
      )
    );
  });
}

function commandRiskSignals(command: string): ActionRiskSignal[] {
  const signals: ActionRiskSignal[] = [];
  if (/\b(?:sudo|doas|runas)\b/i.test(command)) {
    signals.push("privilege_escalation");
  }
  if (
    PACKAGE_SYSTEM_MODIFICATION_PATTERN.test(command) ||
    SYSTEM_AUTOMATION_PATTERN.test(command)
  ) {
    signals.push("package_system_modification");
  }
  if (isNetworkToShellCommand(command)) signals.push("download_to_shell");
  if (
    /\b(?:rm|rmdir)\b[^\n]*(?:-r|-rf|-fr)\b|(?:^|[;&|])\s*(?:rd|rmdir)\s+\/s\b/i.test(
      command,
    )
  ) {
    signals.push("broad_delete");
  }
  if (reachesAuthorizationState(command)) {
    signals.push("authorization_tampering");
  }
  return signals;
}

export async function classifyRunCommandInvocation(
  input: Pick<RunCommandInput, "command" | "cwd">,
) {
  const command = input.command.trim();
  const targets = resolvedCommandTargets(input);
  const stages = parseShellCommands(command);
  if (stages?.every(isReadOnlyCommand)) {
    return readOnlyInvocationPlan({
      mechanism: "shell",
      assurance: "statically_recognized",
      domains: ["local_execution", "filesystem"],
      targets,
      reason: "Every command in the parsed sequence only reads or prints data.",
    });
  }
  const onlyReadPrograms = stages?.every((stage) =>
    isReadOnlyCommand({ ...stage, redirects: [] }),
  );
  // Text printed into a document is data, even when it names commands or permission settings.
  const riskSignals = onlyReadPrograms ? [] : commandRiskSignals(command);
  const stateChange =
    RECOGNIZED_STATE_CHANGE_COMMANDS.test(command) ||
    SYSTEM_AUTOMATION_PATTERN.test(command) ||
    APPEND_REDIRECT_PATTERN.test(command) ||
    Boolean(parseRedirectTarget(command));
  if (riskSignals.includes("authorization_tampering")) {
    return prohibitedInvocationPlan({
      mechanism: "shell",
      domains: ["local_execution", "filesystem"],
      effects: ["modify"],
      targets,
      riskSignals: [...riskSignals],
      reason: "The command crosses an enforced local integrity boundary.",
    });
  }
  if (stateChange) {
    if (targetsProtectedBoundary(targets, command))
      riskSignals.push("scope_expansion");
    const reversibleWrite = parseReversibleCommandWrite(command);
    const outputPath = reversibleWrite
      ? await resolveReversibleOutputPath(reversibleWrite, input.cwd)
      : undefined;
    const exists = outputPath ? await pathExists(outputPath) : null;
    const deletes = stages
      ? stages.some(({ words }) =>
          ["rm", "rmdir", "del", "rd"].includes(words[0]),
        )
      : /\b(?:rm|rmdir)\b/i.test(command);
    const effects = deletes
      ? (["delete"] as const)
      : exists === false
        ? (["create"] as const)
        : (["modify"] as const);
    return stateChangeInvocationPlan({
      mechanism: "shell",
      assurance: "statically_recognized",
      domains: ["local_execution", "filesystem", "network"],
      effects: [...effects],
      targets,
      riskSignals,
      reversibility: reversibleWrite && exists === false ? "partial" : "none",
      reason:
        reversibleWrite && exists === false
          ? "The recognized new output can be removed, but other shell effects are not proven reversible."
          : "The command contains a recognized state-changing form whose complete inverse cannot be proven.",
    });
  }
  return ambiguousInvocationPlan({
    mechanism: "shell",
    domains: ["local_execution", "filesystem", "network"],
    effects: ["read", "create", "modify", "delete", "egress"],
    targets,
    riskSignals,
    reason:
      "The shell form contains an interpreter, expansion, executable, or flag outside the audited read-only grammar.",
  });
}

function isNullRedirectTarget(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized === "/dev/null" || normalized === "nul";
}

function normalizeParsedCommandTarget(
  value: string,
  options?: { unquoted?: boolean },
): string {
  const path = value.trim();
  return options?.unquoted ? path.replace(/\)+$/g, "") : path;
}

function parseRedirectTarget(command: string): ReversibleCommandWrite | null {
  const match = command.match(OVERWRITE_REDIRECT_TARGET_PATTERN);
  if (!match) return null;
  const path = (match[1] || match[2] || match[3] || "").trim();
  if (!path || isNullRedirectTarget(path) || hasGlobPattern(path)) return null;
  return {
    kind: "file",
    path,
    description: `Delete created file from shell redirect: ${path}`,
  };
}

export function parseCommandWriteTargets(command: string): string[] {
  const targets: string[] = [];
  let match: RegExpExecArray | null;
  const redirectPattern = new RegExp(
    ANY_REDIRECT_TARGET_PATTERN.source,
    ANY_REDIRECT_TARGET_PATTERN.flags,
  );
  while ((match = redirectPattern.exec(command)) !== null) {
    const path = normalizeParsedCommandTarget(
      match[1] || match[2] || match[3] || "",
      {
        unquoted: Boolean(match[3]),
      },
    );
    if (path && !isNullRedirectTarget(path)) targets.push(path);
  }

  const teePattern = new RegExp(
    TEE_TARGET_PATTERN.source,
    TEE_TARGET_PATTERN.flags,
  );
  while ((match = teePattern.exec(command)) !== null) {
    const path = normalizeParsedCommandTarget(
      match[1] || match[2] || match[3] || "",
      {
        unquoted: Boolean(match[3]),
      },
    );
    if (path && !isNullRedirectTarget(path)) targets.push(path);
  }

  const words = parseSimpleShellWords(command.trim());
  if (words?.length) {
    const [rawProgram, ...args] = words;
    const program = rawProgram.toLowerCase().replace(/\.exe$/, "");
    if (
      (program === "cp" || program === "mv") &&
      args.length >= 2 &&
      !args.some((arg) => hasGlobPattern(arg))
    ) {
      const positional = args.filter((arg) => !arg.startsWith("-"));
      const target = positional[positional.length - 1];
      if (target) targets.push(target);
    }
    if (
      ["rm", "rmdir", "touch", "mkdir", "md", "rd", "del"].includes(program)
    ) {
      targets.push(...args.filter((arg) => !arg.startsWith("-")));
    }
    if (["chmod", "chown"].includes(program)) {
      targets.push(...args.slice(1).filter((arg) => !arg.startsWith("-")));
    }
  }

  return Array.from(new Set(targets));
}

export function parseReversibleCommandWrite(
  command: string,
): ReversibleCommandWrite | null {
  const trimmed = command.trim();
  const commands = parseShellCommands(trimmed);
  if (!commands || commands.length !== 1) return null;
  const parsed = commands[0];
  if (parsed.redirects.length) {
    const writes = parsed.redirects.filter(({ operator }) => operator !== "<");
    if (
      writes.length !== 1 ||
      ![">", ">>"].includes(writes[0].operator) ||
      !isReadOnlyCommand({ ...parsed, redirects: [] }) ||
      isNullRedirectTarget(writes[0].target) ||
      hasGlobPattern(writes[0].target)
    )
      return null;
    return {
      kind: "file",
      path: writes[0].target,
      description: `Delete created file: ${writes[0].target}`,
    };
  }

  const words = parseSimpleShellWords(trimmed);
  if (!words?.length) return null;
  const [program, ...args] = words;
  if (program === "mkdir") {
    const paths = args.filter((arg) => arg !== "-p");
    if (
      paths.length !== 1 ||
      paths[0].startsWith("-") ||
      hasGlobPattern(paths[0])
    )
      return null;
    return {
      kind: "directory",
      path: paths[0],
      description: `Remove created directory: ${paths[0]}`,
    };
  }
  if (
    program === "touch" &&
    args.length === 1 &&
    !args[0].startsWith("-") &&
    !hasGlobPattern(args[0])
  ) {
    return {
      kind: "file",
      path: args[0],
      description: `Delete created file: ${args[0]}`,
    };
  }
  if (
    program === "cp" &&
    args.length === 2 &&
    !args.some((arg) => arg.startsWith("-") || hasGlobPattern(arg))
  ) {
    return {
      kind: "file",
      path: args[1],
      sourcePath: args[0],
      description: `Delete copied file: ${args[1]}`,
    };
  }
  return null;
}

/** Retain partial recovery evidence even when the whole command needs model review. */
export function identifyCommandOutput(
  command: string,
): ReversibleCommandWrite | null {
  return parseReversibleCommandWrite(command) || parseRedirectTarget(command);
}

function isNetworkToShellCommand(command: string): boolean {
  return NETWORK_TO_SHELL_PATTERN.test(command.trim());
}
