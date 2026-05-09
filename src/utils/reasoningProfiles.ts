const REASONING_PROFILE_TABLE_VERSION = 6;

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
export type AnthropicThinkingMode = "adaptive" | "manual" | "none";
export type AnthropicAdaptiveEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type AnthropicReasoningProfile = {
  defaultBudgetTokens: number;
  levelToBudgetTokens: Partial<Record<ReasoningLevel, number>>;
  levelToEffort: Partial<Record<ReasoningLevel, AnthropicAdaptiveEffort>>;
  defaultLevel: ReasoningLevel;
  preferredMode: AnthropicThinkingMode;
  supportsAdaptiveThinking: boolean;
  supportsManualThinking: boolean;
};
export type QwenReasoningProfile = {
  defaultEnableThinking: boolean | null;
  levelToEnableThinking: Partial<Record<ReasoningLevel, boolean | null>>;
  defaultLevel: ReasoningLevel;
};
export type DeepseekThinkingType = "enabled" | "disabled";
export type DeepseekReasoningEffort = "high" | "max";
export type DeepseekReasoningProfile = {
  defaultThinkingType: DeepseekThinkingType | null;
  defaultReasoningEffort: DeepseekReasoningEffort | null;
  levelToThinkingType: Partial<Record<ReasoningLevel, DeepseekThinkingType>>;
  levelToReasoningEffort: Partial<
    Record<ReasoningLevel, DeepseekReasoningEffort | null>
  >;
  defaultLevel: ReasoningLevel;
  omitTemperatureWhenThinking: boolean;
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
    levelToEffort?: Partial<Record<ReasoningLevel, AnthropicAdaptiveEffort>>;
    preferredMode: AnthropicThinkingMode;
    supportsAdaptiveThinking: boolean;
    supportsManualThinking: boolean;
  };
  qwen?: {
    defaultEnableThinking: boolean | null;
    levelToEnableThinking: Partial<Record<ReasoningLevel, boolean | null>>;
  };
  deepseek?: {
    defaultThinkingType: DeepseekThinkingType | null;
    defaultReasoningEffort: DeepseekReasoningEffort | null;
    levelToThinkingType: Partial<Record<ReasoningLevel, DeepseekThinkingType>>;
    levelToReasoningEffort: Partial<
      Record<ReasoningLevel, DeepseekReasoningEffort | null>
    >;
    omitTemperatureWhenThinking?: boolean;
  };
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

const OPENAI_GPT5_XHIGH_PROFILE: ProviderProfile = {
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

const OPENAI_GPT5_PRO_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: [option("high", "high")],
  openai: {
    defaultEffort: "high",
    levelToEffort: {
      high: "high",
    },
  },
};

const OPENAI_GPT5_XHIGH_PRO_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "medium",
  options: [
    option("medium", "medium"),
    option("high", "high"),
    option("xhigh", "xhigh"),
  ],
  openai: {
    defaultEffort: "medium",
    levelToEffort: {
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
  },
};

const OPENAI_GPT5_CODEX_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "low",
  options: [
    option("low", "low"),
    option("medium", "medium"),
    option("high", "high"),
    option("xhigh", "xhigh"),
  ],
  openai: {
    defaultEffort: "low",
    levelToEffort: {
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
    deepseek: {
      defaultThinkingType: "enabled",
      defaultReasoningEffort: null,
      levelToThinkingType: {
        default: "enabled",
      },
      levelToReasoningEffort: {
        default: null,
      },
      omitTemperatureWhenThinking: false,
    },
  },
);

const DEEPSEEK_V4_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [
    option("default", "default"),
    option("minimal", "disabled"),
    option("high", "high"),
    option("xhigh", "max"),
  ],
  deepseek: {
    defaultThinkingType: "enabled",
    defaultReasoningEffort: "high",
    levelToThinkingType: {
      default: "enabled",
      minimal: "disabled",
      high: "enabled",
      xhigh: "enabled",
    },
    levelToReasoningEffort: {
      default: "high",
      minimal: null,
      high: "high",
      xhigh: "max",
    },
    omitTemperatureWhenThinking: true,
  },
};

const DEEPSEEK_CHAT_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

const KIMI_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [option("default", "enabled"), option("minimal", "disabled")],
};

const KIMI_NON_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

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

const ANTHROPIC_ADAPTIVE_MAX_OPTIONS: RuntimeReasoningOption[] = [
  option("low", "low"),
  option("medium", "medium"),
  option("high", "high"),
  option("xhigh", "max"),
];

const ANTHROPIC_ADAPTIVE_XHIGH_OPTIONS: RuntimeReasoningOption[] = [
  option("low", "low"),
  option("medium", "medium"),
  option("high", "high"),
  option("xhigh", "xhigh"),
];

const ANTHROPIC_MANUAL_OPTIONS: RuntimeReasoningOption[] = [
  option("low", "1024"),
  option("medium", "2000"),
  option("high", "10000"),
  option("xhigh", "32000"),
];

const ANTHROPIC_MAX_EFFORT_MAP: Partial<
  Record<ReasoningLevel, AnthropicAdaptiveEffort>
> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

const ANTHROPIC_XHIGH_EFFORT_MAP: Partial<
  Record<ReasoningLevel, AnthropicAdaptiveEffort>
> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

const ANTHROPIC_BUDGET_MAP: Partial<Record<ReasoningLevel, number>> = {
  low: 1024,
  medium: 2000,
  high: 10000,
  xhigh: 32000,
};

const ANTHROPIC_ADAPTIVE_ONLY_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_MAX_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_MAX_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: false,
  },
};

const ANTHROPIC_OPUS_47_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_XHIGH_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_XHIGH_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: false,
  },
};

const ANTHROPIC_ADAPTIVE_WITH_MANUAL_FALLBACK_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_MAX_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_MAX_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: true,
  },
};

const ANTHROPIC_MANUAL_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "medium",
  options: ANTHROPIC_MANUAL_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: {},
    preferredMode: "manual",
    supportsAdaptiveThinking: false,
    supportsManualThinking: true,
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
        match: /^gpt-5\.(?:2|4)-pro(?:\b|[.-])/,
        profile: OPENAI_GPT5_XHIGH_PRO_PROFILE,
      },
      {
        match: /^gpt-5-pro(?:\b|[.-])/,
        profile: OPENAI_GPT5_PRO_PROFILE,
      },
      {
        match: /^gpt-5\.(?:2|3)-codex(?:\b|[.-])/,
        profile: OPENAI_GPT5_CODEX_PROFILE,
      },
      {
        match: /^gpt-5\.4(?:\b|[.-])/,
        profile: OPENAI_GPT5_XHIGH_PROFILE,
      },
      {
        match: /^gpt-5\.2(?:\b|[.-])/,
        profile: OPENAI_GPT5_XHIGH_PROFILE,
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
        match: /(^|[/:])deepseek-v4-(?:flash|pro)(?:\b|[.-])/,
        profile: DEEPSEEK_V4_PROFILE,
      },
      {
        match: /(^|[/:])deepseek-(?:reasoner|r1)(?:\b|[.-])/,
        profile: DEEPSEEK_REASONER_PROFILE,
      },
      {
        match: /(^|[/:])deepseek-chat(?:\b|[.-])/,
        profile: DEEPSEEK_CHAT_PROFILE,
      },
    ],
    fallback: DEEPSEEK_CHAT_PROFILE,
  },
  kimi: {
    rules: [
      {
        // kimi-k2-thinking, kimi-k2.5-thinking — always-on thinking
        match: /^kimi-k2(?:\.5)?-thinking(?:-turbo)?(?:\b|[.-])/,
        profile: KIMI_THINKING_PROFILE,
      },
      {
        // kimi-k2.5 — supports toggling thinking on/off
        match: /^kimi-k2\.5(?:\b|[.-])/,
        profile: KIMI_THINKING_PROFILE,
      },
      {
        // kimi-k2 (without .5) — supports toggling
        match: /^kimi-k2(?:\b|[.-])/,
        profile: KIMI_THINKING_PROFILE,
      },
      {
        // Other kimi models — no thinking support
        match: /^kimi(?:\b|[.-])/,
        profile: KIMI_NON_THINKING_PROFILE,
      },
    ],
    fallback: KIMI_NON_THINKING_PROFILE,
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
        match: /(^|[/:.])claude-mythos-preview(?:\b|[.-])/,
        profile: ANTHROPIC_ADAPTIVE_ONLY_PROFILE,
      },
      {
        match: /(^|[/:.])claude-opus-4-7(?:\b|[.-])/,
        profile: ANTHROPIC_OPUS_47_PROFILE,
      },
      {
        match: /(^|[/:.])claude-(?:opus|sonnet)-4-6(?:\b|[.-])/,
        profile: ANTHROPIC_ADAPTIVE_WITH_MANUAL_FALLBACK_PROFILE,
      },
      {
        match: /(^|[/:.])claude-haiku-4-5(?:\b|[.-])/,
        profile: ANTHROPIC_MANUAL_THINKING_PROFILE,
      },
      {
        match:
          /(^|[/:.])claude-(?:opus-(?:4-5|4-1|4)|sonnet-(?:4-5|4)|3-7-sonnet)(?:\b|[.-])/,
        profile: ANTHROPIC_MANUAL_THINKING_PROFILE,
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
  return Boolean(profile.deepseek?.defaultThinkingType);
}

export function getDeepseekReasoningProfileForModel(
  modelName?: string,
): DeepseekReasoningProfile {
  const profile = resolveProviderProfile("deepseek", modelName);
  const deepseekProfile = profile.deepseek;
  const defaultLevel = getResolvedDefaultLevel(
    "deepseek",
    modelName,
    "default",
  );
  return {
    defaultThinkingType: deepseekProfile?.defaultThinkingType ?? null,
    defaultReasoningEffort: deepseekProfile?.defaultReasoningEffort ?? null,
    levelToThinkingType: cloneLevelMap(deepseekProfile?.levelToThinkingType),
    levelToReasoningEffort: cloneLevelMap(
      deepseekProfile?.levelToReasoningEffort,
    ),
    defaultLevel,
    omitTemperatureWhenThinking: Boolean(
      deepseekProfile?.omitTemperatureWhenThinking,
    ),
  };
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
  const anthropicProfile = profile.anthropic;
  const defaultLevel = getResolvedDefaultLevel("anthropic", modelName, "high");
  return {
    defaultBudgetTokens: anthropicProfile?.defaultBudgetTokens || 2000,
    levelToBudgetTokens: cloneLevelMap(anthropicProfile?.levelToBudgetTokens),
    levelToEffort: cloneLevelMap(anthropicProfile?.levelToEffort),
    defaultLevel,
    preferredMode: anthropicProfile?.preferredMode || "none",
    supportsAdaptiveThinking: Boolean(
      anthropicProfile?.supportsAdaptiveThinking,
    ),
    supportsManualThinking: Boolean(anthropicProfile?.supportsManualThinking),
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
