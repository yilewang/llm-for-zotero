import { t } from "../../utils/i18n";

const STANDALONE_TOOLS_MENU_ID = "llmforzotero-open-standalone";
const ZOTERO_TOOLS_MENU_ID = "menu_ToolsPopup";

export function registerStandaloneToolsMenu(params: {
  document: Document;
  openStandaloneChat: () => void;
}): void {
  const toolsMenu = params.document.getElementById(ZOTERO_TOOLS_MENU_ID);
  if (!toolsMenu) return;

  const menuItem = params.document.createXULElement("menuitem");
  menuItem.id = STANDALONE_TOOLS_MENU_ID;
  menuItem.setAttribute("label", t("LLM Chat Window"));
  menuItem.addEventListener("command", params.openStandaloneChat);
  toolsMenu.appendChild(menuItem);
}

export function unregisterStandaloneToolsMenu(document: Document): void {
  document.getElementById(STANDALONE_TOOLS_MENU_ID)?.remove();
}
