import {
  config,
  BUILTIN_SHORTCUT_FILES,
  MAX_EDITABLE_SHORTCUTS,
  CUSTOM_SHORTCUT_ID_PREFIX,
} from "./constants";
import type { CustomShortcut } from "./types";
import {
  shortcutTextCache,
  shortcutMoveModeState,
  shortcutRenderItemState,
  shortcutEscapeListenerAttached,
} from "./state";
import {
  getShortcutOverrides,
  setShortcutOverrides,
  getShortcutLabelOverrides,
  setShortcutLabelOverrides,
  getDeletedShortcutIds,
  setDeletedShortcutIds,
  getCustomShortcuts,
  setCustomShortcuts,
  getShortcutOrder,
  setShortcutOrder,
  createCustomShortcutId,
  resetShortcutsToDefault,
} from "./prefHelpers";
import { setStatus } from "./textUtils";
import { sendQuestion } from "./chat";

export async function loadShortcutText(file: string): Promise<string> {
  if (shortcutTextCache.has(file)) {
    return shortcutTextCache.get(file)!;
  }
  const uri = `chrome://${config.addonRef}/content/shortcuts/${file}`;
  const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
  const res = await fetchFn(uri);
  if (!res.ok) {
    throw new Error(`Failed to load ${file}`);
  }
  const text = await res.text();
  shortcutTextCache.set(file, text);
  return text;
}

export async function renderShortcuts(
  body: Element,
  item?: Zotero.Item | null,
) {
  shortcutRenderItemState.set(body, item);
  const container = body.querySelector(
    "#llm-shortcuts",
  ) as HTMLDivElement | null;
  const menu = body.querySelector(
    "#llm-shortcut-menu",
  ) as HTMLDivElement | null;
  const menuEdit = body.querySelector(
    "#llm-shortcut-menu-edit",
  ) as HTMLButtonElement | null;
  const menuDelete = body.querySelector(
    "#llm-shortcut-menu-delete",
  ) as HTMLButtonElement | null;
  const menuAdd = body.querySelector(
    "#llm-shortcut-menu-add",
  ) as HTMLButtonElement | null;
  const menuMove = body.querySelector(
    "#llm-shortcut-menu-move",
  ) as HTMLButtonElement | null;
  const menuReset = body.querySelector(
    "#llm-shortcut-menu-reset",
  ) as HTMLButtonElement | null;
  if (!container) return;

  const moveMode = shortcutMoveModeState.get(body) === true;
  container.innerHTML = "";
  const overrides = getShortcutOverrides();
  const labelOverrides = getShortcutLabelOverrides();
  const deletedIds = new Set(getDeletedShortcutIds());
  const builtins = BUILTIN_SHORTCUT_FILES.filter(
    (shortcut) => !deletedIds.has(shortcut.id),
  );
  const customShortcuts = getCustomShortcuts();

  const availableCustomSlots = Math.max(
    0,
    MAX_EDITABLE_SHORTCUTS - builtins.length,
  );
  const visibleCustomShortcuts = customShortcuts.slice(0, availableCustomSlots);
  const editableShortcutsRaw: Array<{
    id: string;
    kind: "builtin" | "custom";
    prompt: string;
    label: string;
    defaultLabel: string;
  }> = [];

  for (const shortcut of builtins) {
    let promptText = (overrides[shortcut.id] || "").trim();
    if (!promptText) {
      try {
        promptText = (await loadShortcutText(shortcut.file)).trim();
      } catch {
        promptText = "";
      }
    }
    const labelText = (labelOverrides[shortcut.id] || shortcut.label).trim();
    editableShortcutsRaw.push({
      id: shortcut.id,
      kind: "builtin",
      prompt: promptText,
      label: labelText || shortcut.label,
      defaultLabel: shortcut.label,
    });
  }

  for (const shortcut of visibleCustomShortcuts) {
    const label = shortcut.label.trim() || "Custom Shortcut";
    editableShortcutsRaw.push({
      id: shortcut.id,
      kind: "custom",
      prompt: shortcut.prompt.trim(),
      label,
      defaultLabel: label,
    });
  }
  const currentVisibleIds = editableShortcutsRaw.map((shortcut) => shortcut.id);
  const currentVisibleSet = new Set(currentVisibleIds);
  const savedOrder = getShortcutOrder();
  const normalizedOrder = [
    ...savedOrder.filter((id) => currentVisibleSet.has(id)),
    ...currentVisibleIds.filter((id) => !savedOrder.includes(id)),
  ];
  if (
    normalizedOrder.length !== savedOrder.length ||
    normalizedOrder.some((id, index) => id !== savedOrder[index])
  ) {
    setShortcutOrder(normalizedOrder);
  }
  const orderIndex = new Map(
    normalizedOrder.map((shortcutId, index) => [shortcutId, index]),
  );
  const editableShortcuts = editableShortcutsRaw.sort(
    (a, b) =>
      (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const orderedEditableIds = editableShortcuts.map((shortcut) => shortcut.id);
  const canAddShortcut = editableShortcuts.length < MAX_EDITABLE_SHORTCUTS;
  let draggingShortcutId = "";
  let draggingButton: HTMLButtonElement | null = null;

  const setMoveMode = async (next: boolean) => {
    shortcutMoveModeState.set(body, next);
    await renderShortcuts(body, item);
  };

  const removeShortcut = async (
    shortcutId: string,
    kind: "builtin" | "custom",
  ) => {
    if (kind === "custom") {
      const nextCustomShortcuts = getCustomShortcuts().filter(
        (shortcut) => shortcut.id !== shortcutId,
      );
      setCustomShortcuts(nextCustomShortcuts);
    } else {
      const nextDeletedIds = new Set(getDeletedShortcutIds());
      nextDeletedIds.add(shortcutId);
      setDeletedShortcutIds(Array.from(nextDeletedIds));

      const nextOverrides = getShortcutOverrides();
      delete nextOverrides[shortcutId];
      setShortcutOverrides(nextOverrides);

      const nextLabelOverrides = getShortcutLabelOverrides();
      delete nextLabelOverrides[shortcutId];
      setShortcutLabelOverrides(nextLabelOverrides);
    }

    const nextOrder = getShortcutOrder().filter((id) => id !== shortcutId);
    setShortcutOrder(nextOrder);
    await renderShortcuts(body, item);
  };

  const addShortcut = async () => {
    const updated = await openShortcutEditDialog("", "", "Add Shortcut");
    if (!updated) return;

    const prompt = updated.prompt.trim();
    if (!prompt) {
      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (status) setStatus(status, "Shortcut prompt cannot be empty", "error");
      return;
    }

    const currentDeleted = new Set(getDeletedShortcutIds());
    const visibleBuiltinCount = BUILTIN_SHORTCUT_FILES.filter(
      (shortcut) => !currentDeleted.has(shortcut.id),
    ).length;
    const currentCustomShortcuts = getCustomShortcuts();
    if (
      visibleBuiltinCount + currentCustomShortcuts.length >=
      MAX_EDITABLE_SHORTCUTS
    ) {
      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (status) {
        setStatus(
          status,
          `Maximum ${MAX_EDITABLE_SHORTCUTS} editable shortcuts allowed`,
          "error",
        );
      }
      return;
    }

    const nextCustomShortcut: CustomShortcut = {
      id: createCustomShortcutId(),
      label: updated.label.trim() || "Custom Shortcut",
      prompt,
    };
    const nextCustomShortcuts = [...currentCustomShortcuts, nextCustomShortcut];
    setCustomShortcuts(nextCustomShortcuts);
    const currentOrder = getShortcutOrder().filter((id) =>
      currentVisibleSet.has(id),
    );
    setShortcutOrder([...currentOrder, nextCustomShortcut.id]);
    await renderShortcuts(body, item);
  };

  const positionShortcutMenu = (x: number, y: number) => {
    if (!menu) return;
    const win = body.ownerDocument?.defaultView;
    if (!win) return;

    const viewportMargin = 8;
    menu.style.position = "fixed";
    menu.style.display = "grid";
    menu.style.visibility = "hidden";
    menu.style.maxHeight = `${Math.max(120, win.innerHeight - viewportMargin * 2)}px`;
    menu.style.overflowY = "auto";

    const menuRect = menu.getBoundingClientRect();
    const maxLeft = win.innerWidth - menuRect.width - viewportMargin;
    const maxTop = win.innerHeight - menuRect.height - viewportMargin;
    const left = Math.min(
      Math.max(viewportMargin, x),
      Math.max(viewportMargin, maxLeft),
    );
    const top = Math.min(
      Math.max(viewportMargin, y),
      Math.max(viewportMargin, maxTop),
    );

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = "visible";
  };

  const openMenuForShortcut = (
    event: MouseEvent,
    shortcutId: string,
    shortcutKind: "builtin" | "custom",
  ) => {
    if (
      !menu ||
      !menuEdit ||
      !menuDelete ||
      !menuAdd ||
      !menuMove ||
      !menuReset
    ) {
      return;
    }
    menu.dataset.menuKind = "shortcut";
    menu.dataset.shortcutId = shortcutId;
    menu.dataset.shortcutKind = shortcutKind;
    menuEdit.style.display = "flex";
    menuDelete.style.display = "flex";
    menuAdd.style.display = "none";
    menuMove.style.display = "none";
    menuReset.style.display = "none";
    menu.style.display = "grid";
    positionShortcutMenu(event.clientX + 4, event.clientY + 4);
  };

  const openMenuForPanel = (event: MouseEvent) => {
    if (
      !menu ||
      !menuEdit ||
      !menuDelete ||
      !menuAdd ||
      !menuMove ||
      !menuReset
    ) {
      return;
    }
    menu.dataset.menuKind = "panel";
    menu.dataset.shortcutId = "";
    menu.dataset.shortcutKind = "";
    menuEdit.style.display = "none";
    menuDelete.style.display = "none";
    menuAdd.style.display = "flex";
    menuMove.style.display = "flex";
    menuReset.style.display = "flex";
    menuAdd.disabled = !canAddShortcut;
    menuMove.disabled = orderedEditableIds.length < 2;
    menu.style.display = "grid";
    positionShortcutMenu(event.clientX + 4, event.clientY + 4);
  };

  for (const shortcut of editableShortcuts) {
    const btn = body.ownerDocument!.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    btn.className = "llm-shortcut-btn";
    btn.type = "button";
    btn.textContent = "";
    btn.dataset.shortcutId = shortcut.id;
    btn.dataset.shortcutKind = shortcut.kind;
    btn.dataset.prompt = shortcut.prompt;
    btn.dataset.label = shortcut.label;
    btn.dataset.defaultLabel = shortcut.defaultLabel;
    btn.disabled = !moveMode && (!item || !shortcut.prompt);
    btn.draggable = moveMode;
    if (moveMode) btn.classList.add("llm-shortcut-move-mode");

    if (moveMode) {
      const handle = body.ownerDocument!.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "span",
      ) as HTMLSpanElement;
      handle.className = "llm-shortcut-drag-handle";
      handle.textContent = "≡";
      handle.title = "Drag to reorder";
      handle.draggable = false;
      handle.addEventListener("click", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.appendChild(handle);
    }

    const label = body.ownerDocument!.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLSpanElement;
    label.className = "llm-shortcut-label";
    label.textContent = shortcut.label;
    btn.appendChild(label);

    container.appendChild(btn);
  }

  const getShortcutButtonFromEventTarget = (
    target: EventTarget | null,
  ): HTMLButtonElement | null => {
    const node = target as Node | null;
    if (!node || typeof node !== "object") return null;
    let element: Element | null = null;
    if ((node as any).nodeType === 1) {
      element = node as unknown as Element;
    } else if ((node as any).nodeType === 3) {
      element = (node as any).parentElement || null;
    }
    if (!element || typeof (element as any).closest !== "function") return null;
    const btn = element.closest(
      ".llm-shortcut-btn",
    ) as HTMLButtonElement | null;
    if (!btn || !container.contains(btn)) return null;
    return btn;
  };

  container.onclick = (e: Event) => {
    const mouseEvent = e as MouseEvent;
    const btn = getShortcutButtonFromEventTarget(mouseEvent.target);
    if (!btn) return;
    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
    const shortcutId = btn.dataset.shortcutId || "";
    if (!shortcutId || moveMode || !item) return;
    const nextPrompt = (btn.dataset.prompt || "").trim();
    if (!nextPrompt) return;
    sendQuestion(body, item, nextPrompt);
  };

  container.oncontextmenu = (e: Event) => {
    const mouseEvent = e as MouseEvent;
    const btn = getShortcutButtonFromEventTarget(mouseEvent.target);
    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
    if (!btn) {
      openMenuForPanel(mouseEvent);
      return;
    }
    const shortcutId = btn.dataset.shortcutId || "";
    const shortcutKind = btn.dataset.shortcutKind || "";
    if (
      shortcutId &&
      (shortcutKind === "builtin" || shortcutKind === "custom")
    ) {
      openMenuForShortcut(mouseEvent, shortcutId, shortcutKind);
    }
  };

  container.ondragstart = (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    if (!btn) return;
    const shortcutId = btn.dataset.shortcutId || "";
    if (!shortcutId) {
      dragEvent.preventDefault();
      return;
    }
    draggingShortcutId = shortcutId;
    draggingButton = btn;
    btn.classList.add("llm-shortcut-dragging");
    if (dragEvent.dataTransfer) {
      dragEvent.dataTransfer.effectAllowed = "move";
      dragEvent.dataTransfer.setData("text/plain", shortcutId);
      const rect = btn.getBoundingClientRect();
      dragEvent.dataTransfer.setDragImage(
        btn,
        Math.floor(rect.width / 2),
        Math.floor(rect.height / 2),
      );
    }
  };

  container.ondragenter = (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    dragEvent.preventDefault();
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    if (!btn) return;
    const targetId = btn.dataset.shortcutId || "";
    if (!draggingShortcutId || !targetId || draggingShortcutId === targetId) {
      return;
    }
    btn.classList.add("llm-shortcut-drop-target");
  };

  container.ondragover = (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    dragEvent.preventDefault();
    if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "move";
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    if (!btn) return;
    const targetId = btn.dataset.shortcutId || "";
    if (!draggingShortcutId || !targetId || draggingShortcutId === targetId) {
      return;
    }
    btn.classList.add("llm-shortcut-drop-target");
  };

  container.ondragleave = (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    btn?.classList.remove("llm-shortcut-drop-target");
  };

  container.ondrop = async (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    dragEvent.preventDefault();
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    if (!btn) return;
    btn.classList.remove("llm-shortcut-drop-target");
    const targetId = btn.dataset.shortcutId || "";
    if (!targetId || !draggingShortcutId || draggingShortcutId === targetId) {
      return;
    }
    const sourceId =
      draggingShortcutId ||
      (dragEvent.dataTransfer
        ? dragEvent.dataTransfer.getData("text/plain")
        : "");
    if (!sourceId) return;
    const nextOrder = orderedEditableIds.slice();
    const fromIndex = nextOrder.indexOf(sourceId);
    const toIndex = nextOrder.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setShortcutOrder(nextOrder);
    await renderShortcuts(body, item);
  };

  container.ondragend = () => {
    draggingShortcutId = "";
    if (draggingButton) {
      draggingButton.classList.remove("llm-shortcut-dragging");
      draggingButton = null;
    }
    const highlighted = container.querySelectorAll(".llm-shortcut-drop-target");
    highlighted.forEach((el: Element) =>
      (el as HTMLElement).classList.remove("llm-shortcut-drop-target"),
    );
  };

  if (menu && menuEdit && menuDelete && menuAdd && menuMove && menuReset) {
    menuEdit.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "shortcut") return;
      const shortcutId = menu.dataset.shortcutId || "";
      const shortcutKind = menu.dataset.shortcutKind || "";
      if (!shortcutId || !shortcutKind) return;
      const target = container.querySelector(
        `.llm-shortcut-btn[data-shortcut-id="${shortcutId}"]`,
      ) as HTMLButtonElement | null;
      const currentPrompt = target?.dataset.prompt || "";
      const currentLabel = target?.dataset.label || "";
      const updated = await openShortcutEditDialog(currentLabel, currentPrompt);
      if (!updated) {
        menu.style.display = "none";
        return;
      }
      const nextPrompt = updated.prompt.trim();
      if (!nextPrompt) {
        const status = body.querySelector("#llm-status") as HTMLElement | null;
        if (status)
          setStatus(status, "Shortcut prompt cannot be empty", "error");
        menu.style.display = "none";
        return;
      }
      const nextLabel = updated.label.trim();

      if (shortcutKind === "custom") {
        const nextCustomShortcuts = getCustomShortcuts().map((shortcut) =>
          shortcut.id === shortcutId
            ? {
                ...shortcut,
                label: nextLabel || shortcut.label || "Custom Shortcut",
                prompt: nextPrompt,
              }
            : shortcut,
        );
        setCustomShortcuts(nextCustomShortcuts);
      } else {
        const nextOverrides = getShortcutOverrides();
        nextOverrides[shortcutId] = nextPrompt;
        setShortcutOverrides(nextOverrides);

        const nextLabelOverrides = getShortcutLabelOverrides();
        if (nextLabel) {
          nextLabelOverrides[shortcutId] = nextLabel;
        } else {
          delete nextLabelOverrides[shortcutId];
        }
        setShortcutLabelOverrides(nextLabelOverrides);
      }

      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
      await renderShortcuts(body, item);
    };

    menuDelete.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "shortcut") return;
      const shortcutId = menu.dataset.shortcutId || "";
      const shortcutKind = menu.dataset.shortcutKind || "";
      if (
        !shortcutId ||
        (shortcutKind !== "builtin" && shortcutKind !== "custom")
      ) {
        return;
      }
      await removeShortcut(shortcutId, shortcutKind);
      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
    };

    menuAdd.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "panel" || menuAdd.disabled) return;
      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
      await addShortcut();
    };

    menuMove.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "panel" || menuMove.disabled) return;
      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
      const next = shortcutMoveModeState.get(body) !== true;
      await setMoveMode(next);
    };

    menuReset.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "panel") return;
      const shouldReset = await openResetShortcutsDialog();
      if (!shouldReset) {
        menu.style.display = "none";
        menu.dataset.menuKind = "";
        menu.dataset.shortcutId = "";
        menu.dataset.shortcutKind = "";
        return;
      }
      resetShortcutsToDefault();
      shortcutMoveModeState.set(body, false);
      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
      await renderShortcuts(body, item);
    };

    const bodyEl = body as HTMLElement;
    if (!bodyEl.dataset.llmShortcutBodyClickAttached) {
      bodyEl.dataset.llmShortcutBodyClickAttached = "true";
      body.addEventListener("click", (e: Event) => {
        const target = e.target as Node | null;
        const targetEl = target as Element | null;
        const clickedShortcutButton = Boolean(
          targetEl?.closest(".llm-shortcut-btn"),
        );
        menu.style.display = "none";
        menu.dataset.menuKind = "";
        menu.dataset.shortcutId = "";
        menu.dataset.shortcutKind = "";
        if (
          shortcutMoveModeState.get(body) === true &&
          !clickedShortcutButton
        ) {
          shortcutMoveModeState.set(body, false);
          const latestItem = shortcutRenderItemState.get(body);
          void renderShortcuts(body, latestItem);
        }
        if (shortcutMoveModeState.get(body) === true && !target) {
          shortcutMoveModeState.set(body, false);
          const latestItem = shortcutRenderItemState.get(body);
          void renderShortcuts(body, latestItem);
        }
      });
    }

    const ownerDoc = body.ownerDocument;
    if (ownerDoc && !shortcutEscapeListenerAttached.has(ownerDoc)) {
      shortcutEscapeListenerAttached.add(ownerDoc);
      ownerDoc.addEventListener(
        "keydown",
        (e: Event) => {
          const keyEvent = e as KeyboardEvent;
          if (keyEvent.key !== "Escape") return;
          if (shortcutMoveModeState.get(body) !== true) return;
          keyEvent.preventDefault();
          shortcutMoveModeState.set(body, false);
          const latestItem = shortcutRenderItemState.get(body);
          void renderShortcuts(body, latestItem);
        },
        true,
      );
    }
  }
}

export async function openShortcutEditDialog(
  initialLabel: string,
  initialPrompt: string,
  dialogTitle = "Edit Shortcut",
): Promise<{ label: string; prompt: string } | null> {
  const dialogData: { [key: string]: any } = {
    labelValue: initialLabel || "",
    promptValue: initialPrompt || "",
    loadCallback: () => {
      return;
    },
    unloadCallback: () => {
      return;
    },
  };

  const dialog = new ztoolkit.Dialog(3, 2)
    .addCell(0, 0, {
      tag: "h2",
      properties: { innerHTML: dialogTitle },
      styles: { margin: "0 0 8px 0" },
    })
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      attributes: { for: "llm-shortcut-label-input" },
      properties: { innerHTML: "Label" },
    })
    .addCell(
      1,
      1,
      {
        tag: "input",
        namespace: "html",
        id: "llm-shortcut-label-input",
        attributes: {
          "data-bind": "labelValue",
          "data-prop": "value",
          type: "text",
        },
        styles: {
          width: "300px",
        },
      },
      false,
    )
    .addCell(2, 0, {
      tag: "label",
      namespace: "html",
      attributes: { for: "llm-shortcut-prompt-input" },
      properties: { innerHTML: "Prompt" },
    })
    .addCell(
      2,
      1,
      {
        tag: "textarea",
        namespace: "html",
        id: "llm-shortcut-prompt-input",
        attributes: {
          "data-bind": "promptValue",
          "data-prop": "value",
          rows: "6",
        },
        styles: {
          width: "300px",
        },
      },
      false,
    )
    .addButton("Save", "save")
    .addButton("Cancel", "cancel")
    .setDialogData(dialogData)
    .open(dialogTitle);

  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  addon.data.dialog = undefined;

  if (dialogData._lastButtonId !== "save") return null;

  return {
    label: dialogData.labelValue || "",
    prompt: dialogData.promptValue || "",
  };
}

export async function openResetShortcutsDialog(): Promise<boolean> {
  const dialogData: { [key: string]: any } = {
    loadCallback: () => {
      return;
    },
    unloadCallback: () => {
      return;
    },
  };

  const dialog = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: {
        innerHTML: "Reset all shortcuts to default settings?",
      },
      styles: {
        width: "320px",
        lineHeight: "1.45",
      },
    })
    .addButton("Reset", "reset")
    .addButton("Cancel", "cancel")
    .setDialogData(dialogData)
    .open("Reset Shortcuts");

  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  addon.data.dialog = undefined;
  return dialogData._lastButtonId === "reset";
}
