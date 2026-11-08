export type LocalPathRevealMethod =
  | "components-reveal"
  | "zotero-file-reveal"
  | "zotero-launch-file";

type LocalPathFile = {
  initWithPath?: (path: string) => void;
  reveal?: () => void;
};

type ComponentsLike = {
  classes?: Record<string, { createInstance?: (iface: unknown) => unknown }>;
  interfaces?: Record<string, unknown>;
};

type ZoteroRevealLike = {
  File?: { reveal?: (path: string) => void };
  launchFile?: (path: string) => void;
};

function getComponentsLike(): ComponentsLike | undefined {
  return (globalThis as unknown as { Components?: ComponentsLike }).Components;
}

function getZoteroRevealLike(): ZoteroRevealLike | undefined {
  return (globalThis as unknown as { Zotero?: ZoteroRevealLike }).Zotero;
}

export function revealLocalPath(path: string): LocalPathRevealMethod | null {
  const normalizedPath = path.trim();
  if (!normalizedPath) return null;

  try {
    const components = getComponentsLike();
    const createLocalFile =
      components?.classes?.["@mozilla.org/file/local;1"]?.createInstance;
    const nsIFile = components?.interfaces?.nsIFile;
    if (typeof createLocalFile === "function" && nsIFile) {
      const file = createLocalFile(nsIFile) as LocalPathFile | undefined;
      if (
        typeof file?.initWithPath === "function" &&
        typeof file.reveal === "function"
      ) {
        file.initWithPath(normalizedPath);
        file.reveal();
        return "components-reveal";
      }
    }
  } catch {
    /* fall through to Zotero helpers */
  }

  try {
    const zotero = getZoteroRevealLike();
    if (typeof zotero?.File?.reveal === "function") {
      zotero.File.reveal(normalizedPath);
      return "zotero-file-reveal";
    }
  } catch {
    /* fall through to launchFile */
  }

  try {
    const zotero = getZoteroRevealLike();
    if (typeof zotero?.launchFile === "function") {
      zotero.launchFile(normalizedPath);
      return "zotero-launch-file";
    }
  } catch {
    /* no available reveal path */
  }

  return null;
}

/** Opens the file in the app the system uses for its type; true if it tried. */
export function launchLocalPath(path: string): boolean {
  const normalizedPath = path.trim();
  if (!normalizedPath) return false;

  try {
    const zotero = getZoteroRevealLike();
    if (typeof zotero?.launchFile === "function") {
      zotero.launchFile(normalizedPath);
      return true;
    }
  } catch {
    /* fall through to nsIFile */
  }

  try {
    const components = getComponentsLike();
    const createLocalFile =
      components?.classes?.["@mozilla.org/file/local;1"]?.createInstance;
    const nsIFile = components?.interfaces?.nsIFile;
    if (typeof createLocalFile === "function" && nsIFile) {
      const file = createLocalFile(nsIFile) as
        | (LocalPathFile & { launch?: () => void })
        | undefined;
      if (
        typeof file?.initWithPath === "function" &&
        typeof file.launch === "function"
      ) {
        file.initWithPath(normalizedPath);
        file.launch();
        return true;
      }
    }
  } catch {
    /* nothing can open it */
  }

  return false;
}
