# 04 · Provider 兼容性报告（src/main/providers.js）

> 方法：SSE 解析边界逐形态核对 + `node -e` 复制解析逻辑实测 + audit-providers 套件复验。架构澄清：apiFormat 仅 openai/anthropic 两种，Gemini 走官方 OpenAI 兼容层（无原生 candidates/parts 解析面）。

## 发现与处置（9 修 + 3 缓）

### C1 · OpenAI 流式分支吞掉错误帧 → "✓ 完成"的空回答 — P2 已证实 ✅已修复
- one-api/new-api 类网关把上游失败以 `data: {"error":{...}}` SSE 帧转发；或整流只有 [DONE]。原代码 `if (!ch) return` 直接吞掉，sawData=true 使空内容检查失效。
- 修复：① 流内遇 `j.error` 抛错；② `ch.delta || ch.message` 回退（个别网关整段发一个 message 帧）；③ 流结束时「有 data 帧但无任何正文」报「服务端未返回任何内容（可能被网关拦截或上游出错）」。
- 回归：audit-providers 用例 9/10/11。

### C2 · 「测试连接」对 kimi-k3 / gpt-5* 发送必 400 的 max_tokens — P2 已证实 ✅已修复
- chatOnce 盲设 `body.max_tokens = 100`（测试连接的模型不带 maxTokens，buildBody 不写 token 字段）。providers.js 自己注释了「传了会 400」。
- 修复：needsCompletionTokens 抽为共享函数，chatOnce 与 buildBody 同判定。回归：audit-providers 用例 15（kimi-k3/gpt-5.6/deepseek-flash 三形态）。

### C3 · 流式 usage 只认 prompt_tokens/completion_tokens — P3 ✅已修复
- Bedrock 兼容层等端点用 input_tokens/output_tokens 命名 → 徽标静默缺失。修复：`!= null` 回退链（与 extractFull 对齐）。回归：用例 13。

### C4 · Anthropic 缓存 token 不计入 → 输入用量低估 — P3 ✅已修复
- message_start 的 `cache_creation_input_tokens`/`cache_read_input_tokens` 未加（服务端自动缓存时 input_tokens 不含缓存段，实测 input=10 真实 160）。回归：用例 14。

### C6 · delta.content 为部件数组时输出 "[object Object]" — P3 ✅已修复
- 个别网关发数组形态；流式分支直接字符串拼接（非流式已有 textOf）。修复：`typeof === 'string' ? : textOf()`。回归：用例 12。

### C7 · Anthropic 529（官方过载码）不在映射且不重试 — P3 ✅已修复
- 修复：friendlyHttpError 加 529 文案 + chatOnce 重试白名单纳入。回归：用例 16（529 一次后 200 恢复，断言重试成功）。

### C8 · chatOnce 对 200+非 JSON 响应直接 res.json() — P3 ✅已修复
- 网关 HTML 错误页 → 英文 SyntaxError 漏到界面。修复：text()+try parse，失败报「响应不是有效 JSON（可能为网关错误页）」+ 前 100 字符。回归：用例 17。

### C9 · models:list 对 Gemini 兼容端点不剥 models/ 前缀 — P3 ✅已修复
- `models/gemini-xxx` 原样选中后 chat 请求 404。修复：仅 generativelanguage 域名剥前缀。回归：用例 18（stub fetch）。

### C10 · 10MB 回退缓冲截断后报错文案误导 — P3 ✅已修复
- 超限截断后落「未返回任何内容」。修复：rawTruncated 标记 → 报「服务端响应超过 10MB，已中止解析」。回归：用例 19。

### C5 · finish_reason 全程未读（content_filter/length 截断静默） — P3 ⏸未修复（进路线图）
- 拦截/截断与正常完成无差别显示 ✓。修复需卡片追加提示的 UI 管线，属功能增强。

### C11 · 原生搜索引用注回未解析（OpenRouter annotations/百炼 search_results）— P3 优化 ⏸未修复（进路线图）
- 来源展示走前端搜索注入，双通道不同源但不缺位。

### C12 · google 预置不在 STREAM_USAGE_PROVIDERS — P3 ⏸未修复（需真实 API 验证）
- 无法离线证实 Gemini 兼容层是否默认回 usage；误加 stream_options 可能 400，需在线确认后加白名单。

## 已验证无问题（摘要）
SSE 多形态（CRLF/[DONE] 变体/末尾无换行/注释行/跨块多字节）；choices 空数组+usage 尾块；reasoning_content 与 OpenRouter reasoning；usage null 无 NaN（Math.max 覆盖语义）；Anthropic 头/system 顶层/thinking 三通道/小数 max_tokens（ba84261 在位）；URL 拼接 15 变体；stream_options 白名单；原生搜索参数（:online 幂等/enable_search/web_search）；非流式回退双通道；readDetail 四形态；401/403/429/5xx 中文映射；120s/45s/20s 超时；AbortError→stopped 带 usage；usage 归一 {input,output} 契约 + 渲染层 NaN 安全。
