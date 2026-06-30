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
  Summarize: "摘要",
  "Key Points": "要点",
  Methodology: "方法论",
  Limitations: "局限性",

  // ── Chat panel UI ───────────────────────────────────────────────────────
  "LLM-for-Zotero": "LLM-for-Zotero",
  "Start a new chat": "开始新对话",
  "Conversation history": "对话历史",
  "Note editing": "笔记编辑",
  "Library chat": "文献库对话",
  "Paper chat": "论文对话",
  Orphan: "孤立对话",
  "Switch to paper chat": "切换到论文对话",
  "Switch to library chat": "切换到文献库对话",
  Settings: "设置",
  "Open plugin settings": "打开插件设置",
  Export: "导出",
  Clear: "清除",
  Rename: "重命名",
  "Rename chat": "重命名对话",
  Undo: "撤销",
  "Restore deleted conversation": "恢复已删除的对话",
  Copy: "复制",
  "Save as note": "保存为笔记",
  "Delete conversation": "删除对话",
  "Delete this turn": "删除此轮对话",
  "Delete this prompt and response": "删除此提问和回答",
  "Fork this turn": "从此轮分叉",
  "Start a new chat from this turn": "从此轮开始新的对话",
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
  "Browse and select a collection to add its papers as context.":
    "浏览并选择一个文献集，将其中的论文添加为上下文。",
  "Edit the prompt and press Send to start your literature review.":
    "编辑提示词并按发送开始你的文献综述。",
  "Please conduct a literature review on the following topic:\n\n[Enter your research topic here]\n\nPlease search my library, identify relevant papers, summarize key findings, and highlight research gaps.":
    "请对以下主题进行文献综述：\n\n[在此输入你的研究主题]\n\n请搜索我的文献库，找出相关论文，总结主要发现，并指出研究空白。",
  "Capturing PDF pages...": "正在捕获 PDF 页面...",
  "Enter page numbers or ranges (e.g. 1-5, 8, 12):":
    "输入页码或范围（例如 1-5, 8, 12）：",
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
  "Ask about this paper... Type / for actions, @ to add papers":
    "询问关于这篇论文的问题... 输入 / 查看操作，@ 添加论文",
  "Ask anything... Type / for actions, @ to add papers":
    "随便问... 输入 / 查看操作，@ 添加论文",
  "Open a PDF first": "请先打开一个 PDF",
  "Include selected reader text": "包含选中的阅读器文本",
  "Select figure screenshot": "选择图片截图",
  "Context actions": "上下文操作",
  Reasoning: "推理",
  Send: "发送",
  Cancel: "取消",
  "No active paper context. Type / to add papers.":
    "没有活跃的论文上下文。输入 / 添加论文。",
  Ready: "就绪",
  "Select an item or open a PDF": "选择一个条目或打开 PDF",

  // ── Status messages ─────────────────────────────────────────────────────
  "No assistant text selected": "没有选中助手文本",
  "Copied response": "已复制回复",
  "Created a new note": "已创建新笔记",
  "Failed to create note": "创建笔记失败",
  "No deletable turn found": "没有可删除的对话轮次",
  "No forkable turn found": "没有可分叉的对话轮次",
  "Fork is not supported for this conversation type yet":
    "此对话类型暂不支持分叉",
  "Fork is not supported for Claude Code conversations":
    "Claude Code 对话不支持分叉",
  "Codex fork is only supported for the latest response":
    "Codex 仅支持从最新回复分叉",
  "Cannot fork this Codex conversation because it has no native thread":
    "无法分叉此 Codex 对话，因为它没有原生线程",
  "Wait for the current response to finish before forking":
    "请等待当前回复完成后再分叉",
  "No active library for conversation fork": "没有可用于分叉的活跃文献库",
  "Failed to fork conversation": "分叉对话失败",
  "Conversation forked": "对话已 fork",
  "Forked from conversation": "从对话分叉",
  "Open original conversation": "打开原始对话",
  "No chat history detected.": "未检测到对话历史。",
  "Copied chat as md": "已复制对话为 Markdown",
  "Saved chat history to new note": "已将对话历史保存为新笔记",
  "Failed to save chat history": "保存对话历史失败",
  "Could not open plugin settings": "无法打开插件设置",
  "Could not find this paper": "无法找到此论文",
  "Could not focus this paper": "无法聚焦到此论文",
  "Could not load this conversation": "无法加载此对话",
  "Original conversation not found": "未找到原始对话",
  "This chat's source item was deleted": "此对话的来源条目已被删除",
  "Failed to fully delete turn. Check logs.":
    "未能完全删除对话轮次，请查看日志。",
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
  "Wait for the current response to finish before starting a new chat":
    "请等待当前回复完成后再开始新对话",
  "No active library for global conversation": "没有可用的文献库用于全局对话",
  "Failed to create conversation": "创建对话失败",
  "Reused existing new conversation": "已复用现有新对话",
  "Started new conversation": "已开始新对话",
  "Open a paper to start a paper chat": "打开一篇论文以开始论文对话",
  "No active paper for paper chat": "没有活跃的论文用于论文对话",
  "Open a supported Zotero document to start a paper chat":
    "打开一个受支持的 Zotero 文档以开始论文对话",
  "Failed to create paper chat": "创建论文对话失败",
  "Reused existing new chat": "已复用现有新对话",
  "Started new paper chat": "已开始新的论文对话",
  "Wait for the current response to finish before switching modes":
    "请等待当前回复完成后再切换模式",
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
  Cancelled: "已取消",
  "Select a region...": "选择一个区域...",
  "Selection cancelled": "选择已取消",
  "Screenshot failed": "截图失败",
  "Capturing PDF page...": "正在截取 PDF 页面...",
  "Loading PDF...": "正在加载 PDF...",
  "No PDF page found — open a PDF in the reader first":
    "未找到 PDF 页面 — 请先在阅读器中打开 PDF",
  "PDF page capture failed": "PDF 页面截取失败",
  "Could not locate the PDF file": "无法找到 PDF 文件",
  "Multiple PDFs found — select a specific PDF attachment":
    "找到多个 PDF — 请选择特定的 PDF 附件",
  "No PDF found — open a PDF or select an item with a PDF attachment":
    "未找到 PDF — 请打开 PDF 或选择带有 PDF 附件的条目",
  "PDF added to context": "PDF 已添加到上下文",
  "Failed to load PDF": "加载 PDF 失败",
  "Appended to existing note": "已追加到现有笔记",
  "Reference picker ready. Browse collections or type to search papers.":
    "参考文献选择器已就绪。浏览分类或输入搜索论文。",
  "Tip: Enable Agent mode in Preferences for a better library chat experience.":
    "提示：在偏好设置中启用 Agent 模式以获得更好的文献库对话体验。",
  "Agent mode enabled": "Agent 模式已启用",
  "Chat mode enabled": "对话模式已启用",
  "Agent mode ON. Click to switch to Chat mode":
    "Agent 模式已开启。点击切换到对话模式",
  "Agent mode OFF. Click to switch to Agent mode":
    "Agent 模式已关闭。点击切换到 Agent 模式",
  "Switch to Chat mode": "切换到对话模式",
  "Paper mode only accepts text from this paper":
    "论文模式仅接受来自此论文的文本",
  "Edit target changed. Please edit latest prompt again.":
    "编辑目标已更改。请重新编辑最新的提示。",
  "Deleted one turn": "已删除一轮对话",
  "No models configured yet.": "尚未配置模型。",
  "Select model": "选择模型",
  "Reasoning level": "推理级别",
  "Expand files panel": "展开文件面板",
  "Collapse files panel": "收起文件面板",
  "Expand figures panel": "展开图片面板",
  "Collapse figures panel": "收起图片面板",
  "Live note preview is pinned while editing": "编辑时实时笔记预览已固定",
  "Editing focus syncs to the live note selection":
    "编辑焦点同步至实时笔记选择",
  "Text context pinned for next sends": "文本上下文已固定于后续发送",
  "Text context unpinned": "文本上下文已取消固定",
  "Screenshot pinned for next sends": "截图已固定于后续发送",
  "Screenshot unpinned": "截图已取消固定",
  "Paper set to always send full text.": "论文已设为始终发送全文。",
  "Paper set to retrieval mode.": "论文已设为检索模式。",
  "Paper context added. Full text will be sent on the next turn.":
    "论文上下文已添加。全文将在下一轮发送。",
  "Source: MinerU (enhanced markdown)": "来源: MinerU（增强 Markdown）",
  "(MinerU)": "（MinerU）",
  "Failed to fully delete conversation. Check logs.":
    "未能完全删除对话，请查看日志。",
  "Failed to delete conversation. Codex thread was not archived.":
    "未能删除对话。Codex 线程尚未归档。",
  "Failed to delete conversation because its saved identity is inconsistent. Check logs.":
    "由于保存的对话身份不一致，未能删除对话。请查看日志。",

  // ── Constants / count labels ────────────────────────────────────────────
  "Add Text": "添加文本",
  Screenshots: "截图",
  Figure: "图片",
  Figures: "图片",
  Files: "文件",
  Papers: "论文",
  Primary: "主要",
  Secondary: "次要",
  Tertiary: "第三",
  Quaternary: "第四",

  // ── MinerU manager ──────────────────────────────────────────────────────
  "My Library": "我的文献库",
  "Unfiled Items": "未分类条目",
  Title: "标题",
  Author: "作者",
  Year: "年份",
  Added: "添加日期",
  Pause: "暂停",
  "Start All": "全部开始",
  "Start Filtered": "开始筛选项",
  "Repair Cache": "修复缓存",
  "Repairing...": "正在修复...",
  "Repairing MinerU cache...": "正在修复 MinerU 缓存...",
  "Delete All Cache": "删除所有缓存",
  "Delete Filtered Cache": "删除筛选缓存",
  "Process This Item": "处理此条目",
  "Show in File Manager": "在文件管理器中显示",
  "Delete confirmation": "删除确认",
  "Delete MinerU Cache": "删除 MinerU 缓存",
  "Start Selected": "开始所选",
  "Delete Cache": "删除缓存",
  "Delete MinerU cache for": "删除 MinerU 缓存，共",
  "selected item(s)?": "个所选条目？",
  "selected item(s) are skipped by MinerU parsing filters. Parse anyway?":
    "个所选条目被 MinerU 解析过滤器跳过。仍要解析吗？",
  "item(s) in this filter?": "个筛选出的条目？",
  "Delete all MinerU cached files? This cannot be undone.":
    "删除所有 MinerU 缓存文件？此操作无法撤销。",
  Skipped: "已跳过",
  "Manage Files": "管理文件",
  "Folder View": "文件夹视图",
  Folder: "文件夹",
  Folders: "文件夹",
  "Tag View": "标签视图",
  "Item View": "条目视图",
  Items: "条目",
  Status: "状态",
  Tags: "标签",
  "All Tagged": "有标签",
  Untagged: "无标签",
  "Filter Folders": "筛选文件夹",
  "Filter Tags": "筛选标签",
  "Search Items": "搜索条目",
  "Clear item search": "清除条目搜索",
  "Item search": "条目搜索",
  "Expand panel": "展开面板",
  "Collapse panel": "收起面板",
  "Resize panel": "调整面板大小",
  "Remove reference context": "移除引用上下文",
  "Reference context removed.": "已移除引用上下文。",
  "Add tag as context": "将标签作为上下文添加",
  "Remove tag context": "移除标签上下文",
  "Tag context added.": "已添加标签上下文。",
  "Tag context removed.": "已移除标签上下文。",
  "Tag filter options": "标签筛选选项",
  "Use OR rule": "使用 OR 规则",
  OR: "或",
  "Show automatic tags": "显示自动标签",
  selected: "已选择",
  clear: "清除",
  "papers match": "篇论文匹配",
  "No matching tags.": "没有匹配的标签。",
  "No tags found. Add tags to your items in Zotero.":
    "未找到标签。请在 Zotero 中为条目添加标签。",
  "items failed": "个条目失败",
  Failed: "失败",
  "Auto-parse newly added items": "自动解析新加入文献",
  Processing: "解析中",

  // ── Preferences page ───────────────────────────────────────────────────
  "AI Providers": "AI 服务商",
  Customization: "自定义",
  Agent: "Agent",
  MinerU: "MinerU",
  "Custom System Prompt (Optional)": "自定义系统提示词（可选）",
  "Custom instructions for the AI assistant...": "为 AI 助手设置自定义指令...",
  "Add custom instructions to the default system prompt (leave empty to use default only)":
    "在默认系统提示词基础上添加自定义指令（留空则仅使用默认）",
  "View default system prompt": "查看默认系统提示词",
  'Show "Add Text" in reader selection popup':
    '在阅读器选区弹出菜单中显示"添加文本"',
  "Disable this if you prefer not to show the Add Text option in Zotero's text selection popup menu.":
    '如果你不想在 Zotero 文本选区弹出菜单中显示"添加文本"选项，请禁用此项。',
  "Enable Agent Mode (Beta)": "启用 Agent 模式（测试版）",
  'Shows the "Agent (beta)" toggle in the context bar, enabling the agentic multi-step assistant. Off by default — enable only if you want to experiment with the beta feature.':
    '在上下文栏显示"Agent（测试版）"切换按钮，启用多步骤 Agent 助手。默认关闭 — 仅在你想体验测试版功能时启用。',
  "MinerU PDF Parsing": "MinerU PDF 解析",
  "Extract high-quality structured text from PDFs with preserved math formulas, tables, and figures. MinerU dramatically improves how the AI understands your papers.":
    "从 PDF 中提取高质量结构化文本，保留数学公式、表格和图片。MinerU 显著提升 AI 对论文的理解能力。",
  "Enable MinerU PDF Parsing": "启用 MinerU PDF 解析",
  "Sync MinerU cache with Zotero file sync": "使用 Zotero 文件同步 MinerU 缓存",
  "Creates companion ZIP attachments for MinerU full.md, manifest.json, content_list.json, and PDF figure crops. Requires Zotero file sync or WebDAV.":
    "为 MinerU full.md、manifest.json、content_list.json 和 PDF 图像裁剪创建配套 ZIP 附件。需要启用 Zotero 文件同步或 WebDAV。",
  "Delete synced MinerU packages": "删除已同步的 MinerU 包",
  "Disable MinerU sync and delete packages": "禁用 MinerU 同步并删除同步包",
  "Delete MinerU sync packages?": "删除 MinerU 同步包？",
  "Disable sync and delete": "禁用同步并删除",
  "Delete packages": "删除包",
  "Synced MinerU ZIP packages are Zotero attachment items. MinerU sync will be disabled, then those package attachments will be deleted. Zotero may show sync conflicts while it syncs these deletions. If that happens, choose the local/deleted version to remove already-uploaded packages from Zotero sync.":
    "已同步的 MinerU ZIP 包是 Zotero 附件条目。将先禁用 MinerU 同步，然后删除这些包附件。Zotero 同步这些删除操作时可能会显示同步冲突。如果出现冲突，请选择本地/已删除版本，以便从 Zotero 同步中移除已上传的包。",
  "Synced MinerU ZIP packages are Zotero attachment items. Those package attachments will be deleted. Zotero may show sync conflicts while it syncs these deletions. If that happens, choose the local/deleted version to remove already-uploaded packages from Zotero sync.":
    "已同步的 MinerU ZIP 包是 Zotero 附件条目。将删除这些包附件。Zotero 同步这些删除操作时可能会显示同步冲突。如果出现冲突，请选择本地/已删除版本，以便从 Zotero 同步中移除已上传的包。",
  "MinerU sync disabled. Existing synced packages are kept until deleted.":
    "MinerU 同步已禁用。已有同步包会保留，直到手动删除。",
  "MinerU sync enabled. Existing local caches sync only when requested.":
    "MinerU 同步已启用。已有本地缓存只会在你手动请求时同步。",
  "Syncing existing MinerU caches…": "正在同步已有 MinerU 缓存…",
  "Syncing existing MinerU caches": "正在同步已有 MinerU 缓存",
  "Existing MinerU caches synced": "已有 MinerU 缓存已同步",
  "Deleting synced MinerU packages…": "正在删除已同步的 MinerU 包…",
  "MinerU sync disabled. Deleting synced MinerU packages…":
    "MinerU 同步已禁用。正在删除已同步的 MinerU 包…",
  "Deleted synced MinerU packages": "已删除同步的 MinerU 包",
  "MinerU sync disabled. Deleted synced MinerU packages":
    "MinerU 同步已禁用。已删除同步的 MinerU 包",
  "Synced MinerU package available; local cache will restore when needed.":
    "已同步的 MinerU 包可用；需要时会恢复本地缓存。",
  "Local MinerU cache and synced package available.":
    "本地 MinerU 缓存和同步包均可用。",
  "Local MinerU cache available.": "本地 MinerU 缓存可用。",
  "No MinerU cache available.": "没有可用的 MinerU 缓存。",
  "Click to do MinerU parsing": "点击进行 MinerU 解析",
  "MinerU parsing…": "MinerU 解析中…",
  "Click to stop MinerU parsing": "点击停止 MinerU 解析",
  "MinerU parsing failed. Click to retry": "MinerU 解析失败。点击重试",
  "⚠️ enable MinerU to start PDF parsing": "⚠️ 请启用 MinerU 以开始 PDF 解析",
  "Enable MinerU sync before preparing packages.":
    "请先启用 MinerU 同步，再准备同步包。",
  "An API key is required.": "需要 API 密钥。",
  "Paste it below to connect directly to MinerU cloud parsing.":
    "请粘贴到下方，以直连 MinerU 云端解析。",
  "Get your own free API key from": "请从以下网站获取你自己的免费 API 密钥：",
  "Get a free key from": "请从以下网站获取免费 API 密钥：",
  "and paste it below.": "并粘贴到下方。",
  "MinerU parsing mode": "MinerU 解析模式",
  Cloud: "云端",
  "API Key (Required)": "API 密钥（必填）",
  "Paste your free MinerU API key": "粘贴你的免费 MinerU API 密钥",
  "Connects directly to mineru.net.": "直连 mineru.net。",
  "Parsing model": "解析模型",
  "vlm uses a vision-language model — generally better at chapter structure, figures, and formulas; may be slower than pipeline.":
    "vlm 使用视觉语言模型，通常更擅长章节结构、图片和公式；可能比 pipeline 更慢。",
  "MinerU API key required. Add it in Settings.":
    "需要 MinerU API 密钥。请在设置中添加。",
  "Enter your MinerU API key first": "请先输入 MinerU API 密钥",
  "Use local MinerU server": "使用本地 MinerU 服务",
  "Local API Base URL": "本地 API URL",
  "Uses a self-hosted mineru-api server. Test Connection only checks that the server process is reachable.":
    "使用本地 mineru-api 服务。测试连接仅检查服务进程是否可访问。",
  Backend: "后端模型",
  "Switching backend triggers a cold start: the first parse afterwards may take noticeably longer while the model loads.":
    "切换后端模型会触发冷启动：模型加载后，首次解析可能会明显更慢。",
  "Note: Pause stops the queue, but an already-running local parse keeps executing on the mineru-api server — it has no cancel endpoint. To abort immediately (e.g. to switch backend right away), restart your mineru-api process manually.":
    "注意：暂停只会停止队列，但已经在 mineru-api 服务端运行的本地解析仍会继续执行，因为它没有取消接口。若要立刻中止（例如马上切换后端模型），请手动重启 mineru-api 进程。",
  "Downloading results…": "正在下载结果…",
  "Extracting files…": "正在提取文件…",
  "Reading PDF file…": "正在读取 PDF 文件…",
  "PDF file is empty or unreadable": "PDF 文件为空或无法读取",
  "Requesting upload URL… (%s MB)": "正在请求上传 URL…（%s MB）",
  "Batch request failed: HTTP %s": "批处理请求失败：HTTP %s",
  "Missing batch_id or file_urls in response":
    "响应中缺少 batch_id 或 file_urls",
  "Uploading PDF…": "正在上传 PDF…",
  "Uploading to local server… (%s MB)": "正在上传到本地服务…（%s MB）",
  "Upload failed: HTTP %s to %s": "上传失败：HTTP %s 到 %s",
  "Waiting for MinerU to start…": "正在等待 MinerU 开始处理…",
  "Waiting for MinerU to start… (%ss)": "正在等待 MinerU 开始处理…（%s 秒）",
  "Waiting for MinerU upload to be accepted… (%ss)":
    "正在等待 MinerU 接收上传文件…（%s 秒）",
  "Waiting for MinerU status… (%ss)": "正在等待 MinerU 状态…（%s 秒）",
  "Processing on server…": "服务器正在处理…",
  "Processing on server… (%ss)": "服务器正在处理…（%s 秒）",
  "Converting on server… (%ss)": "服务器正在转换…（%s 秒）",
  "Waiting for parser… (%ss)": "等待解析器处理…（%s 秒）",
  "Waiting for another local MinerU parse to finish…":
    "正在等待另一个本地 MinerU 解析任务完成…",
  "Local MinerU server is busy; retrying in %ss":
    "本地 MinerU 服务正忙，将在 %s 秒后重试",
  "Local MinerU server is still busy after %s retries":
    "本地 MinerU 服务在 %s 次重试后仍然繁忙",
  "Local MinerU parsing timed out": "本地 MinerU 解析超时",
  "Local parse failed: HTTP %s": "本地解析失败：HTTP %s",
  "Done (%s files extracted)": "完成（已提取 %s 个文件）",
  "Extraction failed on server": "服务器解析失败",
  "Missing ZIP result from server": "服务器未返回 ZIP 结果",
  "Timed out waiting for MinerU status": "等待 MinerU 状态超时",
  "Timed out before MinerU started processing": "MinerU 开始处理前等待超时",
  "Local MinerU health check timed out": "本地 MinerU 健康检查超时",
  "Local MinerU health check failed: HTTP %s":
    "本地 MinerU 健康检查失败：HTTP %s",
  "Test Connection": "测试连接",
  "Enter an API key first": "请先输入 API 密钥",
  "Testing…": "测试中…",
  "✓ Connection successful": "✓ 连接成功",
  // Obsidian integration
  "Obsidian Integration": "Obsidian 集成",
  "Write notes from your Zotero papers directly to your Obsidian vault. Configure the vault path and default folder below.":
    "将 Zotero 论文笔记直接写入 Obsidian 知识库。在下方配置知识库路径和默认文件夹。",
  "Vault Path": "知识库路径",
  "Absolute path to your Obsidian vault folder":
    "Obsidian 知识库文件夹的绝对路径",
  "Default Folder": "默认文件夹",
  "Default subfolder for notes (the agent can write to any folder if you specify)":
    "笔记的默认子文件夹（你可以指定其他文件夹，Agent 会写入你指定的位置）",
  "Note Template": "笔记模板",
  "Customize the template used when writing notes to Obsidian. Use {{title}}, {{date}}, {{content}} as placeholders.":
    "自定义写入 Obsidian 时使用的笔记模板。使用 {{title}}、{{date}}、{{content}} 作为占位符。",
  "Reset to Default": "恢复默认",
  "Attachments Folder": "附件文件夹",
  "Subfolder for copied figures and images (e.g., assets, attachments)":
    "用于存放复制的图片和附件的子文件夹（如 assets、attachments）",
  "Test Write Access": "测试写入权限",
  "Write access verified": "✓ 写入权限已验证",
  "Enter a vault path first": "请先输入知识库路径",
  "Each provider has an auth mode, API URL, and one or more model variants.":
    "每个服务商有一个认证模式、API URL 和一个或多个模型变体。",
  "Choose a preset above, or switch to Customized to enter a full base URL or endpoint manually.":
    '选择上方的预设，或切换到"自定义"以手动输入完整的基础 URL 或端点。',
  "codex auth usually uses https://chatgpt.com/backend-api/codex/responses":
    "codex 认证通常使用 https://chatgpt.com/backend-api/codex/responses",
  "Legacy direct ChatGPT/Codex backend mode. Existing users can keep using it in this release. New users should use Codex App Server. Planned for deprecation in a future release after app-server validation.":
    "旧版的 ChatGPT/Codex 直连后端模式。当前用户在此版本中可以继续使用，但新用户应改用 Codex App Server。待 app-server 验证稳定后，会在未来版本中计划弃用。",
  "Recommended official Codex integration. Runs the local `codex app-server` CLI as the native Codex runtime. Run `codex login` first.":
    "推荐的官方 Codex 集成方式。它会将本地 `codex app-server` CLI 作为原生 Codex 运行时。请先运行 `codex login`。",
  "Codex App Server (native runtime settings)":
    "Codex App Server（原生运行时设置）",
  "Legacy direct backend URL. Usually uses https://chatgpt.com/backend-api/codex/responses. Existing users can keep it in this release, but new users should use Codex App Server. Planned for deprecation in a future release after app-server validation.":
    "旧版直连后端 URL，通常使用 https://chatgpt.com/backend-api/codex/responses。当前用户在此版本中可以继续使用，但新用户应改用 Codex App Server。待 app-server 验证稳定后，会在未来版本中计划弃用。",
  "Uses Codex responses with the local codex app-server transport.":
    "通过本地 codex app-server 传输使用 Codex responses。",
  "Uses Codex responses with the legacy direct backend transport.":
    "通过旧版直连后端传输使用 Codex responses。",
  "Switch Provider to Customized to edit this URL manually.":
    '将服务商切换到"自定义"以手动编辑此 URL。',
  "Switch to Customized to edit the URL manually.":
    '切换到"自定义"以手动编辑 URL。',
  Provider: "服务商",
  Customized: "自定义",
  Protocol: "协议",
  "API protocol override": "API 协议覆盖",
  "API URL": "API URL",
  "API Key": "API 密钥",
  "codex auth": "codex 认证",
  "Codex Auth": "Codex 认证",
  "Codex Auth (Legacy)": "Codex 认证（旧版）",
  "Codex App Server": "Codex App Server",
  "Transport is handled by the codex subprocess; no API URL is needed.":
    "传输由 codex 子进程处理，不需要 API URL。",
  "Auth Mode": "认证模式",
  "Model names": "模型名称",
  "Add model": "添加模型",
  "Fill in the current model name first": "请先填写当前模型名称",
  Test: "测试",
  "Advanced options": "高级选项",
  "Remove model": "移除模型",
  "Remove provider": "移除服务商",
  Temperature: "温度",
  "Max tokens": "最大 Token 数",
  "Input cap": "输入上限",
  "Input mode": "输入模式",
  "Text only": "仅文本",
  "Vision allowed": "允许视觉",
  "Temperature: randomness (0–2)  ·  Max tokens: output limit  ·  Input cap: context limit (optional)":
    "温度：随机性 (0–2)  ·  最大 Token 数：输出限制  ·  输入上限：上下文限制（可选）",
  "Temperature: randomness (0–2)  ·  Max tokens: output limit  ·  Input cap: context limit  ·  Input mode: auto/text-only/vision":
    "温度：随机性 (0–2)  ·  最大 Token 数：输出限制  ·  输入上限：上下文限制  ·  输入模式：自动/仅文本/视觉",
  "Complete the empty provider first": "请先完善空白的服务商",
  "Add provider": "添加服务商",
  "+ Add Provider": "+ 添加服务商",
  "API URL is required": "API URL 为必填项",
  "API Key is required": "API 密钥为必填项",
  "codex token missing. Run `codex login` first.":
    "codex 令牌缺失。请先运行 `codex login`。",
  "Agent capability: ": "Agent 能力: ",
  "✓ Success — model says: ": "✓ 成功 — 模型回复: ",
  "codex auth reuses local `codex login` credentials from ~/.codex/auth.json":
    "codex 认证复用本地 `codex login` 凭据（~/.codex/auth.json）",
  "GitHub Copilot": "GitHub Copilot",
  "Login with GitHub Copilot": "使用 GitHub Copilot 登录",
  "Re-login": "重新登录",
  "Logged in to GitHub Copilot": "已登录 GitHub Copilot",
  "Log out": "登出",
  "Requesting device code…": "正在请求设备码…",
  "Enter this code on GitHub:": "在 GitHub 上输入此代码：",
  "Login successful!": "登录成功！",
  "Copilot token missing. Click Login first.":
    "Copilot 令牌缺失。请先点击登录。",
  "GitHub Copilot uses device-based login. Click Login to authenticate via GitHub.":
    "GitHub Copilot 使用设备认证。点击登录按钮通过 GitHub 进行认证。",
  "Fetch available models": "获取可用模型",
  "Fetching models…": "正在获取模型…",
  "No models found": "未找到模型",
  "Synced %n models": "已同步 %n 个模型",
  "Fetch Models": "获取模型",
  WebChat: "WebChat",
  "Provider A": "服务商 A",
  "Provider B": "服务商 B",
  "Provider C": "服务商 C",
  "Provider D": "服务商 D",
  "Preset uses OpenAI's official Responses endpoint.":
    "预设使用 OpenAI 官方 Responses 端点。",
  "Preset uses Gemini's native generateContent endpoint.":
    "预设使用 Gemini 原生 generateContent 端点。",
  "Preset uses Anthropic's native Messages API.":
    "预设使用 Anthropic 原生 Messages API。",
  "Preset uses MiniMax's recommended Anthropic-compatible endpoint.":
    "预设使用 MiniMax 推荐的 Anthropic 兼容端点。",
  "Preset uses GLM's Claude-compatible endpoint for agent tool use.":
    "预设使用 GLM 面向 Agent 工具调用的 Claude 兼容端点。",
  "Preset uses DeepSeek's Anthropic-compatible endpoint for reliable agent tool use.":
    "预设使用 DeepSeek 面向稳定 Agent 工具调用的 Anthropic 兼容端点。",
  "Preset uses xAI's official Responses endpoint.":
    "预设使用 xAI 官方 Responses 端点。",
  "Preset uses DashScope's compatible-mode API base (v1).":
    "预设使用 DashScope 兼容模式 API 地址 (v1)。",
  "Preset uses Moonshot's international API. Use api.moonshot.cn for China.":
    "预设使用 Moonshot 国际版 API。中国大陆可使用 api.moonshot.cn。",
  "Uses GitHub Copilot via device login. Requires an active Copilot subscription.":
    "通过设备登录使用 GitHub Copilot。需要有效的 Copilot 订阅。",
  'Relay questions to %targets% via the Sync for Zotero browser extension. Download extension: github.com/yilewang/sync-for-zotero → Releases. Unzip, open chrome://extensions, enable Developer Mode, click "Load unpacked", select the extension folder. Keep the corresponding chat tab open while using WebChat mode.':
    "通过 Sync for Zotero 浏览器扩展将问题转发到 %targets%。下载扩展：github.com/yilewang/sync-for-zotero → Releases。解压后打开 chrome://extensions，启用开发者模式，点击“加载已解压的扩展程序”，选择扩展文件夹。使用 WebChat 模式时保持对应聊天标签页打开。",

  // Static preference controls
  "Plugin Font Size": "插件字体大小",
  Reset: "重置",
  "Adjusts text size in the chat panel and standalone window. You can also use Cmd/Ctrl + and Cmd/Ctrl − while a panel is focused (Cmd/Ctrl 0 to reset).":
    "调整聊天面板和独立窗口中的文字大小。面板聚焦时，也可以使用 Cmd/Ctrl + 和 Cmd/Ctrl −（Cmd/Ctrl 0 重置）。",
  "Semantic Search": "语义搜索",
  "Uses vector embeddings for meaning-aware search. When disabled, only keyword matching (BM25) is used.":
    "使用向量嵌入进行语义搜索。禁用后仅使用关键词匹配（BM25）。",
  English: "英语",
  "中文 (简体)": "中文（简体）",
  Off: "关",
  On: "开",
  "Runtime defaults": "运行时默认值",
  Model: "模型",
  Auto: "自动",
  Low: "低",
  Medium: "中",
  High: "高",
  XHigh: "超高",
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
  optional: "可选",
  Close: "关闭",
  "Copy code & open GitHub": "复制代码并打开 GitHub",
  "Waiting for authorization…": "正在等待授权…",
  "Test failed: ": "测试失败：",

  // Codex App Server preferences
  "First-class Codex runtime integration. Run":
    "原生 Codex 运行时集成。启用前请先运行",
  "before enabling it; Zotero keeps local tool approvals in its own confirmation cards.":
    "；Zotero 会在自己的确认卡片中管理本地工具授权。",
  "Enable Codex App Server integration": "启用 Codex App Server 集成",
  "When enabled, Zotero shows the Codex button in the chat header so you can switch between upstream chat and Codex.":
    "启用后，Zotero 会在聊天标题栏显示 Codex 按钮，用于在上游聊天和 Codex 之间切换。",
  "These values control how Codex runs inside Zotero by default.":
    "这些值控制 Codex 在 Zotero 中运行时的默认行为。",
  "Enter a Codex app-server model ID, for example":
    "输入 Codex app-server 模型 ID，例如",
  ". Use the model name accepted by your installed Codex CLI.":
    "。请使用已安装的 Codex CLI 接受的模型名称。",
  "Codex CLI Path": "Codex CLI 路径",
  "Codex CLI Path (optional)": "Codex CLI 路径（可选）",
  "Optional absolute path to codex executable":
    "Codex 可执行文件的可选绝对路径",
  "Optional. Leave blank to auto-detect native Windows Codex. WSL Codex is not supported because Zotero MCP uses Windows-local loopback. Or enter a native path such as C:\\nvm4w\\nodejs\\codex.cmd or C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex.cmd.":
    "可选。留空会自动检测原生 Windows Codex。由于 Zotero MCP 使用 Windows 本地回环地址，不支持 WSL Codex。也可以输入原生路径，例如 C:\\nvm4w\\nodejs\\codex.cmd 或 C:\\Users\\<user>\\AppData\\Roaming\\npm\\codex.cmd。",
  "Optional. Leave blank to auto-detect. Or enter an absolute path such as /opt/homebrew/bin/codex or /usr/local/bin/codex.":
    "可选。留空会自动检测。也可以输入绝对路径，例如 /opt/homebrew/bin/codex 或 /usr/local/bin/codex。",
  "Optional. Leave blank to auto-detect. Or enter an absolute path such as /usr/local/bin/codex or ~/.local/bin/codex.":
    "可选。留空会自动检测。也可以输入绝对路径，例如 /usr/local/bin/codex 或 ~/.local/bin/codex。",
  "Test connection": "测试连接",
  "Zotero MCP tools": "Zotero MCP 工具",
  "Lets native Codex and Claude Code use a curated local MCP server for Zotero library/PDF reading and guarded Zotero operations. Write and destructive tools still use Zotero confirmation or tool-specific safety checks.":
    "允许原生 Codex 和 Claude Code 使用精选的本地 MCP 服务读取 Zotero 文献库/PDF，并执行受保护的 Zotero 操作。写入和破坏性工具仍会使用 Zotero 确认或工具专属安全检查。",
  "Enable Zotero MCP tools for native Codex and Claude Code turns":
    "为原生 Codex 和 Claude Code 回合启用 Zotero MCP 工具",
  "Install/update Zotero MCP config": "安装/更新 Zotero MCP 配置",
  "For Codex, Zotero writes a local bearer-token protected MCP entry into Codex config and asks app-server to reload MCP servers. Claude Code receives a scoped MCP server directly for each turn. User-level Codex skills, plugins, and other MCP setup remain owned by Codex.":
    "对于 Codex，Zotero 会把受本地 bearer token 保护的 MCP 条目写入 Codex 配置，并请求 app-server 重新加载 MCP 服务。Claude Code 会在每个回合直接收到带作用域的 MCP 服务。用户级 Codex skills、插件和其他 MCP 设置仍由 Codex 管理。",
  "Zotero MCP tools enabled for native Codex and Claude Code turns.":
    "已为原生 Codex 和 Claude Code 回合启用 Zotero MCP 工具。",
  "Zotero MCP tools disabled for native Codex and Claude Code turns.":
    "已禁用原生 Codex 和 Claude Code 回合中的 Zotero MCP 工具。",
  "Configuring Zotero MCP tools…": "正在配置 Zotero MCP 工具…",
  "Zotero MCP connected with %n tools.": "Zotero MCP 已连接 %n 个工具。",
  "Zotero MCP config written. Codex is reloading tools.":
    "Zotero MCP 配置已写入。Codex 正在重新加载工具。",
  "Zotero MCP setup failed: ": "Zotero MCP 设置失败：",
  "Checking Zotero MCP setup…": "正在检查 Zotero MCP 设置…",
  "Zotero MCP configured. Use setup if tools do not appear.":
    "Zotero MCP 已配置。如果工具未出现，请使用设置按钮。",
  "Zotero MCP tools enabled but not configured yet.":
    "Zotero MCP 工具已启用，但尚未配置。",
  "Could not read Codex MCP status: ": "无法读取 Codex MCP 状态：",
  "Native Codex approvals": "原生 Codex 授权",
  "Lets Zotero surface native Codex command, file-change, and permission approval requests as per-request review cards. This does not grant shell or filesystem access by default.":
    "允许 Zotero 将原生 Codex 的命令、文件变更和权限请求显示为逐次审核卡片。默认不会授予 shell 或文件系统访问权限。",
  "Enable native Codex approval review cards": "启用原生 Codex 授权审核卡片",
  Reviewer: "审核者",
  "Auto review": "自动审核",
  "User review shows every native request that reaches Zotero. Auto review only changes Codex app-server's reviewer parameter; Zotero MCP trust rules and confirmation behavior stay unchanged.":
    "用户审核会显示所有到达 Zotero 的原生请求。自动审核只会更改 Codex app-server 的审核者参数；Zotero MCP 信任规则和确认行为保持不变。",
  "Native Codex approval bridge enabled.": "原生 Codex 授权桥接已启用。",
  "Native Codex approval bridge disabled.": "原生 Codex 授权桥接已禁用。",
  "Codex may auto-review eligible native requests; Zotero still shows requests that reach the plugin.":
    "Codex 可以自动审核符合条件的原生请求；到达插件的请求仍会由 Zotero 显示。",
  "Zotero will show native Codex approval requests.":
    "Zotero 将显示原生 Codex 授权请求。",

  // Claude Code preferences
  "Claude Code Integration": "Claude Code 集成",
  "This panel configures the embedded Claude runtime. You enter Claude Code mode from the chat header, not from settings.":
    "此面板用于配置嵌入式 Claude 运行时。请从聊天标题栏进入 Claude Code 模式，而不是从设置页进入。",
  "Enable Claude Code integration": "启用 Claude Code 集成",
  "When enabled, Zotero shows the Claude button in the chat header so you can switch between upstream chat and Claude Code.":
    "启用后，Zotero 会在聊天标题栏显示 Claude 按钮，用于在上游聊天和 Claude Code 之间切换。",
  "Disable Codex App Server first to switch on Claude Code.":
    "请先禁用 Codex App Server，再开启 Claude Code。",
  "Disable Claude Code first to switch on Codex App Server.":
    "请先禁用 Claude Code，再开启 Codex App Server。",
  Connection: "连接",
  "Zotero sends Claude requests to this local bridge service.":
    "Zotero 会将 Claude 请求发送到这个本地桥接服务。",
  "Bridge URL": "桥接 URL",
  "Config source": "配置来源",
  "Choose where Claude should load its settings from. Most users should keep":
    "选择 Claude 从哪里加载设置。大多数用户应保留",
  "Claude Config Source": "Claude 配置来源",
  "default — user + project + local": "default — 用户 + 项目 + 本地",
  "user-only — only your global Claude config":
    "user-only — 仅全局 Claude 配置",
  "zotero-only — only Zotero-managed configs":
    "zotero-only — 仅 Zotero 管理的配置",
  "Show config locations and advanced details": "显示配置位置和高级详情",
  "loads user + project + local. Priority: local > project > user.":
    "加载用户 + 项目 + 本地配置。优先级：本地 > 项目 > 用户。",
  "loads only your machine-wide Claude settings.":
    "仅加载此电脑上的全局 Claude 设置。",
  "loads only Zotero-managed shared and per-conversation settings.":
    "仅加载 Zotero 管理的共享设置和单个对话设置。",
  User: "用户",
  Project: "项目",
  Local: "本地",
  "Global defaults shared across Claude Code on this machine.":
    "此电脑上 Claude Code 共享的全局默认设置。",
  "Shared settings for all Claude runtimes launched by Zotero.":
    "Zotero 启动的所有 Claude 运行时共享的设置。",
  "Each conversation stores its own override folder under the scopes tree.":
    "每个对话都会在 scopes 树下保存自己的覆盖设置文件夹。",
  "Open folder": "打开文件夹",
  "Trace logs": "跟踪日志",
  "Save Claude runtime traces for debugging and copy the log directory path.":
    "保存 Claude 运行时跟踪日志用于调试，并复制日志目录路径。",
  Enabled: "启用",
  "Copy path": "复制路径",
  "Claude Code settings guide": "Claude Code 设置指南",
  "These values control how Claude runs inside Zotero by default.":
    "这些值控制 Claude 在 Zotero 中运行时的默认行为。",
  "Permission Mode": "权限模式",
  "is recommended.": "为推荐设置。",
  "removes confirmation prompts.": "会移除确认提示。",
  "Default Model": "默认模型",
  "This sets the default capability tier for new Claude conversations.":
    "此项设置新 Claude 对话默认使用的能力档位。",
  ", and": "和",
  ", or": "或",
  "are strength tiers, so the runtime may map them to different underlying models.":
    "是能力档位，因此运行时可能会将它们映射到不同的底层模型。",
  "Default Reasoning": "默认推理",
  "The reasoning effort Claude uses by default for new runs.":
    "Claude 新运行默认使用的推理强度。",
  "Enable block streaming": "启用分块流式输出",
  "Show Claude answers chunk by chunk while they stream, instead of waiting until the final answer is assembled.":
    "流式输出时逐块显示 Claude 回答，而不是等最终回答组装完成后再显示。",
  "Enable auto-compact": "启用自动压缩",
  "Automatically send": "自动发送",
  "before a new Claude turn when context usage crosses the threshold below.":
    "当上下文用量超过下方阈值时，再开始新的 Claude 回合。",
  "Advanced: Runtime CLAUDE.md instructions": "高级：运行时 CLAUDE.md 指令",
  "This controls the text injected between":
    "此处控制注入到以下两段标记之间的文本：",
  and: "和",
  "inside the runtime": "它位于运行时",
  ". Existing files are preserved. Clicking Update only refreshes that managed block.":
    "中。已有文件会保留。点击更新只会刷新该托管块。",
  "If you are not already comfortable editing Claude Code project instructions, leave this unchanged.":
    "如果你还不熟悉编辑 Claude Code 项目指令，请保持此项不变。",
  "Update runtime CLAUDE.md": "更新运行时 CLAUDE.md",
  "Reset to default": "恢复默认",
  "Template updated locally": "模板已在本地更新",
  "Reset to default template": "已重置为默认模板",
  "Updating CLAUDE.md…": "正在更新 CLAUDE.md…",
  "Managed block updated": "托管块已更新",
  "Failed to update CLAUDE.md": "更新 CLAUDE.md 失败",

  // Notes and embedding preferences
  "Notes Directory": "笔记目录",
  "Configure a local directory for saving notes as files. Note format and templates are managed through skills — type":
    "配置用于将笔记保存为文件的本地目录。笔记格式和模板由 skills 管理 — 在聊天中输入",
  "in chat to see available skills, or edit skill files directly.":
    "查看可用 skills，或直接编辑 skill 文件。",
  Nickname: "昵称",
  "e.g., Obsidian, Logseq, My Notes": "例如 Obsidian、Logseq、我的笔记",
  "How you refer to this directory — the agent will recognize it when you mention it":
    "你如何称呼这个目录 — 当你提到它时，Agent 会识别。",
  "Notes Directory Path": "笔记目录路径",
  "Absolute path to the directory where notes are saved as files":
    "用于将笔记保存为文件的目录绝对路径",
  "Folder for images, relative to vault root (e.g., assets, Notes/imgs)":
    "图片文件夹，相对于知识库根目录（例如 assets、Notes/imgs）",
  "Enter a directory path first": "请先输入目录路径",
  "Embedding Provider": "嵌入模型服务商",
  "Using API key from your %provider% provider":
    "使用 %provider% 服务商的 API 密钥",
  "API key configured": "API 密钥已配置",
  "No %provider% provider found. Enter an API key for embeddings.":
    "未找到 %provider% 服务商。请输入用于嵌入模型的 API 密钥。",
  "Estimated cost": "预估费用",

  // MinerU preference filters
  "Sync existing MinerU caches now": "立即同步已有 MinerU 缓存",
  "Advanced parsing filters": "高级解析过滤器",
  "Skip files over": "跳过超过",
  pages: "页",
  "Start All, Start Filtered, Start Selected, and auto-parse skip PDFs above this page count.":
    "全部开始、开始筛选项、开始所选和自动解析都会跳过超过该页数的 PDF。",
  "Exclude PDFs by Filename": "按文件名排除 PDF",
  "Comma-separated patterns. Matching filenames are skipped by your rule. Wrap in /slashes/ for regex.":
    "使用逗号分隔多个模式。匹配文件名会按规则跳过。用 /斜杠/ 包裹可表示正则表达式。",

  // ── Language setting ────────────────────────────────────────────────────
  Language: "语言",
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

/** Returns the WebChat start page HTML. */
export function getWebChatWelcomeHtml(
  targetLabel?: string,
  targetDomain?: string,
): string {
  const label = targetLabel || "WebChat";
  const domain = targetDomain || "the chat site";
  if (getEffectiveLocale().startsWith("zh")) {
    return `
      <div class="llm-start-page llm-webchat-start-page">
        <div class="llm-start-page-title">LLM-for-Zotero WebChat</div>
        <div class="llm-start-page-subtitle">通过已打开的 ${label} 浏览器标签页工作</div>
        <div class="llm-start-page-recommendations">
          <div class="llm-start-page-rec-title">工作方式</div>
          <ol class="llm-start-page-rec-list">
            <li>Zotero 会通过 Sync for Zotero 浏览器扩展，把你的问题发送到已经打开的 <strong>${domain}</strong> 标签页，然后把回答同步回这里。</li>
          </ol>
          <div class="llm-start-page-rec-title llm-webchat-warning-title">⚠️⚠️⚠️ 发送前必须确认</div>
          <ol class="llm-start-page-rec-list">
            <li>已经安装并启用 <strong>Sync for Zotero</strong> 浏览器扩展。</li>
            <li>已经在 Chrome 或 Edge 中打开 <strong>${domain}</strong>，并且已经登录。</li>
            <li>保持 <strong>${domain}</strong> 标签页可见；不要最小化，不要放到另一个显示器。Zotero 模型标签旁的绿点表示已连接。</li>
          </ol>
          <div class="llm-start-page-rec-title llm-webchat-rec-title-spaced">怎么提问</div>
          <ol class="llm-start-page-rec-list">
            <li>在这里输入问题并点击 <strong>Send</strong>。</li>
            <li>论文对话中，论文标签高亮表示会附加当前 PDF；右键论文标签可切换发送 PDF 或跳过 PDF。每个 WebChat 会话通常只上传一次 PDF。</li>
            <li>如果没有反应，请刷新 <strong>${domain}</strong> 标签页，确认扩展已启用，并让 Zotero 和浏览器保持在同一个显示器。</li>
          </ol>
        </div>
      </div>
    `;
  }
  return `
    <div class="llm-start-page llm-webchat-start-page">
      <div class="llm-start-page-title">LLM-for-Zotero WebChat</div>
      <div class="llm-start-page-subtitle">Use your open ${label} browser tab</div>
      <div class="llm-start-page-recommendations">
        <div class="llm-start-page-rec-title">How it works</div>
        <ol class="llm-start-page-rec-list">
          <li>Zotero sends your question to the already-open <strong>${domain}</strong> tab through the Sync for Zotero browser extension, then streams the answer back here.</li>
        </ol>
        <div class="llm-start-page-rec-title llm-webchat-warning-title">⚠️⚠️⚠️ Before sending</div>
        <ol class="llm-start-page-rec-list">
          <li>Install and enable the <strong>Sync for Zotero</strong> browser extension.</li>
          <li>Open <strong>${domain}</strong> in Chrome or Edge, and make sure you are signed in.</li>
          <li>Keep the <strong>${domain}</strong> tab visible; do not minimize it or put it on another monitor. A green dot in Zotero's model chip means connected.</li>
        </ol>
        <div class="llm-start-page-rec-title llm-webchat-rec-title-spaced">Ask from Zotero</div>
        <ol class="llm-start-page-rec-list">
          <li>Type your question here and press <strong>Send</strong>.</li>
          <li>For paper chat, a highlighted paper chip means the current PDF will be attached; right-click the chip to switch between send PDF and skip PDF. A PDF is uploaded only once per webchat session.</li>
          <li>If nothing happens, reload the <strong>${domain}</strong> tab, confirm the extension is enabled, and keep Zotero and the browser on the same monitor.</li>
        </ol>
      </div>
    </div>
  `;
}

export function getWelcomeHtml(): string {
  if (getEffectiveLocale().startsWith("zh")) {
    return `
      <div class="llm-welcome">
        <div class="llm-welcome-icon llm-context-svg-icon llm-context-icon-model-chip" aria-hidden="true"></div>
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
      <div class="llm-welcome-icon llm-context-svg-icon llm-context-icon-model-chip" aria-hidden="true"></div>
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
