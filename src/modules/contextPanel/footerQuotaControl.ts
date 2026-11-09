import { type QuotaSnapshot, type QuotaTarget } from "../../providers/quota";
import { t } from "../../utils/i18n";

function money(amount: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : "CN¥";
  return amount > 0 && amount < 0.01
    ? `<${symbol}0.01`
    : `${symbol}${amount.toFixed(2)}`;
}

function duration(minutes?: number): string {
  if (!minutes) return t("Quota window");
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function buildQuotaPresentation(snapshot: QuotaSnapshot): {
  text: string;
  title: string;
} | null {
  const { quota } = snapshot;
  if (!quota) return null;
  const details: string[] = [];
  let text: string;
  if (quota.kind === "balance") {
    const first = quota.balances[0];
    if (!first) return null;
    text = money(first.amount, first.currency);
    details.push(
      t(
        quota.scope === "account"
          ? "Account balance"
          : "API key allowance remaining",
      ),
    );
    details.push(
      ...quota.balances.map(
        ({ amount, currency }) => `${currency} ${amount.toFixed(2)}`,
      ),
    );
  } else {
    if (!quota.windows.length) return null;
    const headline = quota.windows.some((window) => !window.secondary)
      ? quota.windows.filter((window) => !window.secondary)
      : quota.windows;
    const highest = Math.max(...headline.map((window) => window.usedPercent));
    text = `${Math.round(highest)}% ${t("used")}`;
    const label = {
      codex: "Codex account quota",
      claude: "Claude Code account quota",
      kimi: "Kimi Code quota",
      glm: "GLM Coding Plan quota",
      minimax: "MiniMax Token Plan quota",
      opencode: "OpenCode Go quota",
      antigravity: "Antigravity quota",
    }[quota.provider ?? "codex"];
    details.push(t(label));
    if (headline.length < quota.windows.length)
      details.push(t("Shows the most-used window for the selected model"));
    else if (quota.windows.length > 1)
      details.push(t("Shows the most-used quota window"));
    for (const window of quota.windows) {
      const windowLabel = window.period
        ? t(
            { rolling: "Rolling window", weekly: "Weekly", monthly: "Monthly" }[
              window.period
            ],
          )
        : duration(window.durationMins);
      const name = window.label
        ? `${t(window.label)} · ${windowLabel}`
        : windowLabel;
      details.push(`${name}: ${Math.round(window.usedPercent)}% ${t("used")}`);
      if (window.resetsAt)
        details.push(
          `${t("Resets")}: ${new Date(window.resetsAt * 1000).toLocaleString()}`,
        );
    }
  }
  details.push(
    `${t("Last checked")}: ${new Date(snapshot.checkedAt).toLocaleString()}`,
  );
  details.push(t("Click to refresh"));
  return { text, title: details.join("\n") };
}

export function attachFooterQuotaControl(params: {
  button: HTMLButtonElement | null;
  getTarget: () => QuotaTarget | null;
  read: (target: QuotaTarget, refresh?: boolean) => Promise<QuotaSnapshot>;
}) {
  const { button } = params;
  const read = params.read;
  let disposed = false;
  let generation = 0;
  let selectedKey = "";
  const hide = () => {
    if (!button) return;
    if (button.style.display !== "none") button.style.display = "none";
    if (button.textContent) button.textContent = "";
    button.removeAttribute("title");
    button.removeAttribute("aria-label");
  };
  const sync = async (refresh = false) => {
    if (disposed || !button) return;
    const target = params.getTarget();
    const key = target ? JSON.stringify(target) : "";
    const requestGeneration = ++generation;
    if (key !== selectedKey || !target) hide();
    selectedKey = key;
    if (!target) return;
    try {
      const snapshot = await read(target, refresh);
      if (disposed || requestGeneration !== generation) return;
      const presentation = buildQuotaPresentation(snapshot);
      if (!presentation) {
        hide();
        return;
      }
      // Model-button updates sync on every panel refresh (pointer reentry
      // included); an unchanged value must not touch the DOM.
      if (button.textContent !== presentation.text) {
        button.textContent = presentation.text;
      }
      if (button.title !== presentation.title) {
        button.title = presentation.title;
        button.setAttribute("aria-label", presentation.title);
      }
      if (button.style.display) button.style.display = "";
    } catch {
      // Optional account telemetry must never interrupt a chat or show zero.
      if (!disposed && requestGeneration === generation) hide();
    }
  };
  const refresh = () => {
    void sync(true);
  };
  const focus = () => {
    void sync();
  };
  button?.addEventListener("click", refresh);
  const win = button?.ownerDocument.defaultView;
  win?.addEventListener("focus", focus);
  return {
    sync,
    dispose() {
      disposed = true;
      generation++;
      button?.removeEventListener("click", refresh);
      win?.removeEventListener("focus", focus);
      hide();
    },
  };
}
