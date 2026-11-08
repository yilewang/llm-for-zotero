import { config } from "../../../package.json";
import { t } from "../../utils/i18n";
import { isAbsoluteLocalPath } from "../../utils/localPath";
import { revealLocalPath } from "../../utils/revealLocalPath";
import { ensureDir } from "../../utils/geckoFs";
import {
  deleteAgentFilesFolders,
  getAgentFilesRoot,
  getAgentFilesRootPref,
  getDefaultAgentFilesRoot,
  listAgentFilesFolders,
  setAgentFilesRootPref,
  type AgentFilesFolderSummary,
} from "../../utils/agentFilesDirectory";

/** "2.3 MB" for a byte count. */
export function formatFolderSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function describeStatus(summary: AgentFilesFolderSummary): string {
  switch (summary.status) {
    case "gone":
      return t("Left over: its paper was deleted");
    case "trash":
      return t("Its paper is in the trash");
    case "library":
      return t("Library chat");
    case "paper":
      return summary.title || t("Paper");
    default:
      return t("Not made by the plugin");
  }
}

export type SavedFilesPreferences = {
  /** The row's one-line summary: the folder in use. */
  summary: () => string;
};

/**
 * Settings > Agent > Saved files: where the agent saves files, and a list of
 * each paper's folder to clean up. Nothing is deleted unless the user ticks it
 * and confirms.
 */
export function registerSavedFilesPreferences(
  doc: Document,
  onChange: () => void,
): SavedFilesPreferences {
  const get = <T extends Element>(id: string) =>
    doc.querySelector(`#${config.addonRef}-${id}`) as T | null;
  const dirInput = get<HTMLInputElement>("agent-files-dir");
  const dirHint = get<HTMLElement>("agent-files-dir-hint");
  const revealBtn = get<HTMLButtonElement>("agent-files-dir-reveal");
  const resetBtn = get<HTMLButtonElement>("agent-files-dir-reset");
  const scanBtn = get<HTMLButtonElement>("agent-files-scan");
  const deleteBtn = get<HTMLButtonElement>("agent-files-delete");
  const list = get<HTMLElement>("agent-files-list");
  const status = get<HTMLElement>("agent-files-status");
  const defaultRoot = getDefaultAgentFilesRoot() || "";

  const showStatus = (text: string, error = false) => {
    if (!status) return;
    status.style.display = text ? "inline" : "none";
    status.style.color = error ? "#dc2626" : "";
    status.textContent = text;
  };
  const showHint = () => {
    if (!dirHint) return;
    const custom = getAgentFilesRootPref();
    dirHint.style.color = "";
    dirHint.textContent = custom
      ? t("Files already saved stay where they are; new files go here.")
      : `${t("Default:")} ${defaultRoot}`;
  };

  if (dirInput) {
    dirInput.placeholder = defaultRoot;
    dirInput.value = getAgentFilesRootPref();
    dirInput.addEventListener("change", () => {
      const value = dirInput.value.trim();
      if (value && !isAbsoluteLocalPath(value)) {
        if (dirHint) {
          dirHint.style.color = "#dc2626";
          dirHint.textContent = t(
            "Enter a full folder path, such as /Users/me/Documents/LLM files.",
          );
        }
        return;
      }
      setAgentFilesRootPref(value);
      showHint();
      onChange();
    });
  }
  showHint();

  resetBtn?.addEventListener("click", () => {
    setAgentFilesRootPref("");
    if (dirInput) dirInput.value = "";
    showHint();
    onChange();
  });

  revealBtn?.addEventListener("click", async () => {
    const root = getAgentFilesRoot();
    if (!root) return;
    await ensureDir(root);
    revealLocalPath(root);
  });

  let picked = new Set<string>();
  const updateDelete = () => {
    if (deleteBtn) deleteBtn.disabled = picked.size === 0;
  };

  const renderList = (folders: AgentFilesFolderSummary[]) => {
    if (!list) return;
    list.replaceChildren();
    picked = new Set();
    updateDelete();
    if (!folders.length) {
      showStatus(t("No saved files yet."));
      return;
    }
    const total = folders.reduce((sum, folder) => sum + folder.bytes, 0);
    showStatus(
      `${folders.length} ${t("folders")} · ${formatFolderSize(total)}`,
    );
    for (const folder of folders) {
      const row = doc.createElement("label");
      row.className = "llm-agent-files-row";
      row.dataset.status = folder.status;
      const box = doc.createElement("input") as HTMLInputElement;
      box.type = "checkbox";
      box.addEventListener("change", () => {
        if (box.checked) picked.add(folder.path);
        else picked.delete(folder.path);
        updateDelete();
      });
      const text = doc.createElement("span");
      text.className = "llm-agent-files-row-text";
      const name = doc.createElement("div");
      name.className = "llm-agent-files-row-name";
      name.textContent = folder.name;
      name.title = folder.path;
      const sub = doc.createElement("div");
      sub.className = "llm-agent-files-row-sub";
      sub.textContent = `${describeStatus(folder)} · ${folder.fileCount} ${t(
        folder.fileCount === 1 ? "file" : "files",
      )} · ${formatFolderSize(folder.bytes)}`;
      text.append(name, sub);
      row.append(box, text);
      list.appendChild(row);
    }
  };

  const scan = async () => {
    if (scanBtn) scanBtn.disabled = true;
    showStatus(t("Checking…"));
    try {
      renderList(await listAgentFilesFolders());
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      if (scanBtn) scanBtn.disabled = false;
    }
  };
  scanBtn?.addEventListener("click", () => void scan());

  deleteBtn?.addEventListener("click", async () => {
    const paths = [...picked];
    if (!paths.length) return;
    const win = doc.defaultView;
    const question = t(
      "Delete the selected folders and every file in them? This cannot be undone.",
    );
    if (win && !win.confirm(`${question}\n\n${paths.join("\n")}`)) return;
    deleteBtn.disabled = true;
    const { failed } = await deleteAgentFilesFolders(paths);
    await scan();
    if (failed.length) {
      showStatus(`${t("Could not delete:")} ${failed.join(", ")}`, true);
    }
  });

  return {
    summary: () => getAgentFilesRoot() || "",
  };
}
