import { config } from "../../package.json";
import {
  getMineruLocalOptions,
  setMineruLocalOption,
  type MineruLocalOptions,
} from "../utils/mineruConfig";
import {
  resolveMineruV1Tier,
  type MineruLocalService,
} from "../utils/mineruLocalClient";
import { t } from "../utils/i18n";

const TIER_QUALIFIERS: Record<string, string> = {
  flash: "fastest",
  basic: "lightweight models",
  standard: "full models",
  advanced: "highest quality",
};

/** State the offered tiers and the tier the next parse will send. */
function describeV1Service(
  service: Extract<MineruLocalService, { api: "v1" }>,
): string {
  const requested = getMineruLocalOptions().tier;
  const resolved = resolveMineruV1Tier(requested, service.tiers);
  const qualifier = TIER_QUALIFIERS[resolved.tier];
  const used = qualifier ? `${resolved.tier} (${t(qualifier)})` : resolved.tier;
  const plan = resolved.fallbackFrom
    ? t("%s isn't offered; %s will be used")
        .replace("%s", resolved.fallbackFrom)
        .replace("%s", used)
    : t(requested === "auto" ? "Auto will use %s" : "%s will be used").replace(
        "%s",
        used,
      );
  const api = service.protocol === "tasks" ? "V1 Tasks" : "V1";
  return `MinerU ${service.version} (${api}) · ${t("tiers: %s").replace("%s", service.tiers.join(", "))} · ${plan}`;
}

export function bindMineruLocalPreferences(
  doc: Document,
  onChange: () => void,
) {
  const options = getMineruLocalOptions();
  let detected: MineruLocalService | undefined;
  const renderStatus = () => {
    const status = doc.getElementById(
      `${config.addonRef}-mineru-local-service`,
    );
    if (status)
      status.textContent = !detected
        ? t("Test Connection detects the local API and available options.")
        : detected.api === "v1"
          ? describeV1Service(detected)
          : `MinerU ${detected.version} (${t("Legacy API")})`;
  };
  for (const key of Object.keys(options) as Array<keyof MineruLocalOptions>) {
    const element = doc.getElementById(
      `${config.addonRef}-mineru-local-${key}`,
    ) as HTMLInputElement | HTMLSelectElement | null;
    if (!element) continue;
    if (key === "imageAnalysis")
      (element as HTMLInputElement).checked = options[key];
    else element.value = options[key];
    element.addEventListener("change", () => {
      if (key === "imageAnalysis")
        setMineruLocalOption(key, (element as HTMLInputElement).checked);
      else setMineruLocalOption(key, element.value as never);
      // The status line names the tier the next parse will use.
      if (key === "tier") renderStatus();
      onChange();
    });
  }
  return (service?: MineruLocalService) => {
    detected = service;
    for (const api of ["legacy", "v1"] as const) {
      const section = doc.getElementById(
        `${config.addonRef}-mineru-${api}-options`,
      );
      if (section)
        section.style.display =
          service && service.api !== api ? "none" : "flex";
    }
    // Unavailable tiers are disabled but a saved one stays selected; the
    // status line explains the fallback.
    const select = doc.getElementById(
      `${config.addonRef}-mineru-local-tier`,
    ) as HTMLSelectElement | null;
    if (select)
      for (const option of Array.from(select.options) as HTMLOptionElement[]) {
        option.disabled =
          service?.api === "v1" &&
          option.value !== "auto" &&
          !service.tiers.includes(option.value);
      }
    renderStatus();
  };
}
