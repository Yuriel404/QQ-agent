# 提示词拼接流水线（develop/ 全景记录）

> 记录于 2026-09-17，基于当时代码。改动前先核对行号/函数名是否仍对得上。

以下按入站消息到模型请求的顺序说明。

## 第 0 步：唤醒判定（决定"要不要发、带多少历史"）

`src/orchestrator.js` `wake()` → `resolveContextTier()`（prompt.js:429）。

- 私聊恒为 4 档全响应。
- 群聊 1~3 档看：是否被 @（isAtMe）、命中关键词（hitKeyword）、掷中随机概率（roll 与预判共用骰子）。
- 判定结果 `contextLimit` 决定本轮读取的已读历史条数。
- 未命中 → 标已读、不发提示词（不产生会话、不耗 token）。

## 第 1 步：采集原料（#runAgent 前半，orchestrator.js:597）

- 群名、自己群名片（selfNickname）、最近 10 分钟消息数、自己上次发言时间、最后一条消息时间
- 表情库快照 `stickerEntries`（`stickers.sync()`）
- `skillContext`：chatKey、当前模型/渠道、visionEnabled（图片输入勾选 + 模型探测结果）、searchEnabled、是否主动机会、sessionId

## 第 2 步：before-context 钩子（orchestrator.js:648）

Skill 在提示词组装前跑一次 `before-context`。
目前只有 conversation-memory 用它暂存"本轮触发内容"（triggerEntries），供第 6 步注入用。
钩子 5 秒超时，只能追加/加工上下文，不能碰核心提示词。

## 第 3 步：系统提示的组装

`buildSystemPrompt()` 在 `src/prompt.js` 中组装 QQ 工具调用协议、安全规则、引用与点名、记忆和表情工具的使用说明，并按视觉和搜索能力添加相应说明。已启用 Skill 可以通过清单中的 `prompt.sections` 或入口的 `promptSections(context)` 添加使用说明。群聊和私聊都走同一个构建函数。

这个函数也会读取管理员在 Web UI 保存的自定义人设。它先按完整的 `group:<群号>` 或 `private:<QQ号>` 查找当前会话的专属人设，找不到则使用全局人设。两者都为空时省略人设段落。预览和实际模型请求采用相同的选择规则。

## 第 4 步：buildUserPrompt —— 用户消息（prompt.js:545）

段落顺序按**变化频率**排（稳定在前、易变殿后）——前缀缓存命中优化：

| # | 段落 | 内容 | 变化频率 |
|---|------|------|---------|
| 1 | 【可用表情包】 | 当前可用的收藏表情，按配置决定是否附加 | 半稳定 |
| 2 | 【引导说明】 | 输入段落与工具的使用方式 | 固定 |
| 3 | 【记忆】 | 本轮相关成员的长期印象 | 随成员和记忆变化 |
| 4 | 【已读信息】 | 当前会话的近期历史；复用前缀时另附新已读信息、相关新成员印象 | 滚动 |
| 5 | 【未读信息】 | 本轮触发消息及 @、引用等标记 | 每轮变化 |
| 6 | 【当前时间】 | 本轮的时间 | 每轮变化 |

构建完把 `pastStateCount` 写回 session，供 get_recent_messages 翻页跳过已看过的消息。

## 第 5 步：主动机会追加（orchestrator.js:732）

proactive 运行在 user 消息末尾追加「（主动机会）群里已有一段时间没有新消息。可以发起新话题，也可以直接结束。」。
主动机会无触发批，tier 固定 4 档（allCount 全量历史）。

## 第 6 步：before-llm-messages 钩子（orchestrator.js:740，原地改 messages）

唯一能改"已拼好 messages"的扩展点：

- **conversation-memory**：`appendToSystem` 把跨轮记忆**追加到既有 system 消息 content 尾部**（修改既有消息）
- **knowledge-memes**：知识库联想命中时 **push 一条新 system 消息**【脑内闪过】

组装结果同时写入 `session.systemPrompt / userPrompt / inputMessages`（UI 与调试可见）。

## 第 7 步：多轮循环，messages 持续增长（orchestrator.js:800+）

每轮**完整 messages 重发**（前缀缓存靠前面字节稳定），循环中追加/修改：

- assistant 回复 push 进 messages
- 模型把工具调用写在正文里（inline tool calls）：**改写**最后一条 assistant 消息（content 置 null、塞 tool_calls）
- 工具结果：文本进 tool 消息；**图片/视频不能塞 tool 消息**（很多端点拒收），改为一条 user 消息补发 `[系统：以下是工具 X 返回的 N 张图片，请直接"看"了回应]` + image_url/video_url 部件
- 最后 3 轮还没发过言：push 一条 user 消息【系统提醒】催它 send_message
- 会话级中止（AbortController）在轮边界与退避期检查，立即收尾

## 第 8 步：llm.js 发送前（内容不再变，但换模型/改请求体）

- `specializedModelFor`：扫到 video_url 部件 → 换视频专用模型（videoModel）；有 image_url → 换图片专用模型（visionModel）。仅主调用路径，记忆整理/备选降级不受影响
- `llm.request-params` 转换器（thinking-adapters 等）：往请求体加思考参数、删互斥 temperature（改 body 不改 messages）
- 网关拒收图片格式（image-compat 插件 isImageRejection）：降级重发**摘掉 image_url 部件**换成文字说明——发送路径上最后一次内容修改

## 分工总览

- **prompt.js 独占核心提示词**：安全规则、工具协议；插件 priority 封顶 99，永远排在核心规则之后
- **orchestrator 决定何时组装、带哪些数据**：档位、主动机会、多轮消息管理
- **插件三个介入口**：promptSections 追加段落、before-context 采集、before-llm-messages 原地加工
- **llm.js 管发送层**：专用模型切换、请求体转换、格式降级，不动 messages 内容（image-compat 降级除外）

## 附：UI 提示词预览（2026-09-17 补）

控制台两处"完整提示词预览"（设置-工具与技能页右侧、技能页右侧，均为 module-split 页面级分栏的右半边）
**与运行时同源**：`GET /api/prompt-preview`（routes.js）用与 orchestrator 同构的 skillContext
调 `buildSystemPrompt()` + `getToolAvailability()`，按**当前**插件/技能/工具启停状态实时组装——
没开的插件段/技能段/工具不出现。前端 `ui/app.js` 的 `renderPromptPreviewText()` 只做展示
（系统提示 + 可用工具清单），不再自拼模板（旧版前端复制静态模板，永远是"全启用"的样子）。
开关变动后由 `refreshPromptPreview()` 重拉并原地替换两处 `<pre>` 的文本。
