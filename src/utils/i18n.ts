/**
 * Centralized i18n module for LLM-for-Zotero.
 *
 * Design: English is the source of truth. All UI strings stay hardcoded in
 * English throughout the codebase. The `t()` function wraps them — when the
 * user picks Chinese, it looks up a translation map; otherwise it returns the
 * original English string unchanged.
 *
 * Adding a new English string requires NO changes here — it will just show
 * in English until a Chinese translation is added to the map.
 */

// ── Chinese (Simplified) translation map ────────────────────────────────────

const zhCN: Record<string, string> = {
  // ── Shortcut actions ────────────────────────────────────────────────────
  "Summarize": "摘要",
  "Key Points": "要点",
  "Methodology": "方法论",
  "Limitations": "局限性",

  // ── Chat panel UI ───────────────────────────────────────────────────────
  "LLM-for-Zotero": "LLM-for-Zotero",
  "Start a new chat": "开始新对话",
  "Conversation history": "对话历史",
  "Note editing": "笔记编辑",
  "Library chat": "文献库对话",
  "Paper chat": "论文对话",
  "Switch to paper chat": "切换到论文对话",
  "Switch to library chat": "切换到文献库对话",
  "Lock library chat as default": "锁定文献库对话为默认",
  "Settings": "设置",
  "Open plugin settings": "打开插件设置",
  "Export": "导出",
  "Clear": "清除",
  "Rename": "重命名",
  "Rename chat": "重命名对话",
  "Undo": "撤销",
  "Restore deleted conversation": "恢复已删除的对话",
  "Copy": "复制",
  "Save as note": "保存为笔记",
  "Delete conversation": "删除对话",
  "Delete this turn": "删除此轮对话",
  "Delete this prompt and response": "删除此提问和回答",
  "Copy chat as md": "复制对话为 Markdown",
  "Save chat as note": "保存对话为笔记",
  "Upload files": "上传文件",
  "Add documents or images": "添加文档或图片",
  "Select references": "选择参考文献",
  "Add papers from your library": "从你的文献库添加论文",
  "Send current PDF page": "发送当前 PDF 页面",
  "Capture the visible page as an image": "将可见页面截图发送",
  "Send multiple PDF pages": "发送多个 PDF 页面",
  "Select pages from the open PDF": "选择打开 PDF 中的页面",
  "Select collection": "选择文献集",
  "Add a Zotero collection as context": "将 Zotero 文献集添加为上下文",
  "Literature review": "文献综述",
  "Launch a literature review workflow": "启动文献综述工作流",
  "Browse and select a collection to add its papers as context.": "浏览并选择一个文献集，将其中的论文添加为上下文。",
  "Edit the prompt and press Send to start your literature review.": "编辑提示词并按发送开始你的文献综述。",
  "Please conduct a literature review on the following topic:\n\n[Enter your research topic here]\n\nPlease search my library, identify relevant papers, summarize key findings, and highlight research gaps.": "请对以下主题进行文献综述：\n\n[在此输入你的研究主题]\n\n请搜索我的文献库，找出相关论文，总结主要发现，并指出研究空白。",
  "Capturing PDF pages...": "正在捕获 PDF 页面...",
  "Enter page numbers or ranges (e.g. 1-5, 8, 12):": "输入页码或范围（例如 1-5, 8, 12）：",
  "Select PDF pages": "选择 PDF 页面",
  "Send current entire PDF": "发送当前整个 PDF",
  "Add the open PDF file to context": "将打开的 PDF 文件添加到上下文",
  "Switch to Agent mode": "切换到 Agent 模式",
  "Agent mode": "Agent 模式",
  // "Agent (beta)" — intentionally not translated, keep English
  "Agent actions": "Agent 操作",
  "Base actions": "基础操作",
  "Selected screenshot preview": "已选截图预览",
  "Expand figures": "展开图片",
  "Clear selected screenshots": "清除已选截图",
  "Expand files": "展开文件",
  "Clear uploaded files": "清除已上传文件",
  "Ask about this paper... Type / for actions, @ to add papers": "询问关于这篇论文的问题... 输入 / 查看操作，@ 添加论文",
  "Ask anything... Type / for actions, @ to add papers": "随便问... 输入 / 查看操作，@ 添加论文",
  "Open a PDF first": "请先打开一个 PDF",
  "Include selected reader text": "包含选中的阅读器文本",
  "Select figure screenshot": "选择图片截图",
  "Context actions": "上下文操作",
  "Reasoning": "推理",
  "Send": "发送",
  "Cancel": "取消",
  "No active paper context. Type / to add papers.": "没有活跃的论文上下文。输入 / 添加论文。",
  "Ready": "就绪",
  "Select an item or open a PDF": "选择一个条目或打开 PDF",

  // ── Status messages ─────────────────────────────────────────────────────
  "No assistant text selected": "没有选中助手文本",
  "Copied response": "已复制回复",
  "Created a new note": "已创建新笔记",
  "Failed to create note": "创建笔记失败",
  "No deletable turn found": "没有可删除的对话轮次",
  "No chat history detected.": "未检测到对话历史。",
  "Copied chat as md": "已复制对话为 Markdown",
  "Saved chat history to new note": "已将对话历史保存为新笔记",
  "Failed to save chat history": "保存对话历史失败",
  "Could not open plugin settings": "无法打开插件设置",
  "Could not focus this paper": "无法聚焦到此论文",
  "Failed to fully delete turn. Check logs.": "未能完全删除对话轮次，请查看日志。",
  "Turn deleted": "已删除对话轮次",
  "Turn restored": "已恢复对话轮次",
  "Cannot delete while generating": "生成中无法删除",
  "Delete target changed": "删除目标已更改",
  "Turn deleted. Undo available.": "已删除对话轮次。可撤销。",
  "Conversation restored": "对话已恢复",
  "Chat title cannot be empty": "对话标题不能为空",
  "History is unavailable while generating": "生成中无法查看历史",
  "Conversation renamed": "对话已重命名",
  "Failed to rename conversation": "重命名对话失败",
  "No active library for deletion": "没有可用的文献库用于删除",
  "Cannot resolve active paper session": "无法解析当前论文会话",
  "Cannot delete active conversation right now": "当前无法删除活跃的对话",
  "Conversation deleted. Undo available.": "对话已删除。可撤销。",
  "Wait for the current response to finish before starting a new chat": "请等待当前回复完成后再开始新对话",
  "No active library for global conversation": "没有可用的文献库用于全局对话",
  "Failed to create conversation": "创建对话失败",
  "Reused existing new conversation": "已复用现有新对话",
  "Started new conversation": "已开始新对话",
  "Open a paper to start a paper chat": "打开一篇论文以开始论文对话",
  "No active paper for paper chat": "没有活跃的论文用于论文对话",
  "Failed to create paper chat": "创建论文对话失败",
  "Reused existing new chat": "已复用现有新对话",
  "Started new paper chat": "已开始新的论文对话",
  "Wait for the current response to finish before switching modes": "请等待当前回复完成后再切换模式",
  "Conversation loaded": "对话已加载",
  "Paper already selected": "论文已选中",
  "Selected note is empty": "所选笔记为空",
  "Note already selected": "笔记已选中",
  "Note context added as text.": "笔记内容已作为文本添加。",
  "File already selected": "文件已选中",
  "Figures cleared": "图片已清除",
  "Files cleared": "文件已清除",
  "File pinned for next sends": "文件已固定于后续发送",
  "File unpinned": "文件已取消固定",
  "Selected text removed": "已移除选中文本",
  "Cancelled": "已取消",
  "Select a region...": "选择一个区域...",
  "Selection cancelled": "选择已取消",
  "Screenshot failed": "截图失败",
  "Capturing PDF page...": "正在截取 PDF 页面...",
  "Loading PDF...": "正在加载 PDF...",
  "No PDF page found — open a PDF in the reader first": "未找到 PDF 页面 — 请先在阅读器中打开 PDF",
  "PDF page capture failed": "PDF 页面截取失败",
  "Could not locate the PDF file": "无法找到 PDF 文件",
  "Multiple PDFs found — select a specific PDF attachment": "找到多个 PDF — 请选择特定的 PDF 附件",
  "No PDF found — open a PDF or select an item with a PDF attachment": "未找到 PDF — 请打开 PDF 或选择带有 PDF 附件的条目",
  "PDF added to context": "PDF 已添加到上下文",
  "Failed to load PDF": "加载 PDF 失败",
  "Appended to existing note": "已追加到现有笔记",
  "Reference picker ready. Browse collections or type to search papers.": "参考文献选择器已就绪。浏览分类或输入搜索论文。",
  "Tip: Enable Agent mode in Preferences for a better library chat experience.": "提示：在偏好设置中启用 Agent 模式以获得更好的文献库对话体验。",
  "Agent mode enabled": "Agent 模式已启用",
  "Chat mode enabled": "对话模式已启用",
  "Agent mode ON. Click to switch to Chat mode": "Agent 模式已开启。点击切换到对话模式",
  "Agent mode OFF. Click to switch to Agent mode": "Agent 模式已关闭。点击切换到 Agent 模式",
  "Switch to Chat mode": "切换到对话模式",
  "Paper mode only accepts text from this paper": "论文模式仅接受来自此论文的文本",
  "Edit target changed. Please edit latest prompt again.": "编辑目标已更改。请重新编辑最新的提示。",
  "Deleted one turn": "已删除一轮对话",
  "No models configured yet.": "尚未配置模型。",
  "Select model": "选择模型",
  "Reasoning level": "推理级别",
  "Expand files panel": "展开文件面板",
  "Collapse files panel": "收起文件面板",
  "Expand figures panel": "展开图片面板",
  "Collapse figures panel": "收起图片面板",
  "Live note preview is pinned while editing": "编辑时实时笔记预览已固定",
  "Editing focus syncs to the live note selection": "编辑焦点同步至实时笔记选择",
  "Text context pinned for next sends": "文本上下文已固定于后续发送",
  "Text context unpinned": "文本上下文已取消固定",
  "Screenshot pinned for next sends": "截图已固定于后续发送",
  "Screenshot unpinned": "截图已取消固定",
  "Paper set to always send full text.": "论文已设为始终发送全文。",
  "Paper set to retrieval mode.": "论文已设为检索模式。",
  "Paper context added. Full text will be sent on the next turn.": "论文上下文已添加。全文将在下一轮发送。",
  "Source: MinerU (enhanced markdown)": "来源: MinerU（增强 Markdown）",
  "(MinerU)": "（MinerU）",
  "Failed to fully delete conversation. Check logs.": "未能完全删除对话，请查看日志。",

  // ── Constants / count labels ────────────────────────────────────────────
  "Add Text": "添加文本",
  "Screenshots": "截图",
  "Figure": "图片",
  "Figures": "图片",
  "Files": "文件",
  "Papers": "论文",
  "Primary": "主要",
  "Secondary": "次要",
  "Tertiary": "第三",
  "Quaternary": "第四",

  // ── MinerU manager ──────────────────────────────────────────────────────
  "My Library": "我的文献库",
  "Unfiled Items": "未分类条目",
  "Title": "标题",
  "Author": "作者",
  "Year": "年份",
  "Added": "添加日期",
  "Pause": "暂停",
  "Start All": "全部开始",
  "Start Folder": "开始此文件夹",
  "Delete All Cache": "删除所有缓存",
  "Delete Folder Cache": "删除文件夹缓存",
  "Process This Item": "处理此条目",
  "Show in File Manager": "在文件管理器中显示",
  "Delete confirmation": "删除确认",
  "Delete MinerU Cache": "删除 MinerU 缓存",
  "Start Selected": "开始所选",
  "Delete Cache": "删除缓存",
  "Delete MinerU cache for": "删除 MinerU 缓存，共",
  "selected item(s)?": "个所选条目？",
  "item(s) in this folder?": "个此文件夹中的条目？",
  "Delete all MinerU cached files? This cannot be undone.": "删除所有 MinerU 缓存文件？此操作无法撤销。",
  "Manage Files": "管理文件",
  "items failed": "个条目失败",
  "Failed": "失败",
  "Auto-parse newly added items": "自动解析新加入文献",
  "Processing": "解析中",

  // ── Preferences page ───────────────────────────────────────────────────
  "AI Providers": "AI 服务商",
  "Customization": "自定义",
  "Agent": "Agent",
  "MinerU": "MinerU",
  "Custom System Prompt (Optional)": "自定义系统提示词（可选）",
  "Custom instructions for the AI assistant...": "为 AI 助手设置自定义指令...",
  "Add custom instructions to the default system prompt (leave empty to use default only)": "在默认系统提示词基础上添加自定义指令（留空则仅使用默认）",
  "View default system prompt": "查看默认系统提示词",
  'Show "Add Text" in reader selection popup': '在阅读器选区弹出菜单中显示"添加文本"',
  "Disable this if you prefer not to show the Add Text option in Zotero's text selection popup menu.": '如果你不想在 Zotero 文本选区弹出菜单中显示"添加文本"选项，请禁用此项。',
  "Enable Agent Mode (Beta)": "启用 Agent 模式（测试版）",
  'Shows the "Agent (beta)" toggle in the context bar, enabling the agentic multi-step assistant. Off by default — enable only if you want to experiment with the beta feature.': '在上下文栏显示"Agent（测试版）"切换按钮，启用多步骤 Agent 助手。默认关闭 — 仅在你想体验测试版功能时启用。',
  "MinerU PDF Parsing": "MinerU PDF 解析",
  "Extract high-quality structured text from PDFs with preserved math formulas, tables, and figures. MinerU dramatically improves how the AI understands your papers.": "从 PDF 中提取高质量结构化文本，保留数学公式、表格和图片。MinerU 显著提升 AI 对论文的理解能力。",
  "Enable MinerU PDF Parsing": "启用 MinerU PDF 解析",
  "No API key needed to get started!": "无需 API 密钥即可开始使用！",
  "You can parse up to 5 papers per day using the built-in community quota.": "使用内置社区配额，每天最多可解析 5 篇论文。",
  "For unlimited parsing (2,000 pages/day), get your own free API key from": "如需无限解析（每天 2,000 页），请从以下网站获取免费 API 密钥：",
  "and paste it below.": "并粘贴到下方。",
  "API Key (Optional)": "API 密钥（可选）",
  "Leave empty to use community quota (5/day)": "留空使用社区配额（5次/天）",
  "With your own key: unlimited parsing, direct connection to mineru.net": "使用自己的密钥：无限解析，直连 mineru.net",
  "Test Connection": "测试连接",
  "Enter an API key first": "请先输入 API 密钥",
  "Testing…": "测试中…",
  "✓ Connection successful": "✓ 连接成功",
  // Obsidian integration
  "Obsidian Integration": "Obsidian 集成",
  "Write notes from your Zotero papers directly to your Obsidian vault. Configure the vault path and default folder below.":
    "将 Zotero 论文笔记直接写入 Obsidian 知识库。在下方配置知识库路径和默认文件夹。",
  "Vault Path": "知识库路径",
  "Absolute path to your Obsidian vault folder": "Obsidian 知识库文件夹的绝对路径",
  "Default Folder": "默认文件夹",
  "Default subfolder for notes (the agent can write to any folder if you specify)": "笔记的默认子文件夹（你可以指定其他文件夹，Agent 会写入你指定的位置）",
  "Note Template": "笔记模板",
  "Customize the template used when writing notes to Obsidian. Use {{title}}, {{date}}, {{content}} as placeholders.":
    "自定义写入 Obsidian 时使用的笔记模板。使用 {{title}}、{{date}}、{{content}} 作为占位符。",
  "Reset to Default": "恢复默认",
  "Attachments Folder": "附件文件夹",
  "Subfolder for copied figures and images (e.g., assets, attachments)": "用于存放复制的图片和附件的子文件夹（如 assets、attachments）",
  "Test Write Access": "测试写入权限",
  "Write access verified": "✓ 写入权限已验证",
  "Enter a vault path first": "请先输入知识库路径",
  "Each provider has an auth mode, API URL, and one or more model variants.": "每个服务商有一个认证模式、API URL 和一个或多个模型变体。",
  "Choose a preset above, or switch to Customized to enter a full base URL or endpoint manually.": '选择上方的预设，或切换到"自定义"以手动输入完整的基础 URL 或端点。',
  "codex auth usually uses https://chatgpt.com/backend-api/codex/responses": "codex 认证通常使用 https://chatgpt.com/backend-api/codex/responses",
  "Legacy direct ChatGPT/Codex backend mode. Existing users can keep using it in this release. New users should use Codex App Server. Planned for deprecation in a future release after app-server validation.": "旧版的 ChatGPT/Codex 直连后端模式。当前用户在此版本中可以继续使用，但新用户应改用 Codex App Server。待 app-server 验证稳定后，会在未来版本中计划弃用。",
  "Recommended official Codex integration. Runs the local `codex app-server` CLI and routes turns through it. Run `codex login` first.": "推荐的官方 Codex 集成方式。它会运行本地 `codex app-server` CLI 并通过它处理对话。请先运行 `codex login`。",
  "Legacy direct backend URL. Usually uses https://chatgpt.com/backend-api/codex/responses. Existing users can keep it in this release, but new users should use Codex App Server. Planned for deprecation in a future release after app-server validation.": "旧版直连后端 URL，通常使用 https://chatgpt.com/backend-api/codex/responses。当前用户在此版本中可以继续使用，但新用户应改用 Codex App Server。待 app-server 验证稳定后，会在未来版本中计划弃用。",
  "Uses Codex responses with the local codex app-server transport.": "通过本地 codex app-server 传输使用 Codex responses。",
  "Uses Codex responses with the legacy direct backend transport.": "通过旧版直连后端传输使用 Codex responses。",
  "Switch Provider to Customized to edit this URL manually.": '将服务商切换到"自定义"以手动编辑此 URL。',
  "Switch to Customized to edit the URL manually.": '切换到"自定义"以手动编辑 URL。',
  "Provider": "服务商",
  "Customized": "自定义",
  "Protocol": "协议",
  "API URL": "API URL",
  "API Key": "API 密钥",
  "codex auth": "codex 认证",
  "Codex Auth": "Codex 认证",
  "Codex Auth (Legacy)": "Codex 认证（旧版）",
  "Codex App Server": "Codex App Server",
  "Transport is handled by the codex subprocess; no API URL is needed.": "传输由 codex 子进程处理，不需要 API URL。",
  "Auth Mode": "认证模式",
  "Model names": "模型名称",
  "Add model": "添加模型",
  "Fill in the current model name first": "请先填写当前模型名称",
  "Test": "测试",
  "Advanced options": "高级选项",
  "Remove model": "移除模型",
  "Remove provider": "移除服务商",
  "Temperature": "温度",
  "Max tokens": "最大 Token 数",
  "Input cap": "输入上限",
  "Temperature: randomness (0–2)  ·  Max tokens: output limit  ·  Input cap: context limit (optional)": "温度：随机性 (0–2)  ·  最大 Token 数：输出限制  ·  输入上限：上下文限制（可选）",
  "Complete the empty provider first": "请先完善空白的服务商",
  "Add provider": "添加服务商",
  "+ Add Provider": "+ 添加服务商",
  "API URL is required": "API URL 为必填项",
  "API Key is required": "API 密钥为必填项",
  "codex token missing. Run `codex login` first.": "codex 令牌缺失。请先运行 `codex login`。",
  "Agent capability: ": "Agent 能力: ",
  "✓ Success — model says: ": "✓ 成功 — 模型回复: ",
  "codex auth reuses local `codex login` credentials from ~/.codex/auth.json": "codex 认证复用本地 `codex login` 凭据（~/.codex/auth.json）",
  "GitHub Copilot": "GitHub Copilot",
  "Login with GitHub Copilot": "使用 GitHub Copilot 登录",
  "Re-login": "重新登录",
  "Logged in to GitHub Copilot": "已登录 GitHub Copilot",
  "Log out": "登出",
  "Requesting device code…": "正在请求设备码…",
  "Enter this code on GitHub:": "在 GitHub 上输入此代码：",
  "Login successful!": "登录成功！",
  "Copilot token missing. Click Login first.": "Copilot 令牌缺失。请先点击登录。",
  "GitHub Copilot uses device-based login. Click Login to authenticate via GitHub.": "GitHub Copilot 使用设备认证。点击登录按钮通过 GitHub 进行认证。",
  "Fetch available models": "获取可用模型",
  "Fetching models…": "正在获取模型…",
  "No models found": "未找到模型",
  "Synced %n models": "已同步 %n 个模型",

  // ── Language setting ────────────────────────────────────────────────────
  "Language": "语言",
  "Auto (follow Zotero)": "自动（跟随 Zotero）",
  "Restart Zotero to apply language change.": "重启 Zotero 以应用语言更改。",
};

// ── Runtime state ────────────────────────────────────────────────────────────

let currentLocale: string = "auto";

/**
 * Initialize i18n — call once at plugin startup.
 */
export function initI18n(): void {
  try {
    const pref = Zotero.Prefs.get(
      "extensions.zotero.llmforzotero.locale",
      true,
    );
    currentLocale = typeof pref === "string" ? pref : "auto";
  } catch {
    currentLocale = "auto";
  }
}

function getEffectiveLocale(): string {
  if (currentLocale !== "auto") return currentLocale;
  try {
    return (Zotero as unknown as { locale?: string }).locale || "en-US";
  } catch {
    return "en-US";
  }
}

/**
 * Translate an English UI string.
 *
 * - When locale is Chinese: look up the zhCN map; fall back to the English
 *   string if no translation exists.
 * - When locale is English (or anything else): return the English string as-is.
 *
 * Usage:  `button.textContent = t("Start All");`
 */
export function t(en: string): string {
  if (getEffectiveLocale().startsWith("zh")) {
    return zhCN[en] ?? en;
  }
  return en;
}

/**
 * Returns the welcome screen HTML, translated if needed.
 * Centralized here to keep the full welcome text in one place.
 */
export function getWebChatWelcomeHtml(targetLabel?: string, targetDomain?: string): string {
  const label = targetLabel || "WebChat";
  const domain = targetDomain || "the chat site";
  if (getEffectiveLocale().startsWith("zh")) {
    return `
      <div class="llm-welcome">
        <div class="llm-welcome-icon">🌐</div>
        <div class="llm-welcome-text">
          <div class="llm-welcome-title">${label} Web Sync 模式</div>
          <ul class="llm-welcome-list">
            <li>你的问题将通过浏览器扩展直接发送到 <strong>${domain}</strong>。请确保扩展已安装并且对应的标签页已打开。</li>
            <li>右键点击论文标签可切换是否发送 <strong>PDF 全文</strong>。紫色 = 发送，灰色 = 跳过。</li>
            <li>使用截图按钮可附加<strong>图片上下文</strong>到你的消息中。</li>
            <li>点击 <strong>Exit</strong> 按钮可退出 WebChat 模式，恢复到常规 API 模式。</li>
          </ul>
        </div>
      </div>
    `;
  }
  return `
    <div class="llm-welcome">
      <div class="llm-welcome-icon">🌐</div>
      <div class="llm-welcome-text">
        <div class="llm-welcome-title">${label} Web Sync mode</div>
        <ul class="llm-welcome-list">
          <li>Your questions are sent directly to <strong>${domain}</strong> via the browser extension. Make sure the extension is installed and a ${label} tab is open.</li>
          <li>Right-click a paper chip to toggle sending its <strong>full PDF</strong>. Purple = send, grey = skip.</li>
          <li>Use the screenshot button to attach <strong>figure context</strong> to your message.</li>
          <li>Click the <strong>Exit</strong> button to leave WebChat mode and return to regular API mode.</li>
        </ul>
      </div>
    </div>
  `;
}

export function getWelcomeHtml(): string {
  if (getEffectiveLocale().startsWith("zh")) {
    return `
      <div class="llm-welcome">
        <div class="llm-welcome-icon">💬</div>
        <div class="llm-welcome-text">
          <div class="llm-welcome-title">开始对话 — 以下是你可以做的。</div>
          <ul class="llm-welcome-list">
            <li><strong>论文对话</strong>回答关于当前打开的 PDF 的问题。<strong>开放对话</strong>是一个自由形式的工作区，可跨多篇论文和文件提问。</li>
            <li>输入 <strong>/</strong> 打开快捷操作：附加文件、添加参考文献、发送当前 PDF 页面或发送整个 PDF。输入 <strong>@</strong> 从文献库添加论文作为上下文。</li>
            <li>在工具栏中启用 <strong>Agent 模式</strong>，让助手自主搜索文献库、查看论文并完成多步骤研究任务。</li>
            <li>内联添加上下文：在 PDF 阅读器中选择文本作为<strong>文本上下文</strong>，使用截图按钮作为<strong>图片上下文</strong>，或使用 <strong>@</strong> 作为<strong>论文上下文</strong>。右键点击论文标签可强制发送全文；再次右键点击切换回检索模式。</li>
          </ul>
        </div>
      </div>
    `;
  }
  return `
    <div class="llm-welcome">
      <div class="llm-welcome-icon">💬</div>
      <div class="llm-welcome-text">
        <div class="llm-welcome-title">Start chatting — here's what you can do.</div>
        <ul class="llm-welcome-list">
          <li><strong>Paper chat</strong> answers questions about the currently open PDF. <strong>Library chat</strong> is a free-form workspace for questions across multiple papers and files.</li>
          <li>Type <strong>/</strong> to open quick actions: attach files, add a reference, send the current PDF page, or send the entire PDF. Type <strong>@</strong> to add a paper from your library as context.</li>
          <li>Enable <strong>Agent mode</strong> with the toggle in the toolbar to let the assistant autonomously search your library, inspect papers, and complete multi-step research tasks.</li>
          <li>Add context inline: select text in the PDF reader for <strong>text context</strong>, use the screenshot button for <strong>figure context</strong>, or use <strong>@</strong> for <strong>paper context</strong>. Right-click a paper chip to force sending its full text; right-click again to switch it back to retrieval mode.</li>
        </ul>
      </div>
    </div>
  `;
}

export function getPaperChatStartPageHtml(): string {
  if (getEffectiveLocale().startsWith("zh")) {
    return `
      <div class="llm-start-page">
        <div class="llm-start-page-title">LLM-for-Zotero</div>
        <div class="llm-start-page-subtitle">从这里开始，读懂这篇论文的一切</div>
        <div class="llm-start-page-desc">
          <p>论文对话回答关于当前活跃论文的问题。论文将在你提问前预加载到上下文中。</p>
          <p>内联添加上下文：<strong>文本</strong>、<strong>截图</strong>或 <strong>@论文</strong>。左键点击论文标签发送 PDF；右键点击切换全文/检索模式。</p>
          <p>使用文献库对话请点击顶部的<strong>在新窗口中打开</strong>按钮。</p>
        </div>
      </div>
    `;
  }
  return `
    <div class="llm-start-page">
      <div class="llm-start-page-title">LLM-for-Zotero</div>
      <div class="llm-start-page-subtitle">Understand everything of this paper, from here</div>
      <div class="llm-start-page-desc">
        <p>Paper chat answers questions about your current active paper. The paper will be pre-loaded into context before your first question.</p>
        <p>Add context inline: <strong>text</strong>, <strong>screenshots</strong>, or <strong>@papers</strong>. Left-click a paper chip to send its PDF; right-click to toggle between full-text and retrieval mode.</p>
        <p>For library chat, click the <strong>Open in Window</strong> button at the top.</p>
      </div>
    </div>
  `;
}

export function getNoteEditingStartPageHtml(): string {
  if (getEffectiveLocale().startsWith("zh")) {
    return `
      <div class="llm-start-page">
        <div class="llm-start-page-title">LLM-for-Zotero</div>
        <div class="llm-start-page-subtitle">一起写笔记，让想法进化</div>
        <div class="llm-start-page-desc">
          <p>选中一段文字，我可以帮你<strong>重写润色</strong>。</p>
          <p>如果是条目笔记，论文上下文会<strong>自动预加载</strong>；如果是独立笔记，那就自由发挥吧。</p>
          <p>重写后的内容会以 <strong>diff 模式</strong>显示，让你清楚看到每处改动，帮助你越写越好。</p>
        </div>
      </div>
    `;
  }
  return `
    <div class="llm-start-page">
      <div class="llm-start-page-title">LLM-for-Zotero</div>
      <div class="llm-start-page-subtitle">Write with me, evolve your ideas</div>
      <div class="llm-start-page-desc">
        <p>Select a text snippet, and I can <strong>rewrite</strong> it for you.</p>
        <p>If it's an item note, the paper context will be <strong>automatically preloaded</strong> for you; if it's a standalone note, let's freestyle.</p>
        <p>The rewritten note will show in <strong>diff mode</strong>, so you can see exactly what changed — helping you evolve to write better.</p>
      </div>
    </div>
  `;
}

export function getStandaloneLibraryChatStartPageHtml(): string {
  if (getEffectiveLocale().startsWith("zh")) {
    return `
      <div class="llm-standalone-start-page">
        <div class="llm-start-page-title">LLM-for-Zotero Agent</div>
        <div class="llm-start-page-subtitle">为你和你的文献库服务</div>
        <div class="llm-start-page-recommendations">
          <div class="llm-start-page-rec-title">推荐设置以获得最佳体验</div>
          <ol class="llm-start-page-rec-list">
            <li><strong>偏好设置 → MinerU</strong>：将 PDF 解析为 Markdown + 图片<span class="llm-rec-reason">（MD 是 LLM 的语言；可以利用解析出的图片写出更好的笔记；节省 token）</span></li>
            <li>启用 <strong>Agent 模式</strong>，让助手自主完成研究任务</li>
            <li>使用<strong>高智能模型</strong>：如 Codex、GPT-5.4 等</li>
            <li>在偏好设置中配置<strong>笔记目录路径</strong>（设置 → Agent 标签页）</li>
          </ol>
        </div>
      </div>
    `;
  }
  return `
    <div class="llm-standalone-start-page">
      <div class="llm-start-page-title">LLM-for-Zotero Agent</div>
      <div class="llm-start-page-subtitle">serve you and your library</div>
      <div class="llm-start-page-recommendations">
        <div class="llm-start-page-rec-title">Recommended settings for the best experience</div>
        <ol class="llm-start-page-rec-list">
          <li><strong>Preferences → MinerU</strong>: parse your PDFs to Markdown + images<span class="llm-rec-reason"> (MD is the language of LLMs; enables better notes with parsed images; saves tokens)</span></li>
          <li>Activate <strong>Agent mode</strong> for autonomous research</li>
          <li>Use an <strong>intelligent model</strong>: Codex, GPT-5.4, or similar high-intelligence models</li>
          <li>Set up <strong>Notes directory</strong> in Preferences (Settings → Agent tab)</li>
        </ol>
      </div>
    </div>
  `;
}
