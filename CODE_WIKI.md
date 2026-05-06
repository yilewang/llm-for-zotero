# llm-for-zotero Code Wiki

## 目录
- [项目概述](#项目概述)
- [技术栈](#技术栈)
- [项目架构](#项目架构)
- [核心模块](#核心模块)
- [关键类与函数](#关键类与函数)
- [依赖关系](#依赖关系)
- [项目运行方式](#项目运行方式)
- [开发指南](#开发指南)

---

## 项目概述

### 项目信息
- **项目名称**: llm-for-zotero
- **版本**: 3.8.4
- **描述**: AI research agent rooted in your Zotero library（嵌入 Zotero 库的 AI 研究助手）
- **许可证**: AGPL-3.0-or-later
- **作者**: Yile Wang
- **仓库**: https://github.com/yilewang/llm-for-zotero

### 功能特性
- 在 Zotero 中直接与当前论文、选中文本、图片、截图和上传的文档对话
- 提供带引用的接地回答，可跳转回源文本
- 支持比较多篇打开的论文或添加外部文件作为额外上下文
- 将回答、完整对话和研究笔记保存到 Zotero 笔记或本地 Markdown 文件夹（如 Obsidian、Logseq）
- Agent 模式支持全库读取、搜索、打标签、元数据、导入、笔记编辑和组织工作流
- 支持多种后端：API 密钥、本地模型、WebChat、Codex App Server、Claude Code

---

## 技术栈

### 主要技术
- **语言**: TypeScript
- **运行环境**: Zotero 插件环境
- **构建工具**: zotero-plugin-scaffold
- **测试框架**: Mocha + Chai
- **代码规范**: Prettier + ESLint

### 依赖库
- **生产依赖**
  - `fflate`: 用于压缩和解压缩
  - `katex`: 用于数学公式渲染
  - `zotero-plugin-toolkit`: Zotero 插件开发工具包

- **开发依赖**
  - TypeScript 相关: `typescript`, `ts-node`, `tsx`
  - 测试相关: `mocha`, `chai`, `@types/chai`, `@types/mocha`
  - 代码规范: `prettier`, `eslint`, `@zotero-plugin/eslint-config`
  - Zotero 相关: `zotero-plugin-scaffold`, `zotero-types`

---

## 项目架构

### 目录结构
```
/workspace
├── addon/                    # 插件输出目录
│   ├── content/              # 静态内容（图标、XHTML页面、CSS等）
│   └── locale/               # 本地化文件（en-US, zh-CN等）
├── assets/                   # 演示资源
├── doc/                      # 文档
├── scripts/                  # 脚本工具
├── src/                      # 源代码目录
│   ├── agent/                # Agent 子系统（核心功能）
│   ├── claudeCode/           # Claude Code 集成
│   ├── codexAppServer/       # Codex App Server 集成
│   ├── modules/              # 功能模块
│   ├── providers/            # 模型提供商支持
│   ├── shared/               # 共享代码
│   ├── utils/                # 工具函数
│   ├── webchat/              # WebChat 集成
│   ├── addon.ts              # 插件主类
│   ├── hooks.ts              # 生命周期钩子
│   └── index.ts              # 入口点
├── test/                     # 测试文件
├── typings/                  # 类型定义
└── ...                       # 配置文件
```

### 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        Zotero 环境                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │           llm-for-zotero 插件                          │ │
│  ├───────────────────────────────────────────────────────┤ │
│  │                                                       │ │
│  │  ┌─────────────────────────────────────────────────┐ │ │
│  │  │           生命周期管理 (hooks.ts)                │ │ │
│  │  │  - onStartup                                    │ │ │
│  │  │  - onShutdown                                   │ │ │
│  │  │  - onMainWindowLoad                             │ │ │
│  │  └─────────────────────────────────────────────────┘ │ │
│  │                                                       │ │
│  │  ┌──────────────────┐  ┌───────────────────────────┐│ │
│  │  │  Context Panel   │  │      Agent Subsystem     ││ │
│  │  │  (聊天界面)      │  │      (智能助手)          ││ │
│  │  └──────────────────┘  └───────────────────────────┘│ │
│  │           │                        │                  │ │
│  │           └───────────┬────────────┘                  │ │
│  │                       │                               │ │
│  │  ┌────────────────────▼─────────────────────────────┐ │ │
│  │  │              模型提供商层                         │ │ │
│  │  │  - OpenAI API 兼容                              │ │ │
│  │  │  - Anthropic Messages                          │ │ │
│  │  │  - Gemini Native                               │ │ │
│  │  │  - Codex (Responses API / App Server)          │ │ │
│  │  │  - Claude Code                                 │ │ │
│  │  │  - WebChat (ChatGPT / Deepseek)                │ │ │
│  │  └─────────────────────────────────────────────────┘ │ │
│  │                                                       │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 核心数据流
1. **用户输入** → Context Panel UI
2. **内容解析** → 上下文构建（PDF、笔记、文本等）
3. **请求处理** → 模型适配器选择 + 提示词构建
4. **API 调用** → 提供商层（OpenAI/Anthropic/Codex等）
5. **响应处理** → 流式渲染 + 引用生成 + 工具调用
6. **结果输出** → UI 显示 + 可选保存到笔记

---

## 核心模块

### 1. 插件主模块 (src/addon.ts & src/index.ts)

#### Addon 类
位于 [src/addon.ts](file:///workspace/src/addon.ts)，是插件的主类，负责：
- 插件配置管理
- 全局状态存储
- 插件 API 暴露
- 生命周期协调

关键属性：
```typescript
class Addon {
  data: {
    alive: boolean;
    config: typeof config;  // package.json 配置
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: { current: any };
    prefs?: { window: Window; ... };
    dialog?: DialogHelper;
    standaloneWindow?: Window;
  };
  hooks: typeof hooks;  // 生命周期钩子
  api: { agent?: ReturnType<typeof getAgentApi> };
}
```

### 2. 生命周期管理 (src/hooks.ts)

位于 [src/hooks.ts](file:///workspace/src/hooks.ts)，管理插件的整个生命周期：

#### 关键函数
- `onStartup()`: 插件启动时调用
  - 初始化本地化
  - 初始化各存储系统（聊天、Claude Code、Codex）
  - 初始化 Agent 子系统
  - 注册 UI 组件和事件监听

- `onMainWindowLoad(win)`: 主窗口加载时
  - 注册样式
  - 注册阅读侧边栏
  - 注册选择跟踪
  - 注册键盘快捷键（Ctrl/Cmd+Shift+L）

- `onShutdown()`: 插件关闭时
  - 清理资源
  - 停止定时任务
  - 关闭子系统

- `onNotify()`: Zotero 事件监听
  - 处理项目变更
  - 失效缓存

### 3. Agent 子系统 (src/agent/)

Agent 子系统是项目的核心，提供智能助手功能。

#### 目录结构
```
src/agent/
├── actions/           # 预设动作（自动标签、元数据等）
├── context/           # 上下文管理
├── mcp/               # Model Context Protocol 支持
├── model/             # 模型适配器（OpenAI/Anthropic/Gemini等）
├── services/          # 服务层（Zotero 交互、PDF、检索）
├── skills/            # 技能系统（自定义工作流）
├── store/             # 状态存储
├── tools/             # 工具集（读写库、笔记等）
├── extensionApi.ts    # 扩展 API
├── index.ts           # 入口
├── runtime.ts         # 运行时
└── types.ts           # 类型定义
```

#### 核心组件

**AgentRuntime** ([src/agent/runtime.ts](file:///workspace/src/agent/runtime.ts)):
- 处理对话回合
- 管理工具调用
- 执行流控制

**ZoteroGateway** ([src/agent/services/zoteroGateway.ts](file:///workspace/src/agent/services/zoteroGateway.ts)):
- 与 Zotero API 交互的统一接口
- 提供项目、集合、标签、笔记等的 CRUD 操作

**工具注册表** ([src/agent/tools/](file:///workspace/src/agent/tools/)):
- **读工具**: 读取库、搜索论文、阅读 PDF、查看附件
- **写工具**: 应用标签、编辑笔记、更新元数据、管理集合
- **工具通过 `mutability` 属性分类（`read` 或 `write`）**

**技能系统** ([src/agent/skills/](file:///workspace/src/agent/skills/)):
- 预定义工作流模板
- 支持用户自定义技能
- 内置技能：
  - `simple-paper-qa`: 高效回答论文问题
  - `evidence-based-qa`: 查找具体方法、结果或证据
  - `analyze-figures`: 使用 MinerU 解析的图像解释图表
  - `compare-papers`: 使用批量阅读和聚焦检索比较多篇论文
  - `library-analysis`: 总结或分析整个库
  - `literature-review`: 进行结构化文献综述
  - `write-note`: 编写 Zotero 笔记或本地 Markdown 笔记
  - `import-cited-reference`: 导入当前 PDF 中引用的论文

**预设动作** ([src/agent/actions/](file:///workspace/src/agent/actions/)):
- `autoTag`: 自动为论文打标签
- `completeMetadata`: 完善元数据
- `discoverRelated`: 发现相关论文
- `literatureReview`: 文献综述
- `organizeUnfiled`: 整理未归档项目
- `paperScope`: 论文范围分析
- `syncMetadata`: 同步元数据

### 4. Context Panel 模块 (src/modules/contextPanel/)

提供聊天界面和用户交互功能。

关键文件：
- [index.ts](file:///workspace/src/modules/contextPanel/index.ts): 注册入口
- [chat.ts](file:///workspace/src/modules/contextPanel/chat.ts): 对话管理
- [contextResolution.ts](file:///workspace/src/modules/contextPanel/contextResolution.ts): 上下文解析
- [pdfContext.ts](file:///workspace/src/modules/contextPanel/pdfContext.ts): PDF 上下文处理
- [multiContextPlanner.ts](file:///workspace/src/modules/contextPanel/multiContextPlanner.ts): 多论文上下文规划
- [notes.ts](file:///workspace/src/modules/contextPanel/notes.ts): 笔记导出功能
- [shortcuts.ts](file:///workspace/src/modules/contextPanel/shortcuts.ts): 快捷方式管理

### 5. 模型提供商层 (src/providers/ & src/utils/llmClient.ts)

支持多种模型提供商：
- OpenAI API 兼容
- Anthropic Messages API
- Gemini Native API
- Codex (Responses API / App Server)
- Claude Code (通过桥接)
- WebChat (ChatGPT / Deepseek 通过浏览器扩展)

关键文件：
- [llmClient.ts](file:///workspace/src/utils/llmClient.ts): 统一的 LLM 客户端
- [providerTransport.ts](file:///workspace/src/utils/providerTransport.ts): 提供商通信
- [modelProviders.ts](file:///workspace/src/utils/modelProviders.ts): 模型提供商管理
- [reasoningProfiles.ts](file:///workspace/src/utils/reasoningProfiles.ts): 推理配置

模型适配器 ([src/agent/model/](file:///workspace/src/agent/model/)):
- `openaiResponses.ts`: OpenAI Responses API
- `openaiCompatible.ts`: OpenAI Chat Completions 兼容
- `anthropicMessages.ts`: Anthropic Messages API
- `geminiNative.ts`: Gemini Native API
- `codexResponses.ts`: Codex Responses API
- `factory.ts`: 适配器工厂

### 6. MinerU 集成 (src/modules/)

MinerU 是高级 PDF 解析引擎，提供高保真的 Markdown 输出。

文件：
- [mineruBatchProcessor.ts](file:///workspace/src/modules/mineruBatchProcessor.ts): 批量处理
- [mineruAutoWatch.ts](file:///workspace/src/modules/mineruAutoWatch.ts): 自动监听
- [mineruManagerScript.ts](file:///workspace/src/modules/mineruManagerScript.ts): 管理脚本
- [mineruProcessingStatus.ts](file:///workspace/src/modules/mineruProcessingStatus.ts): 处理状态
- [utils/mineruClient.ts](file:///workspace/src/utils/mineruClient.ts): MinerU 客户端
- [utils/mineruConfig.ts](file:///workspace/src/utils/mineruConfig.ts): MinerU 配置

---

## 关键类与函数

### Addon 类 (src/addon.ts)

```typescript
class Addon {
  constructor();
  // 数据属性包含插件状态、配置、工具包等
}
```

### AgentRuntime 类 (src/agent/runtime.ts)

Agent 运行时，处理对话回合和工具执行：

```typescript
class AgentRuntime {
  constructor(options: { registry: ToolRegistry; adapterFactory: Function });
  
  async runTurn(options: {
    request: AgentRuntimeRequest;
    onEvent?: (event: AgentEvent) => void;
  }): Promise<AgentRuntimeResponse>;
  
  listTools(): AgentToolDefinition[];
  
  getToolDefinition(name: string): AgentToolDefinition | undefined;
  
  getCapabilities(request: AgentRuntimeRequest): AgentCapabilities;
  
  resolveConfirmation(requestId: string, approved: boolean | AgentConfirmationResolution, data?: unknown): void;
}
```

### ZoteroGateway 类 (src/agent/services/zoteroGateway.ts)

Zotero API 网关：

```typescript
class ZoteroGateway {
  // 项目操作
  async getItems(collectionKey?: string): Promise<Zotero.Item[]>;
  async getItem(itemKey: string): Promise<Zotero.Item | null>;
  async searchItems(query: string): Promise<Zotero.Item[]>;
  
  // 标签操作
  async getTags(): Promise<Zotero.Tag[]>;
  async addTags(itemKeys: string[], tags: string[]): Promise<void>;
  async removeTags(itemKeys: string[], tags: string[]): Promise<void>;
  
  // 集合操作
  async getCollections(): Promise<Zotero.Collection[]>;
  async createCollection(name: string, parentKey?: string): Promise<string>;
  
  // 笔记操作
  async createNote(parentItem: Zotero.Item, content: string): Promise<string>;
  async updateNote(noteKey: string, content: string): Promise<void>;
}
```

### PDF 相关服务 (src/agent/services/)

**PdfService**:
```typescript
class PdfService {
  async extractText(item: Zotero.Item): Promise<string>;
  async getPageCount(item: Zotero.Item): Promise<number>;
}
```

**RetrievalService**:
```typescript
class RetrievalService {
  constructor(pdfService: PdfService);
  async searchInPaper(paperItem: Zotero.Item, query: string, topK?: number): Promise<SearchResult[]>;
  async getRelevantContext(paperItem: Zotero.Item, query: string, tokenBudget?: number): Promise<string>;
}
```

### LLM Client 核心函数 (src/utils/llmClient.ts)

```typescript
// 准备聊天请求
function prepareChatRequest(params: ChatParams): PreparedChatRequest;

// 估计可用上下文预算
function estimateAvailableContextBudget(params: {
  prompt: string;
  history?: ChatMessage[];
  image?: string;
  images?: string[];
  model: string;
  reasoning?: ReasoningConfig;
  maxTokens?: number;
  inputTokenCap?: number;
  systemPrompt?: string;
}): ContextBudgetPlan;

// 获取解析后的嵌入配置
function getResolvedEmbeddingConfig(): ResolvedEmbeddingConfig;

// 解析 Codex 访问令牌
async function resolveCodexAccessToken(params?: { signal?: AbortSignal }): Promise<{ token: string; refreshToken: string; authPath: string }>;

// 启动 Copilot 设备流
async function startCopilotDeviceFlow(signal?: AbortSignal): Promise<{ device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }>;

// 轮询 Copilot 设备认证
async function pollCopilotDeviceAuth(params: { deviceCode: string; interval: number; expiresIn: number; signal?: AbortSignal }): Promise<string>;
```

### Agent API 函数 (src/agent/index.ts)

```typescript
// 初始化 Agent 子系统
async function initAgentSubsystem(): Promise<AgentRuntime>;

// 关闭 Agent 子系统
function shutdownAgentSubsystem(): void;

// 获取 Agent 运行时
function getAgentRuntime(): AgentRuntime;

// 获取 Agent API（供外部使用）
function getAgentApi(): {
  runTurn: (request: AgentRuntimeRequest, onEvent?: (event: AgentEvent) => void) => Promise<any>;
  listTools: () => AgentToolDefinition[];
  getToolDefinition: (name: string) => AgentToolDefinition | undefined;
  registerTool: (tool: AgentToolDefinition) => void;
  unregisterTool: (name: string) => boolean;
  listActions: (mode?: "paper" | "library") => ActionDefinition[];
  runAction: (name: string, input: unknown, opts?: {...}) => Promise<any>;
  // ... 更多方法
};
```

### Context Panel 关键函数

```typescript
// 注册阅读侧边栏
function registerReaderContextPanel(): void;

// 打开独立聊天窗口
function openStandaloneChat(options?: { initialItem?: Zotero.Item }): void;

// 解析当前上下文
function resolveContext(): Promise<ContextResolutionResult>;

// 发送消息
async function sendMessage(message: string, options?: SendMessageOptions): Promise<void>;
```

---

## 依赖关系

### 核心模块依赖图
```
src/index.ts
  └─→ src/addon.ts
       └─→ src/hooks.ts
            ├─→ src/modules/contextPanel/
            ├─→ src/agent/
            │    ├─→ src/agent/services/
            │    ├─→ src/agent/tools/
            │    ├─→ src/agent/model/
            │    └─→ src/agent/skills/
            ├─→ src/utils/
            ├─→ src/providers/
            ├─→ src/claudeCode/
            ├─→ src/codexAppServer/
            └─→ src/webchat/
```

### 主要依赖关系细节

**Agent 子系统依赖**:
- 工具注册表 → 工具定义
- 服务层 → ZoteroGateway、PdfService、RetrievalService
- 模型适配器 → 提供商 API
- 存储 → 会话记忆、撤销历史、跟踪

**Context Panel 依赖**:
- 状态管理
- 上下文解析 → PDF、笔记、选择
- 多论文规划
- 快捷方式系统
- 笔记导出

**LLM Client 依赖**:
- 提供商配置
- 模型预设
- 推理配置
- 令牌预算管理

---

## 项目运行方式

### 开发环境

#### 安装依赖
```bash
npm install
```

#### 开发模式
```bash
npm start
# 启动 zotero-plugin serve，监听文件变化
```

#### 构建
```bash
npm run build
# 构建插件并运行类型检查
```

#### 测试
```bash
npm test
# 运行类型检查和集成测试

npm run test:unit
# 运行单元测试
```

#### 代码检查与格式化
```bash
npm run lint:check
# 检查格式和 lint 问题

npm run lint:fix
# 自动修复格式和 lint 问题

npm run check:cycles
# 检查导入循环
```

#### 发布
```bash
npm run release
# 使用 zotero-plugin release 创建发布
```

### 插件安装

1. 从 [GitHub Releases](https://github.com/yilewang/llm-for-zotero/releases) 下载最新的 `.xpi` 文件
2. 在 Zotero 中：`Tools` → `Add-ons` → 齿轮图标 → `Install Add-on From File`
3. 选择下载的 `.xpi` 文件
4. 重启 Zotero
5. 打开 `Preferences` → `llm-for-zotero`，选择提供商，输入 API 信息

### 配置选项

**提供商配置**：
- API 基础 URL
- API 密钥
- 模型名称
- 认证模式（API 密钥、Codex Auth、WebChat 等）

**MinerU 配置**：
- 启用/禁用 MinerU
- API 密钥（可选）
- 本地服务器模式（可选）
- 后端选择（pipeline、vlm、hybrid）

**笔记目录配置**：
- 昵称（如 "Obsidian"、"Logseq"）
- 笔记目录路径
- 默认子文件夹
- 附件文件夹

### 使用流程

1. **打开 PDF**：在 Zotero 中打开一篇论文的 PDF
2. **激活侧边栏**：点击右侧工具栏中的 LLM Assistant 图标
3. **配置（首次使用）**：在设置中配置模型提供商
4. **开始对话**：
   - 直接提问（如 "这篇论文的主要发现是什么？"）
   - 选择文本并使用弹出菜单
   - 截图或上传文件
   - 使用 `/` 引用其他论文
5. **保存结果**：点击保存按钮将回答保存为笔记

---

## 开发指南

### 项目配置文件

**package.json**:
```json
{
  "name": "llm-for-zotero",
  "version": "3.8.4",
  "type": "module",
  "config": {
    "addonName": "llm-for-zotero",
    "addonID": "zotero-llm@github.com.yilewang",
    "addonRef": "llmforzotero",
    "addonInstance": "LLMForZotero",
    "prefsPrefix": "extensions.zotero.llmforzotero"
  }
}
```

**tsconfig.json**: 继承自 `zotero-types/entries/sandbox/`

**zotero-plugin.config.ts**: Zotero 插件脚手架配置

### 开发规范

- **语言**: TypeScript
- **格式化**: Prettier（80 字符行宽，2 空格缩进）
- **Lint**: ESLint（使用 @zotero-plugin/eslint-config）
- **类型检查**: `tsc --noEmit`

### 扩展开发

#### 注册自定义工具

使用 Agent API 注册自定义工具：

```typescript
import { getAgentApi } from "llm-for-zotero/src/agent";

const agentApi = getAgentApi();
agentApi.registerTool({
  spec: {
    name: "my_custom_tool",
    description: "Does something custom",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    mutability: "read",
    requiresConfirmation: false,
  },
  validate: (args) => {
    if (!args || typeof args !== "object") return { ok: false, error: "Expected object" };
    return { ok: true, value: args as { query?: string } };
  },
  execute: async (input) => ({ result: `Got: ${input.query}` }),
});
```

#### 添加自定义技能

技能存储在用户的 Zotero 数据目录下 `llm-for-zotero/skills/`，是 Markdown 文件。

#### 支持新的模型提供商

在 `src/agent/model/` 中添加新的适配器，实现 `AgentModelAdapter` 接口，并在 `factory.ts` 中注册。

### 测试

项目使用 Mocha 进行测试，测试文件位于 `test/` 目录，命名为 `*.test.ts`。

测试运行：
```bash
npm run test:unit
```

### 调试

- 使用 `ztoolkit.log()` 记录日志
- 在 Zotero 中开启调试模式
- 检查 Zotero 错误控制台

---

## 常见工作流

### 1. 启动流程
```
Zotero 启动
  ↓
onStartup()
  ├─→ 初始化本地化
  ├─→ 初始化各存储
  ├─→ initAgentSubsystem()
  │    ├─→ 创建工具注册表
  │    ├─→ 初始化 ZoteroGateway
  │    ├─→ 创建 AgentRuntime
  │    └─→ 注册 MCP 服务器
  ├─→ 加载用户技能
  ├─→ 注册 WebChat 中继
  ├─→ 启动 MinerU 自动监听
  └─→ onMainWindowLoad()
       ├─→ 注册样式
       ├─→ 注册上下文面板
       └─→ 注册快捷键
```

### 2. 聊天流程
```
用户输入消息
  ↓
Context Panel 处理
  ├─→ 构建上下文（PDF/笔记/文件）
  ├─→ 多论文规划（如果有多个论文）
  └─→ 发送到 AgentRuntime
       ↓
AgentRuntime 处理
  ├─→ 选择模型适配器
  ├─→ 构建提示词
  ├─→ 可选技能应用
  ├─→ 工具调用循环
  │    ├─→ 执行读/写工具
  │    ├─→ 处理确认
  │    └─→ 记录到撤销历史
  └─→ 流式响应
       ↓
UI 渲染
  ├─→ 显示回答
  ├─→ 生成可点击引用
  └─→ 保存选项
```

### 3. Agent 工具调用流程
```
模型决定调用工具
  ↓
AgentRuntime 验证工具输入
  ↓
检查工具 mutability
  ├─→ read: 直接执行
  └─→ write: 检查确认设置
       ├─→ 自动确认模式: 直接执行
       └─→ 需要确认: 显示确认对话框
            ↓
         用户确认或拒绝
            ↓
执行工具
  ↓
记录结果（可选撤销）
  ↓
返回结果给模型
```

---

## 进一步资源

- **官方文档**: https://yilewang.github.io/llm-for-zotero/
- **GitHub 仓库**: https://github.com/yilewang/llm-for-zotero
- **问题追踪**: https://github.com/yilewang/llm-for-zotero/issues

---

*此 Code Wiki 最后更新: 2026-05-06*
