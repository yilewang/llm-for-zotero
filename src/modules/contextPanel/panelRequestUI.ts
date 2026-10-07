/**
 * The panel controls a request reads and writes, found in the panel body.
 */
export type PanelRequestUI = {
  inputBox: HTMLTextAreaElement | null;
  chatBox: HTMLDivElement | null;
  sendBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  status: HTMLElement | null;
  tokenUsageEl: HTMLElement | null;
};

export function getPanelRequestUI(body: Element): PanelRequestUI {
  return {
    inputBox: body.querySelector("#llm-input") as HTMLTextAreaElement | null,
    chatBox: body.querySelector("#llm-chat-box") as HTMLDivElement | null,
    sendBtn: body.querySelector("#llm-send") as HTMLButtonElement | null,
    cancelBtn: body.querySelector("#llm-cancel") as HTMLButtonElement | null,
    status: body.querySelector("#llm-status") as HTMLElement | null,
    tokenUsageEl: body.querySelector("#llm-token-usage") as HTMLElement | null,
  };
}
