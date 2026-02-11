export const REASONING_PROFILE_TABLE_VERSION = 6;

export type ReasoningProvider =
  | "openai"
  | "gemini"
  | "deepseek"
  | "kimi"
  | "qwen"
  | "grok"
  | "anthropic";
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
  level: ReasoningLevel;
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
export type AnthropicReasoningProfile = {
  defaultBudgetTokens: number;
  levelToBudgetTokens: Partial<Record<ReasoningLevel, number>>;
  defaultLevel: ReasoningLevel;
};
export type QwenReasoningProfile = {
  defaultEnableThinking: boolean | null;
  levelToEnableThinking: Partial<Record<ReasoningLevel, boolean | null>>;
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
  anthropic?: {
    defaultBudgetTokens: number;
    levelToBudgetTokens: Partial<Record<ReasoningLevel, number>>;
  };
  qwen?: {
    defaultEnableThinking: boolean | null;
    levelToEnableThinking: Partial<Record<ReasoningLevel, boolean | null>>;
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

function singleEnabledOptionProfile(
  level: ReasoningLevel,
  label: string,
  extras: Omit<
    Partial<ProviderProfile>,
    "supportsReasoning" | "defaultLevel" | "options"
  > = {},
): ProviderProfile {
  return {
    supportsReasoning: true,
    defaultLevel: level,
    options: [option(level, label)],
    ...extras,
  };
}

function getResolvedDefaultLevel(
  provider: ReasoningProvider,
  modelName: string | undefined,
  fallback: ReasoningLevel,
): ReasoningLevel {
  return getReasoningDefaultLevelForModel(provider, modelName) || fallback;
}

function cloneLevelMap<T>(
  levelMap?: Partial<Record<ReasoningLevel, T>>,
): Partial<Record<ReasoningLevel, T>> {
  return { ...(levelMap || {}) };
}

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

const OPENAI_GPT52_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    option("default", "default"),
    option("low", "low"),
    option("medium", "medium"),
    option("high", "high"),
    option("xhigh", "xhigh"),
  ],
  openai: {
    defaultEffort: "default",
    levelToEffort: {
      default: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
  },
};

const GROK_3_MINI_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    option("default", "default"),
    option("low", "low"),
    option("high", "high"),
  ],
  openai: {
    defaultEffort: "default",
    levelToEffort: {
      default: null,
      low: "low",
      high: "high",
    },
  },
};

const GROK_REASONING_PROFILE: ProviderProfile = singleEnabledOptionProfile(
  "default",
  "enabled",
);

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

const GEMINI_25_PRO_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    option("default", "dynamic"),
    option("low", "128"),
    option("high", "32768"),
  ],
  gemini: {
    param: "thinking_budget",
    defaultValue: -1,
    levelToValue: {
      default: -1,
      low: 128,
      high: 32768,
    },
  },
};

const GEMINI_25_FLASH_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    option("default", "dynamic"),
    option("minimal", "off"),
    option("low", "1"),
    option("high", "24576"),
  ],
  gemini: {
    param: "thinking_budget",
    defaultValue: -1,
    levelToValue: {
      default: -1,
      minimal: 0,
      low: 1,
      high: 24576,
    },
  },
};

const GEMINI_25_FLASH_LITE_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    option("default", "off"),
    option("minimal", "dynamic"),
    option("low", "512"),
    option("high", "24576"),
  ],
  gemini: {
    param: "thinking_budget",
    defaultValue: 0,
    levelToValue: {
      default: 0,
      minimal: -1,
      low: 512,
      high: 24576,
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

const DEEPSEEK_REASONER_PROFILE: ProviderProfile = singleEnabledOptionProfile(
  "default",
  "enabled",
  {
    deepseekThinkingEnabled: true,
  },
);

const DEEPSEEK_CHAT_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

const KIMI_THINKING_PROFILE: ProviderProfile = singleEnabledOptionProfile(
  "default",
  "enabled",
);

const QWEN_TOGGLE_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    option("default", "default"),
    option("high", "enabled"),
    option("low", "disabled"),
  ],
  qwen: {
    defaultEnableThinking: null,
    levelToEnableThinking: {
      default: null,
      high: true,
      low: false,
    },
  },
};

const QWEN_THINKING_ONLY_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [option("default", "enabled")],
  qwen: {
    defaultEnableThinking: true,
    levelToEnableThinking: {
      default: true,
    },
  },
};

const QWEN_NON_THINKING_ONLY_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
  qwen: {
    defaultEnableThinking: false,
    levelToEnableThinking: {},
  },
};

const ANTHROPIC_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    option("default", "2000"),
    option("low", "1024"),
    option("high", "10000"),
  ],
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: {
      default: 2000,
      low: 1024,
      high: 10000,
    },
  },
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
        match: /^gpt-5\.2(?:\b|[.-])/,
        profile: OPENAI_GPT52_PROFILE,
      },
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
        match: /(^|[/:])gemini-2\.5-pro(?:\b|[.-])/,
        profile: GEMINI_25_PRO_PROFILE,
      },
      {
        match: /(^|[/:])gemini-2\.5-flash-lite(?:\b|[.-])/,
        profile: GEMINI_25_FLASH_LITE_PROFILE,
      },
      {
        match: /(^|[/:])gemini-2\.5-flash(?:\b|[.-])/,
        profile: GEMINI_25_FLASH_PROFILE,
      },
      {
        match: /(^|[/:])gemini-2\.5(?:\b|[.-])/,
        profile: GEMINI_25_FLASH_PROFILE,
      },
      {
        match: /(^|[/:])gemini-3-pro(?:\b|[.-])/,
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
        match: /^kimi-k2(?:\.5)?(?:-thinking(?:-turbo)?)?(?:\b|[.-])/,
        profile: KIMI_THINKING_PROFILE,
      },
      {
        match: /^kimi(?:\b|[.-])/,
        profile: KIMI_THINKING_PROFILE,
      },
    ],
    fallback: KIMI_THINKING_PROFILE,
  },
  qwen: {
    rules: [
      {
        match: /(^|[/:])qwen3-[\w.-]*instruct-2507(?:\b|[.-])/,
        profile: QWEN_NON_THINKING_ONLY_PROFILE,
      },
      {
        match: /(^|[/:])(?:qwen3-[\w.-]*thinking-2507|qwq)(?:\b|[.-])/,
        profile: QWEN_THINKING_ONLY_PROFILE,
      },
      {
        match: /(^|[/:])qwen(?:\d+)?(?:\b|[.-])/,
        profile: QWEN_TOGGLE_PROFILE,
      },
    ],
    fallback: QWEN_TOGGLE_PROFILE,
  },
  grok: {
    rules: [
      {
        match: /^grok-3-mini(?:\b|[.-])/,
        profile: GROK_3_MINI_PROFILE,
      },
      {
        match: /(^|[/:])grok(?:\b|[.-])/,
        profile: GROK_REASONING_PROFILE,
      },
    ],
    fallback: GROK_REASONING_PROFILE,
  },
  anthropic: {
    rules: [
      {
        match: /(^|[/:])claude(?:\b|[.-])/,
        profile: ANTHROPIC_THINKING_PROFILE,
      },
    ],
    fallback: ANTHROPIC_THINKING_PROFILE,
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
  return getReasoningEffortProfileForModel("openai", modelName);
}

export function getGrokReasoningProfileForModel(
  modelName?: string,
): OpenAIReasoningProfile {
  return getReasoningEffortProfileForModel("grok", modelName);
}

function getReasoningEffortProfileForModel(
  provider: "openai" | "grok",
  modelName?: string,
): OpenAIReasoningProfile {
  const profile = resolveProviderProfile(provider, modelName);
  const fallbackOpenAIProfile =
    provider === "openai" ? OPENAI_GPT5_PROFILE.openai : undefined;
  const openaiProfile = profile.openai || fallbackOpenAIProfile;
  const defaultLevel = getResolvedDefaultLevel(provider, modelName, "default");
  const levelToEffort = cloneLevelMap(openaiProfile?.levelToEffort);
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

export function getAnthropicReasoningProfileForModel(
  modelName?: string,
): AnthropicReasoningProfile {
  const profile = resolveProviderProfile("anthropic", modelName);
  const anthropicProfile =
    profile.anthropic || ANTHROPIC_THINKING_PROFILE.anthropic;
  const defaultLevel = getResolvedDefaultLevel(
    "anthropic",
    modelName,
    "default",
  );
  return {
    defaultBudgetTokens: anthropicProfile?.defaultBudgetTokens || 2000,
    levelToBudgetTokens: cloneLevelMap(anthropicProfile?.levelToBudgetTokens),
    defaultLevel,
  };
}

export function getQwenReasoningProfileForModel(
  modelName?: string,
): QwenReasoningProfile {
  const profile = resolveProviderProfile("qwen", modelName);
  const qwenProfile = profile.qwen || QWEN_TOGGLE_PROFILE.qwen;
  const defaultLevel = getResolvedDefaultLevel("qwen", modelName, "default");
  return {
    defaultEnableThinking: qwenProfile?.defaultEnableThinking ?? null,
    levelToEnableThinking: cloneLevelMap(qwenProfile?.levelToEnableThinking),
    defaultLevel,
  };
}

export function getGeminiReasoningProfileForModel(
  modelName?: string,
): GeminiReasoningProfile {
  const profile = resolveProviderProfile("gemini", modelName);
  const geminiProfile = profile.gemini || GEMINI_GENERIC_PROFILE.gemini;
  const defaultLevel = getResolvedDefaultLevel("gemini", modelName, "medium");
  const levelToValue = cloneLevelMap(geminiProfile?.levelToValue);
  const options: GeminiReasoningOption[] = profile.options
    .filter((optionState) => optionState.enabled)
    .map((optionState) => {
      const mappedValue = levelToValue[optionState.level];
      const value =
        mappedValue !== undefined
          ? mappedValue
          : optionState.level === "low" ||
              optionState.level === "medium" ||
              optionState.level === "high"
            ? optionState.level
            : (geminiProfile?.defaultValue ?? "medium");
      return {
        level: optionState.level,
        value,
      };
    });
  return {
    param: geminiProfile?.param ?? "thinking_level",
    defaultValue: geminiProfile?.defaultValue ?? "medium",
    options,
    levelToValue,
    defaultLevel,
  };
}
