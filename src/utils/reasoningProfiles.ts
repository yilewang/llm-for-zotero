export type ReasoningProvider = "openai" | "gemini" | "deepseek" | "kimi";
export type ReasoningLevel =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type OpenAIReasoningEffort =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type GeminiThinkingParam = "thinking_level" | "thinking_budget";
export type GeminiThinkingValue = "low" | "medium" | "high" | number;
export type GeminiReasoningOption = {
  level: "low" | "medium" | "high";
  value: GeminiThinkingValue;
};
export type RuntimeReasoningOption = {
  level: ReasoningLevel;
  label: string;
  enabled: boolean;
};
export type OpenAIReasoningProfile = {
  defaultEffort: OpenAIReasoningEffort;
  supportedEfforts: OpenAIReasoningEffort[];
  levelToEffort: Partial<Record<ReasoningLevel, OpenAIReasoningEffort | null>>;
  defaultLevel: ReasoningLevel;
};
export type GeminiReasoningProfile = {
  param: GeminiThinkingParam;
  defaultValue: GeminiThinkingValue;
  options: GeminiReasoningOption[];
  levelToValue: Partial<Record<ReasoningLevel, GeminiThinkingValue>>;
  defaultLevel: ReasoningLevel;
};

type ProviderProfile = {
  supportsReasoning: boolean;
  defaultLevel: ReasoningLevel | null;
  options: RuntimeReasoningOption[];
  openai?: {
    defaultEffort: OpenAIReasoningEffort;
    levelToEffort: Partial<
      Record<ReasoningLevel, OpenAIReasoningEffort | null>
    >;
  };
  gemini?: {
    param: GeminiThinkingParam;
    defaultValue: GeminiThinkingValue;
    levelToValue: Partial<Record<ReasoningLevel, GeminiThinkingValue>>;
  };
  deepseekThinkingEnabled?: boolean;
};

type ProfileRule = {
  match: RegExp;
  profile: ProviderProfile;
};

const option = (
  level: ReasoningLevel,
  label: string,
): RuntimeReasoningOption => {
  return { level, label, enabled: true };
};

const OPENAI_GPT5_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    option("default", "default"),
    option("low", "low"),
    option("medium", "medium"),
    option("high", "high"),
  ],
  openai: {
    defaultEffort: "default",
    levelToEffort: {
      default: null,
      low: "low",
      medium: "medium",
      high: "high",
    },
  },
};

const GEMINI_3_PRO_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: [option("high", "high"), option("low", "low")],
  gemini: {
    param: "thinking_level",
    defaultValue: "high",
    levelToValue: {
      high: "high",
      low: "low",
    },
  },
};

const GEMINI_GENERIC_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "medium",
  options: [
    option("medium", "medium"),
    option("low", "low"),
    option("high", "high"),
  ],
  gemini: {
    param: "thinking_level",
    defaultValue: "medium",
    levelToValue: {
      low: "low",
      medium: "medium",
      high: "high",
    },
  },
};

const DEEPSEEK_REASONER_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [option("default", "enabled")],
  deepseekThinkingEnabled: true,
};

const DEEPSEEK_CHAT_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

const KIMI_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [option("default", "enabled")],
};

const UNSUPPORTED_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

const PROFILE_RULES: Record<
  ReasoningProvider,
  { rules: ProfileRule[]; fallback: ProviderProfile }
> = {
  openai: {
    rules: [
      {
        match: /^(gpt-5(?:\b|[.-])|o\d+(?:\b|[.-]))/,
        profile: OPENAI_GPT5_PROFILE,
      },
    ],
    fallback: OPENAI_GPT5_PROFILE,
  },
  gemini: {
    rules: [
      {
        match: /^gemini-3-pro(?:\b|[.-])/,
        profile: GEMINI_3_PRO_PROFILE,
      },
      {
        match: /\bgemini\b/,
        profile: GEMINI_GENERIC_PROFILE,
      },
    ],
    fallback: GEMINI_GENERIC_PROFILE,
  },
  deepseek: {
    rules: [
      {
        match: /^deepseek-(?:reasoner|r1)(?:\b|[.-])/,
        profile: DEEPSEEK_REASONER_PROFILE,
      },
      {
        match: /^deepseek-chat(?:\b|[.-])/,
        profile: DEEPSEEK_CHAT_PROFILE,
      },
    ],
    fallback: DEEPSEEK_CHAT_PROFILE,
  },
  kimi: {
    rules: [
      {
        match: /^kimi-k2-thinking(?:-turbo)?$/,
        profile: KIMI_THINKING_PROFILE,
      },
    ],
    fallback: UNSUPPORTED_PROFILE,
  },
};

const OPENAI_EFFORT_ORDER: OpenAIReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const REASONING_PROFILE_TABLE_VERSION = 1;

function normalizeModelName(modelName?: string): string {
  return (modelName || "").trim().toLowerCase();
}

function resolveProviderProfile(
  provider: ReasoningProvider,
  modelName?: string,
): ProviderProfile {
  const normalized = normalizeModelName(modelName);
  const table = PROFILE_RULES[provider];
  for (const rule of table.rules) {
    if (rule.match.test(normalized)) {
      return rule.profile;
    }
  }
  return table.fallback;
}

function cloneRuntimeOptions(
  options: RuntimeReasoningOption[],
): RuntimeReasoningOption[] {
  return options.map((entry) => ({ ...entry }));
}

export function getRuntimeReasoningOptionsForModel(
  provider: ReasoningProvider,
  modelName?: string,
): RuntimeReasoningOption[] {
  const profile = resolveProviderProfile(provider, modelName);
  if (!profile.supportsReasoning) return [];
  return cloneRuntimeOptions(profile.options);
}

export function supportsReasoningForModel(
  provider: ReasoningProvider,
  modelName?: string,
): boolean {
  const profile = resolveProviderProfile(provider, modelName);
  if (!profile.supportsReasoning) return false;
  return profile.options.some((optionState) => optionState.enabled);
}

export function getReasoningDefaultLevelForModel(
  provider: ReasoningProvider,
  modelName?: string,
): ReasoningLevel | null {
  const profile = resolveProviderProfile(provider, modelName);
  if (!profile.supportsReasoning) return null;
  if (
    profile.defaultLevel &&
    profile.options.some(
      (optionState) =>
        optionState.enabled && optionState.level === profile.defaultLevel,
    )
  ) {
    return profile.defaultLevel;
  }
  const firstEnabled = profile.options.find(
    (optionState) => optionState.enabled,
  );
  return firstEnabled?.level || null;
}

export function shouldUseDeepseekThinkingPayload(modelName?: string): boolean {
  const profile = resolveProviderProfile("deepseek", modelName);
  return Boolean(profile.deepseekThinkingEnabled);
}

export function getOpenAIReasoningProfileForModel(
  modelName?: string,
): OpenAIReasoningProfile {
  const profile = resolveProviderProfile("openai", modelName);
  const openaiProfile = profile.openai || OPENAI_GPT5_PROFILE.openai;
  const defaultLevel =
    getReasoningDefaultLevelForModel("openai", modelName) || "default";
  const levelToEffort = {
    ...(openaiProfile?.levelToEffort || {}),
  };
  const supportedEfforts = OPENAI_EFFORT_ORDER.filter((effort) => {
    return Object.values(levelToEffort).includes(effort);
  });
  return {
    defaultEffort: openaiProfile?.defaultEffort || "default",
    supportedEfforts,
    levelToEffort,
    defaultLevel,
  };
}

export function getGeminiReasoningProfileForModel(
  modelName?: string,
): GeminiReasoningProfile {
  const profile = resolveProviderProfile("gemini", modelName);
  const geminiProfile = profile.gemini || GEMINI_GENERIC_PROFILE.gemini;
  const defaultLevel =
    getReasoningDefaultLevelForModel("gemini", modelName) || "medium";
  const levelToValue = {
    ...(geminiProfile?.levelToValue || {}),
  };
  const options: GeminiReasoningOption[] = profile.options
    .filter(
      (
        optionState,
      ): optionState is RuntimeReasoningOption & {
        level: "low" | "medium" | "high";
      } =>
        optionState.enabled &&
        (optionState.level === "low" ||
          optionState.level === "medium" ||
          optionState.level === "high"),
    )
    .map((optionState) => {
      const value = levelToValue[optionState.level] ?? optionState.level;
      return {
        level: optionState.level,
        value,
      };
    });
  return {
    param: geminiProfile?.param || "thinking_level",
    defaultValue: geminiProfile?.defaultValue || "medium",
    options,
    levelToValue,
    defaultLevel,
  };
}
