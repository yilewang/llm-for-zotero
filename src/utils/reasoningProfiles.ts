import { modelNameCandidates } from "../shared/modelNameCandidates";
const REASONING_PROFILE_TABLE_VERSION = 7;

export type ReasoningProvider =
  | "openai"
  | "gemini"
  | "deepseek"
  | "kimi"
  | "mimo"
  | "minimax"
  | "glm"
  | "qwen"
  | "grok"
  | "anthropic"
  | "customized"
  | "local";
export type ReasoningLevel =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  /** Future provider-defined values (for example `ultra`). */
  | (string & {});
export type OpenAIReasoningEffort =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | (string & {});
/**
 * Providers whose only reasoning control is `thinking.type`, each with its own
 * vocabulary for the value (GLM says enabled/disabled, MiniMax adaptive).
 */
export type ThinkingSwitchType = "enabled" | "disabled" | "adaptive";
export type ThinkingSwitchProfile = {
  defaultLevel: ReasoningLevel;
  levelToThinkingType: Partial<Record<ReasoningLevel, ThinkingSwitchType>>;
};

export type GeminiThinkingParam = "thinking_level" | "thinking_budget";
export type GeminiThinkingValue =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | number;
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
  supportsDisabledThinking?: boolean;
  /**
   * The model thinks when a request omits `thinking`, and that thinking
   * spends the request's max_tokens. Bounded utility calls must switch it off
   * or leave it room.
   */
  thinkingOnWhenOmitted?: boolean;
};
export type QwenReasoningProfile = {
  defaultEnableThinking: boolean | null;
  levelToEnableThinking: Partial<Record<ReasoningLevel, boolean | null>>;
  defaultLevel: ReasoningLevel;
};
export type DeepseekThinkingType = "enabled" | "disabled";
/** https://api-docs.deepseek.com/guides/thinking_mode/ */
export type DeepseekReasoningEffort = "low" | "high" | "max";
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
export type MimoThinkingType = "enabled";
export type MimoReasoningProfile = {
  levelToThinkingType: Partial<Record<ReasoningLevel, MimoThinkingType | null>>;
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
    levelToEffort?: Partial<Record<ReasoningLevel, AnthropicAdaptiveEffort>>;
    preferredMode: AnthropicThinkingMode;
    supportsAdaptiveThinking: boolean;
    supportsManualThinking: boolean;
    supportsDisabledThinking?: boolean;
    thinkingOnWhenOmitted?: boolean;
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
  mimo?: {
    levelToThinkingType: Partial<
      Record<ReasoningLevel, MimoThinkingType | null>
    >;
  };
  thinkingSwitch?: ThinkingSwitchProfile;
};

type ProfileRule = {
  match: RegExp;
  profile: ProviderProfile;
};

/**
 * A level has one name, and it is the level id.
 *
 * These options used to carry a separate display label — deepseek's `minimal`
 * showed as "disabled", gemini's `low` as its token budget — so the reasoning
 * menu and the model editor named the same level differently. The parameters a
 * level actually sends are shown in the editor next to it, which is where a
 * budget belongs; the menu just names the level.
 */
const option = (level: ReasoningLevel): RuntimeReasoningOption => {
  return { level, label: level, enabled: true };
};

function singleEnabledOptionProfile(
  level: ReasoningLevel,
  extras: Omit<
    Partial<ProviderProfile>,
    "supportsReasoning" | "defaultLevel" | "options"
  > = {},
): ProviderProfile {
  return {
    supportsReasoning: true,
    defaultLevel: level,
    options: [option(level)],
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
  options: [option("default"), option("low"), option("medium"), option("high")],
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
    option("default"),
    option("low"),
    option("medium"),
    option("high"),
    option("xhigh"),
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
  options: [option("high")],
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
  options: [option("medium"), option("high"), option("xhigh")],
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
  options: [option("low"), option("medium"), option("high"), option("xhigh")],
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

// https://developers.openai.com/api/docs/models/gpt-5.6 — reasoning effort takes
// none | low | medium (default) | high | xhigh | max.
const OPENAI_GPT56_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "medium",
  options: [
    option("none"),
    option("low"),
    option("medium"),
    option("high"),
    option("xhigh"),
    option("max"),
  ],
  openai: {
    defaultEffort: "medium",
    levelToEffort: {
      none: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  },
};

// https://docs.x.ai/docs/guides/reasoning — grok-4.6 and grok-4.20-multi-agent
// take low | medium | high (default) | xhigh; grok-4.5 stops at high. Reasoning
// cannot be disabled on any of them, so there is no off level.
const GROK_XHIGH_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: [option("low"), option("medium"), option("high"), option("xhigh")],
  openai: {
    defaultEffort: "high",
    levelToEffort: {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
  },
};

const GROK_HIGH_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: [option("low"), option("medium"), option("high")],
  openai: {
    defaultEffort: "high",
    levelToEffort: {
      low: "low",
      medium: "medium",
      high: "high",
    },
  },
};

const GROK_3_MINI_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [option("default"), option("low"), option("high")],
  openai: {
    defaultEffort: "default",
    levelToEffort: {
      default: null,
      low: "low",
      high: "high",
    },
  },
};

const GROK_REASONING_PROFILE: ProviderProfile =
  singleEnabledOptionProfile("default");

const GEMINI_3_PRO_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: [option("high"), option("low")],
  gemini: {
    param: "thinking_level",
    defaultValue: "high",
    levelToValue: {
      high: "high",
      low: "low",
    },
  },
};

// gemini-3.1-pro and later pro releases add "medium" but still reject
// "minimal" (see ai.google.dev/gemini-api/docs/thinking).
const GEMINI_3X_PRO_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: [option("high"), option("medium"), option("low")],
  gemini: {
    param: "thinking_level",
    defaultValue: "high",
    levelToValue: {
      high: "high",
      medium: "medium",
      low: "low",
    },
  },
};

// Flash releases support the full minimal..high ladder; defaults differ per
// model (3.6-flash: medium, flash-lite: minimal, other flash: high).
const GEMINI_36_FLASH_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "medium",
  options: [option("medium"), option("high"), option("low"), option("minimal")],
  gemini: {
    param: "thinking_level",
    defaultValue: "medium",
    levelToValue: {
      medium: "medium",
      high: "high",
      low: "low",
      minimal: "minimal",
    },
  },
};

const GEMINI_3_FLASH_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: [option("high"), option("medium"), option("low"), option("minimal")],
  gemini: {
    param: "thinking_level",
    defaultValue: "high",
    levelToValue: {
      high: "high",
      medium: "medium",
      low: "low",
      minimal: "minimal",
    },
  },
};

const GEMINI_3_FLASH_LITE_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "minimal",
  options: [option("minimal"), option("low"), option("medium"), option("high")],
  gemini: {
    param: "thinking_level",
    defaultValue: "minimal",
    levelToValue: {
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
    },
  },
};

const GEMINI_25_PRO_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "default",
  options: [option("default"), option("low"), option("high")],
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
    option("default"),
    option("minimal"),
    option("low"),
    option("high"),
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
    option("default"),
    option("minimal"),
    option("low"),
    option("high"),
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
  options: [option("medium"), option("low"), option("high")],
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

// https://api-docs.deepseek.com/guides/thinking_mode/ (checked Sept 2026) —
// reasoning_effort takes
// low | high | max, thinking.type takes enabled | disabled, and the default is
// thinking on at high effort. `low` used to be missing entirely, and `max` was
// exposed under our own name `xhigh`.
const DEEPSEEK_V4_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: [option("none"), option("low"), option("high"), option("max")],
  deepseek: {
    defaultThinkingType: "enabled",
    defaultReasoningEffort: "high",
    levelToThinkingType: {
      none: "disabled",
      low: "enabled",
      high: "enabled",
      max: "enabled",
    },
    levelToReasoningEffort: {
      none: null,
      low: "low",
      high: "high",
      max: "max",
    },
    omitTemperatureWhenThinking: true,
  },
};

const DEEPSEEK_CHAT_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

// Kimi k2/k2.5 drive thinking.type only; the registry already names the newer
// k2.6 levels off/on, so the built-in profile says the same thing.
const KIMI_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "on",
  options: [option("off"), option("on")],
  thinkingSwitch: {
    defaultLevel: "on",
    levelToThinkingType: { off: "disabled", on: "enabled" },
  },
};

const KIMI_NON_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

// MiMo opts in to thinking with thinking.type=enabled and documents no way to
// turn it off, so the one level says what it does; Auto sends nothing.
const MIMO_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "on",
  options: [option("on")],
  mimo: {
    levelToThinkingType: {
      on: "enabled",
    },
  },
};

// Qwen's control is enable_thinking: true | false (alibabacloud.com/help/en/
// model-studio/deep-thinking) — a switch, not an effort ladder, so the levels
// are named for what they do rather than borrowed from a scale Qwen has not
// got. "Auto" covers sending neither.
const QWEN_TOGGLE_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "on",
  options: [option("off"), option("on")],
  qwen: {
    defaultEnableThinking: null,
    levelToEnableThinking: {
      off: false,
      on: true,
    },
  },
};

const QWEN_THINKING_ONLY_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "on",
  options: [option("on")],
  qwen: {
    defaultEnableThinking: true,
    levelToEnableThinking: {
      on: true,
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

// https://platform.claude.com/docs/en/build-with-claude/effort — output_config
// .effort takes low | medium | high (default) | xhigh | max. `max` used to be
// reachable only under our name `xhigh`.
// Per the effort table: `max` is available on Mythos Preview, Opus 4.6/4.7/4.8
// and 5, Sonnet 4.6 and 5, and the Fable/Mythos 5 line; `xhigh` on a narrower
// set that excludes Mythos Preview and the 4.6 generation.
const ANTHROPIC_ADAPTIVE_MAX_OPTIONS: RuntimeReasoningOption[] = [
  option("low"),
  option("medium"),
  option("high"),
  option("max"),
];

const ANTHROPIC_ADAPTIVE_ALL_OPTIONS: RuntimeReasoningOption[] = [
  option("low"),
  option("medium"),
  option("high"),
  option("xhigh"),
  option("max"),
];

const ANTHROPIC_MANUAL_OPTIONS: RuntimeReasoningOption[] = [
  option("low"),
  option("medium"),
  option("high"),
  option("xhigh"),
];

// The level id is the effort value; there is nothing to translate.
const ANTHROPIC_EFFORT_MAP: Partial<
  Record<ReasoningLevel, AnthropicAdaptiveEffort>
> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const ANTHROPIC_BUDGET_MAP: Partial<Record<ReasoningLevel, number>> = {
  low: 1024,
  medium: 2000,
  high: 10000,
  xhigh: 32000,
  max: 32000,
};

const ANTHROPIC_ADAPTIVE_ONLY_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_MAX_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: false,
  },
};

// Mythos Preview thinks whether or not the request asks, and rejects
// `disabled`. The unseen-model fallback keeps the same levels without that
// claim, since older ids no rule names (claude-3-5-sonnet) land there too.
const ANTHROPIC_MYTHOS_PREVIEW_PROFILE: ProviderProfile = {
  ...ANTHROPIC_ADAPTIVE_ONLY_PROFILE,
  anthropic: {
    ...ANTHROPIC_ADAPTIVE_ONLY_PROFILE.anthropic!,
    thinkingOnWhenOmitted: true,
  },
};

// Disabled thinking is supported by these established profiles, but not
// Mythos Preview: https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking
const ANTHROPIC_OPUS_47_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_ALL_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: false,
    supportsDisabledThinking: true,
  },
};

const ANTHROPIC_ADAPTIVE_ALL_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_ALL_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: false,
  },
};

// The 5.x line thinks when `thinking` is omitted. None of these get an Off
// level: Opus 5.5, Sonnet 5.5 and Fable/Mythos reject `disabled`; Opus 5 and
// Sonnet 5 accept it, but Opus 5 leaks thinking tags with it off, so both
// keep the lowest effort instead (docs/plans/2026-10-14-haiku-agent-fixes.md).
// https://platform.claude.com/docs/en/build-with-claude/thinking
const ANTHROPIC_ADAPTIVE_DEFAULT_ON_PROFILE: ProviderProfile = {
  ...ANTHROPIC_ADAPTIVE_ALL_PROFILE,
  anthropic: {
    ...ANTHROPIC_ADAPTIVE_ALL_PROFILE.anthropic!,
    thinkingOnWhenOmitted: true,
  },
};

// Haiku 5.5 thinks when `thinking` is omitted and accepts `disabled` at high
// effort or below; Off sends no effort, so the model's medium default holds.
const ANTHROPIC_HAIKU_55_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_MAX_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: false,
    supportsDisabledThinking: true,
    thinkingOnWhenOmitted: true,
  },
};

const ANTHROPIC_ADAPTIVE_WITH_MANUAL_FALLBACK_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "high",
  options: ANTHROPIC_ADAPTIVE_MAX_OPTIONS,
  anthropic: {
    defaultBudgetTokens: 2000,
    levelToBudgetTokens: ANTHROPIC_BUDGET_MAP,
    levelToEffort: ANTHROPIC_EFFORT_MAP,
    preferredMode: "adaptive",
    supportsAdaptiveThinking: true,
    supportsManualThinking: true,
    supportsDisabledThinking: true,
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
    supportsDisabledThinking: true,
  },
};

// A provider whose only control is a switch gets `off`/`on`, whatever its API
// spells the "on" value — MiniMax says `adaptive`, GLM and Kimi say `enabled`,
// Qwen sends a boolean. The editor shows the real parameter beside the level,
// so the request stays visible without a different word per provider.
//
// https://platform.minimax.io/docs — thinking.type takes adaptive | disabled.
// M3 ships with thinking off; the M2.x line accepts `disabled` but keeps
// thinking on regardless, so it gets no off switch to promise something the
// API will not honour.
const MINIMAX_TOGGLE_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "off",
  options: [option("off"), option("on")],
  thinkingSwitch: {
    defaultLevel: "off",
    levelToThinkingType: { off: "disabled", on: "adaptive" },
  },
};

const MINIMAX_ALWAYS_THINKING_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "on",
  options: [option("on")],
  thinkingSwitch: {
    defaultLevel: "on",
    levelToThinkingType: { on: "adaptive" },
  },
};

// https://docs.z.ai/guides/llm/glm-4.6 — thinking.type takes enabled |
// disabled, default enabled.
const GLM_TOGGLE_PROFILE: ProviderProfile = {
  supportsReasoning: true,
  defaultLevel: "on",
  options: [option("off"), option("on")],
  thinkingSwitch: {
    defaultLevel: "on",
    levelToThinkingType: { off: "disabled", on: "enabled" },
  },
};

const UNSUPPORTED_PROFILE: ProviderProfile = {
  supportsReasoning: false,
  defaultLevel: null,
  options: [],
};

const PROFILE_RULES: Record<
  ReasoningProvider,
  {
    rules: ProfileRule[];
    fallback: ProviderProfile;
    /** See hasKnownReasoningProfile: the fallback answers for unseen ids. */
    fallbackIsAuthoritative?: boolean;
  }
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
        match: /^gpt-5\.6(?:\b|[.-])/,
        profile: OPENAI_GPT56_PROFILE,
      },
      {
        match: /^gpt-5\.(?:4|5)(?:\b|[.-])/,
        profile: OPENAI_GPT5_XHIGH_PROFILE,
      },
      {
        match: /^gpt-5\.2(?:\b|[.-])/,
        profile: OPENAI_GPT5_XHIGH_PROFILE,
      },
      {
        // Historical families only; later releases start on Auto until described.
        match: /^(gpt-5(?:\.[13])?(?:-|$)|o[134](?:-|$))/,
        profile: OPENAI_GPT5_PROFILE,
      },
      // The GPT-3 and GPT-4 families predate reasoning and reject
      // `reasoning_effort` outright. They have to be named here rather than
      // left to the fallback, which is deliberately optimistic so an
      // unreleased OpenAI reasoning model still gets a usable level set
      // before this table learns its name. `(?:chat)?` catches
      // `chatgpt-4o-latest`; no trailing boundary, so `gpt-35-turbo` (Azure's
      // spelling) and every dated `gpt-4o-*` snapshot fall out for free.
      {
        match: /^(?:chat)?gpt-[34]/,
        profile: UNSUPPORTED_PROFILE,
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
        match: /(^|[/:])gemini-3(?:\.\d+)?-flash-lite(?:\b|[.-])/,
        profile: GEMINI_3_FLASH_LITE_PROFILE,
      },
      {
        match: /(^|[/:])gemini-3\.6-flash(?:\b|[.-])/,
        profile: GEMINI_36_FLASH_PROFILE,
      },
      {
        match: /(^|[/:])gemini-3(?:\.\d+)?-flash(?:\b|[.-])/,
        profile: GEMINI_3_FLASH_PROFILE,
      },
      {
        match: /(^|[/:])gemini-3\.\d+-pro(?:\b|[.-])/,
        profile: GEMINI_3X_PRO_PROFILE,
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
    // The rules carve out the two models that do NOT follow DeepSeek's
    // thinking API; everything else — deepseek-flash, deepseek-v4-pro, the
    // retired deepseek-v4-flash, and any id DeepSeek ships next — falls back
    // to it. Naming each model explicitly is what made the deepseek-v4-flash
    // to deepseek-flash rename silently remove the reasoning menu: an
    // unrecognised name landed on the non-reasoning chat profile. Offering
    // levels a model rejects is recoverable — Test reports it and the levels
    // are editable — while offering none is not.
    rules: [
      {
        match: /(^|[/:])deepseek-(?:reasoner|r1)(?:\b|[.-])/,
        profile: DEEPSEEK_REASONER_PROFILE,
      },
      {
        match: /(^|[/:])deepseek-chat(?:\b|[.-])/,
        profile: DEEPSEEK_CHAT_PROFILE,
      },
    ],
    fallback: DEEPSEEK_V4_PROFILE,
    fallbackIsAuthoritative: true,
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
  mimo: {
    rules: [
      {
        match: /(^|[/:])mimo-v2(?:\.5)?(?:-(?:pro|omni|flash))?(?:\b|[.-])/,
        profile: MIMO_THINKING_PROFILE,
      },
    ],
    // mimo-v2.5-pro has thinking on by default.
    fallback: MIMO_THINKING_PROFILE,
    fallbackIsAuthoritative: true,
  },
  minimax: {
    rules: [
      {
        match: /(^|[/:])minimax-m3(?:\b|[.-])/,
        profile: MINIMAX_TOGGLE_PROFILE,
      },
      {
        match: /(^|[/:])minimax-m2(?:\.\d+)?(?:\b|[.-])/,
        profile: MINIMAX_ALWAYS_THINKING_PROFILE,
      },
    ],
    // MiniMax-M3 takes thinking.type enabled|adaptive|disabled.
    fallback: MINIMAX_TOGGLE_PROFILE,
    fallbackIsAuthoritative: true,
  },
  glm: {
    rules: [
      {
        match: /(^|[/:])glm-\d/,
        profile: GLM_TOGGLE_PROFILE,
      },
    ],
    // glm-4.6 takes thinking.type enabled|disabled, default enabled.
    fallback: GLM_TOGGLE_PROFILE,
    fallbackIsAuthoritative: true,
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
        match: /^grok-(?:4\.6|4\.20-multi-agent)(?:\b|[.-])/,
        profile: GROK_XHIGH_PROFILE,
      },
      {
        match: /^grok-4\.5(?:\b|[.-])/,
        profile: GROK_HIGH_PROFILE,
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
        profile: ANTHROPIC_MYTHOS_PREVIEW_PROFILE,
      },
      {
        match: /(^|[/:.])claude-haiku-5-5(?:\b|[.-])/,
        profile: ANTHROPIC_HAIKU_55_PROFILE,
      },
      {
        // Opus 5/5.5, Sonnet 5/5.5 and Fable/Mythos 5.x reject
        // thinking.type=enabled and steer with output_config.effort instead.
        // Each 5.5 id is named, so it never rides on its 5 sibling's rule.
        match:
          /(^|[/:.])claude-(?:opus-5(?:-5)?|sonnet-5(?:-5)?|fable-5(?:-1)?|mythos-5(?:-1)?)(?:\b|[.-])/,
        profile: ANTHROPIC_ADAPTIVE_DEFAULT_ON_PROFILE,
      },
      {
        // Opus 4.8 steers the same way but keeps thinking off when omitted.
        match: /(^|[/:.])claude-opus-4-8(?:\b|[.-])/,
        profile: ANTHROPIC_ADAPTIVE_ALL_PROFILE,
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
    // Models without a rule above use adaptive thinking with
    // output_config.effort; `thinking.type: enabled` 400s on 4.7 and later.
    fallback: ANTHROPIC_ADAPTIVE_ONLY_PROFILE,
    fallbackIsAuthoritative: true,
  },
  // Locally-served models carry no hand-maintained profile: their options come
  // from what the server reports plus whatever the user configures, resolved
  // entirely through declarative ModelControlPatches. This entry exists so
  // ReasoningConfig.provider stays type-safe and every lookup here is inert.
  customized: { rules: [], fallback: UNSUPPORTED_PROFILE },
  local: {
    rules: [],
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

/** A family hint alone is not evidence for a future model's level set. */
/**
 * Whether we can say anything about this model's reasoning.
 *
 * By default only an explicit rule counts, so an unrecognised id reports
 * "unknown" rather than being credited with support it may not have — see
 * "keeps an unfamiliar model usable without inventing support" in
 * test/reasoningDefaults.test.ts.
 *
 * A family may opt out with `fallbackIsAuthoritative`, which says its
 * fallback IS the answer for any id: the family's whole line shares one
 * thinking API, so a model shipped after our last release is far more likely
 * to follow it than not. DeepSeek is the case in point — renaming
 * `deepseek-v4-flash` to `deepseek-flash` silently removed its reasoning menu
 * entirely, and showing levels a model rejects is recoverable (Test reports
 * it, the levels are editable) where showing none is not.
 */
export function hasKnownReasoningProfile(
  provider: ReasoningProvider,
  modelName: string,
): boolean {
  const table = PROFILE_RULES[provider];
  if (table.fallbackIsAuthoritative && table.fallback.supportsReasoning) {
    return true;
  }
  return table.rules.some((rule) =>
    modelNameCandidates(modelName).some((candidate) =>
      rule.match.test(candidate),
    ),
  );
}

function resolveProviderProfile(
  provider: ReasoningProvider,
  modelName?: string,
): ProviderProfile {
  // A gateway's `vendor/model` id keeps the family underneath, so each rule
  // is tried against the id and against the id with its prefix removed.
  const candidates = modelNameCandidates(modelName || "");
  const table = PROFILE_RULES[provider];
  for (const rule of table.rules) {
    if (candidates.some((candidate) => rule.match.test(candidate))) {
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

/** The thinking.type switch for providers whose only control is that flag. */
export function getThinkingSwitchProfileForModel(
  provider: ReasoningProvider,
  modelName?: string,
): ThinkingSwitchProfile | null {
  return resolveProviderProfile(provider, modelName).thinkingSwitch || null;
}

export function getMimoReasoningProfileForModel(
  modelName?: string,
): MimoReasoningProfile {
  const profile = resolveProviderProfile("mimo", modelName);
  const mimoProfile = profile.mimo;
  const defaultLevel = getResolvedDefaultLevel("mimo", modelName, "default");
  return {
    levelToThinkingType: cloneLevelMap(mimoProfile?.levelToThinkingType),
    defaultLevel,
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
    supportsDisabledThinking: Boolean(
      anthropicProfile?.supportsDisabledThinking,
    ),
    thinkingOnWhenOmitted: Boolean(anthropicProfile?.thinkingOnWhenOmitted),
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

/**
 * Thought summaries are the plugin's ask, not the profile's: every branch that
 * builds a `thinkingConfig` from a known profile requests them, so a config
 * that arrives declared — from the registry, or from a reasoning level the
 * user typed — must not cost the reasoning stream merely by saying nothing
 * about it. An explicit `includeThoughts: false` still wins.
 */
export function withGeminiThoughtSummaries(
  config: Record<string, unknown>,
): Record<string, unknown> {
  // Both call sites accept `thinking_config` as well as `thinkingConfig`, and
  // this repo's own legacy encoder writes snake_case, so both spellings of the
  // field have to count as "already stated" — adding the camelCase one beside
  // an existing `include_thoughts` would send Gemini the same field twice.
  return "includeThoughts" in config || "include_thoughts" in config
    ? config
    : { includeThoughts: true, ...config };
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
      const value = (
        mappedValue !== undefined
          ? mappedValue
          : optionState.level === "low" ||
              optionState.level === "medium" ||
              optionState.level === "high"
            ? optionState.level
            : (geminiProfile?.defaultValue ?? "medium")
      ) as GeminiThinkingValue;
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
