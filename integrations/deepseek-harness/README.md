# DeepSeek Harness for Zotero

DeepSeek Harness 在 Agent 设置中提供独立卡片，用于执行多步任务。Harness 负责模型循环与工具调度；Zotero 负责工具校验、Safe / Auto / Yolo 审批、变更凭据、历史记录和撤销。模型、API 地址和 API 密钥来自聊天面板中选中的服务商。

## 安装与启用

需要 Node.js `^22.19.0 || >=24.0.0`，以及支持工具调用的 OpenAI Chat Completions 兼容服务商。

在仓库根目录安装工作进程依赖：

```sh
npm ci --ignore-scripts --prefix integrations/deepseek-harness
```

安装构建生成的 XPI 后，进入 Zotero 设置 → LLM-for-Zotero → Agent → DeepSeek Harness：

1. 开启 **DeepSeek Harness** 卡片的开关。原生 Agent 和 Harness 共用聊天中的 Agent 按钮，开启其中一个会选中对应引擎。
2. “Node 可执行文件”填写 Node 的绝对路径，可通过 `node -p process.execPath` 查看。
3. “Harness 工作进程脚本”填写本目录 `worker.mjs` 的绝对路径。
4. 在聊天面板选择服务商及模型，开启 Agent 后发送任务。权限与网页搜索配置位于原生 Agent 卡片中。

工作进程目录应保留在稳定位置，并保留其 `node_modules`。更新时，安装同一构建中的 XPI 和工作进程依赖，然后重启 Zotero。执行引擎选择对 Original Agent 的侧栏、独立窗口和扩展 API 生效。默认使用内置执行引擎。

## 接入方式与研究依据

采用官方 `@deepseek-ai/dsh-agent-loop` 等内核包，以 **0.2.0-rc.2** 锁定版本及依赖。Zotero 的 Firefox 运行环境通过原有 Gecko Subprocess 能力启动 Node 工作进程，使用私有标准输入/输出管道交换请求、流事件与工具结果。

官方 TypeScript SDK 使用 Node 子进程；ACP 提供会话、取消和审批协议。此集成直接组合官方 Agent、Session、SystemPrompt、Tools、LLM 和 AgentLoop 服务，使现有 Zotero 工具注册表成为每次调用的执行入口，保留完整的原生工具目录和原生权限评估。

工作进程使用官方 JSONL 持久化后端。首次运行时导入 Zotero 的用户与助手历史。后续轮次使用 `agents.resume()` 恢复同一原生会话，包含工具结果、摘要、压缩记录和未结束轮次的恢复记录。每轮结束后仍回收工作进程。凭据通过进程管道传递，在工作进程内存中用于当前服务商认证。

当前支持文本上下文和 Zotero 工具读取论文。内联图片、原生文件上传及其他 API 协议会显示明确的兼容性提示。用户停止、会话清除及插件关闭均受执行期检查约束。

## 会话恢复与重试

会话保存在当前 Zotero 配置目录下的 `llm-for-zotero/harness/`。目录以会话身份、代次、服务商、模型和账户密钥的散列值隔离。密钥原文不写入绑定文件。目录权限为当前用户可访问。会话中包含论文内容、对话和工具结果，请按私人资料管理这些本地文件。

正常后续提问恢复原生上下文。中断后发送“继续”或重试相同输入，会恢复原会话及该任务的工具执行记录。已确认成功的相同调用可复用其结果。恢复期间发生新写入后，读取缓存失效。新任务可以主动重新读取或再次执行。用户问题被编辑、会话身份改变或代次改变时，使用独立会话。

工具调用发出前保存执行记录，收到宿主结果后保存确认结果。若进程在写入完成和结果确认之间退出，插件不能判定该操作是否成功。恢复时阻止自动写入；先读取目标核对状态，再以新指令安排后续写入。提问、审批和内部控制仍由 Zotero 管理。此机制不为任意外部命令承诺严格一次执行。

自动恢复有明确上限：

- 使用官方重试组件，对限流、临时服务器错误、网络中断、请求超时及空响应最多重试 3 次。采用带抖动的指数退避，初始间隔为 1 秒，间隔上限为 10 秒。只重试失败的模型请求。
- 认证、权限、配额和无效请求错误不自动重试。工具失败交给 Agent 判断，插件不自动重放工具。
- 每个模型步骤的等待预算为 10 分钟。工具执行、审批及用户回答期间暂停计时。工具结束或模型步骤完成后更新预算。
- 模型步骤超时后，取消该步骤、保存检查点并自动继续一次。再次超时则保存检查点并停止。用户取消会同时停止退避和自动续跑。

升级前的内存会话没有原生日志。其首次运行会导入现有文字历史；原生工具上下文从新版首次保存的会话开始保留。Zotero 对话清除会隔离后续运行；已落盘日志仍保存在上述私人目录，可在 Zotero 退出后手动删除。

## 自动压缩

工作进程加载官方 TokenMeter、ToolResultPruner 和 BasicCompaction 组件。上下文容量使用 Zotero 当前模型的解析结果；用户设置的输入容量优先。输出上限沿用本轮配置。

每个模型步骤开始前，Harness 检查历史、系统提示和工具定义的估算用量。接近容量的 80% 时触发压缩；输出预留和安全余量可以使压缩提前发生。工作进程先裁剪大型工具结果，再按需用当前服务商和模型生成摘要。摘要保留任务、约束和后续步骤，近期消息继续保留。压缩不会拆开工具调用与结果的配对。

服务商明确返回上下文超限时，Harness 尝试压缩并重试一次模型请求。该重试沿用已经完成的工具结果。压缩失败、取消或再次超限时，运行返回错误。认证错误不重试。临时服务错误按下方策略处理。

聊天中显示自动压缩标记。用量统计包含成功提交的摘要请求。压缩修改当前工作进程提供给模型的上下文，Zotero 中的完整对话记录继续保留。

摘要仍需模型处理。如果单条当前输入、系统提示或工具定义本身过大，或摘要请求也超过服务商上限，压缩无法保证继续运行。用户应将这类输入拆成较小任务，或用工具按需读取资料。

官方参考：

- [Harness 仓库与 MIT 许可证](https://github.com/deepseek-ai/deepseek-harness)
- [AgentLoop 服务](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop)
- [工具注册与执行管道](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/tools)
- [OpenAI 兼容模型适配器](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)
- [TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/client)
- [ACP 接口](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp)

## 验证

```sh
npm ci
npm run build
npm run test:harness
```

协议测试运行真实 Harness 循环和本地模拟模型，覆盖工具调用后的继续推理、角色历史、文本流、错误结果、取消、密钥脱敏、历史压缩、工具结果裁剪、超限重试、摘要失败和重复操作防护。

真实服务商测试通过独立的 Zotero 测试配置运行，并创建临时论文和笔记：

```sh
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/absolute/path/to/zotero \
LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=/absolute/path/to/prefs.js \
LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-flash \
npm run test:harness:live
```

测试从指定配置读取模型凭据，向该模型发起真实请求。覆盖论文搜索与摘要读取、Safe 模式拒绝写入、批准后笔记落库、历史信息回读、长历史压缩后继续读取文献和运行中停止。报告写入 `tmp/deepseek-harness-provider-b.json`，仅包含模型名称、场景和验证结果。另覆盖批准写入后中断、跨工作进程恢复、复用工具结果以及检查笔记数量。

故障注入测试通过本地代理转发到配置中的第二组服务商 `deepseek-flash`。在已完成读取和写入后，分别注入 429、503、模型步骤超时与中断。宿主工具使用临时文件；断言读取一次、写入一次，并校验最终答案中的已保存结果：

```sh
LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=/absolute/path/to/prefs.js \
npx tsx --require ./test/register.cjs scripts/test-harness-recovery-live.ts
```

该测试使用缩短的模型步骤预算验证超时路径，报告写入 `tmp/deepseek-harness-recovery-provider-b.json`。测试结束后删除临时文件和会话。
