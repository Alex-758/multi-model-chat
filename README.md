# Jury

同时调用多个大模型、并行对比回答、互审仲裁、一键合并综合的本地桌面应用（Electron）。

![平台](https://img.shields.io/badge/platform-Windows-blue)

![框架](https://img.shields.io/badge/framework-Electron%2044-47848f)

![版本](https://img.shields.io/badge/version-1.5.0-green)

## 功能特性

- **多模型并行对话**：一次提问，同时调用多个模型（可单选/多选），每个模型独立卡片流式输出
- **图片输入**：Ctrl+V 粘贴、拖入或点输入框左侧「+」选择图片提问；多模态模型看原图，纯文本模型自动改用 Windows 系统 OCR 提取的图中文字（都无文字则跳过该模型）；图片只在当轮发送，后续轮次自动转为文字占位，避免重复计费
- **文档附件**：拖入或「+」选择 txt / md / 代码 / PDF / Word / Excel / PPT 等文件，自动提取全文进入对话上下文；PDF/Word 用进程内 JS 库解析（快），Excel/PPT/RTF/EPUB 用随应用内置的 markitdown 转换器（无需本机安装 Python，老式 .doc/.xls 请先另存为新格式）
- **系统提示词**：全局设定模型角色与回答风格，也可为单个会话单独覆盖（会话设置优先）
- **token 用量与花费估算**：每张回答卡片显示本轮消耗与 ≈¥ 花费（官方美元单价 × 设置里的汇率，汇率可调）、每轮显示合计、每个会话显示累计（仅统计服务端回传的真实用量，绝不估算），缓存命中一并记账
- **用量统计面板**：设置 → 用量统计，按时间范围查看 KPI 卡（Token / 花费估算 / 请求成功率 / 综合与交叉审查占比 / 平均耗时 / 缓存命中率）、每日堆叠柱状图（按模型或按用途拆分）、模型排行、最多 53 周热力图与逐请求流水（可筛选并导出 CSV，含每笔花费与公式注入防护）；数据从会话记录实时派生，综合与仲裁的 token 也按模型归因
- **编辑重发**：直接修改已发送的提问并重新提问，之后的回答会相应重建
- **单模型重试**：某个模型失败或超时，可只重试它一个，不必整轮重跑（省掉已成功模型的费用）
- **导出 / 删除本轮**：一键把本轮问答（含用时与 token 用量）导出为 Markdown 文件；不需要的轮次可整轮删除；也可一键导出整个会话（含全部轮次、附件说明与全文附录）
- **合并回答**：
  - 前端智能合并：本地要点提取 + 相似度聚类，不消耗额外 token
  - 模型二次综合：指定一个模型把各回答综合为一份结构化报告（结论 / 共同点 / 分歧 / 关键证据 / 待验证问题，空小节自动省略）；本地预分析提供共识清单与数值分歧候选，防止漏要点和静默揉合分歧；报告要点带来源角标，点击跳到对应模型卡片；报告中的数值做同值溯源，来源里没有的标「待核实」，预分析要点被遗漏时提示重新综合
- **交叉审查**：顶栏开关，回答完成后各模型互相审查其他模型的回答并给出仲裁结论（互审 + 仲裁两阶段），适合甄别事实冲突；每轮多 N+1 次请求，开启时「自动综合」让位
- **联网搜索**：必应（免密钥）/ Tavily / 博查；百炼、智谱、OpenRouter 自动启用原生联网能力
- **多会话管理**：新建 / 切换 / 重命名 / 置顶 / 删除 / 搜索（按标题与消息内容过滤），数据本地持久化
- **多轮对话**：完整上下文；按模型上下文窗口自动裁剪历史，避免超限
- **模型信息自动识别**：根据模型 ID 自动填充上下文窗口 / 最大输出 / 多模态标记 / 官方单价（models.dev 目录 + 内置规则库 + 服务商元数据三级来源），目录可在设置里一键立即更新（主进程缓存 7 天）；单价也可按模型手填覆盖，汇率可调
- **检查更新**：设置 → 数据管理 → 「关于与更新」卡片，显示当前版本，一键对比 GitHub Releases 上的最新版本，发现新版可直达下载页；仓库尚未发布 Release 或离线时会明确提示失败（属预期），可随时点「前往 GitHub Releases」
- **窗口记忆与数据保险**：记住窗口位置与大小（含最大化状态）；数据文件每天首次变更前自动留底一份快照（滚动保留 7 天），导入覆盖前也会自动备份
- **亮 / 暗主题**，数据导入导出备份（含图片附件内联，跨机恢复不悬空）

## 预置服务商与模型

预置 9 家服务商、29 个主流模型（官方单价已内置，升级自动补齐新模型），填 API Key 即用：

| 服务商 | 预置模型 |
|---|---|
| DeepSeek | DeepSeek V4 Pro · V4.1 Flash |
| Kimi 月之暗面 | Kimi K3 · K2.6 · K3.1 Pro |
| 阿里百炼 | Qwen3.8 Max · Flash · Omni-Flash |
| 智谱 BigModel | GLM-5.3 · 5.3 Flash · 5.3 FlashX · 5V Turbo |
| MiniMax | MiniMax M3.1-Flash · M3 |
| OpenAI | GPT-6.1 Sol · GPT-5.6 · GPT-6 Astra · GPT-6.1 Terra · GPT-6 Luna |
| Anthropic | Claude Opus 5.5 · Sonnet 5.5 · Fable 5.1 · Haiku 5.5 |
| Google Gemini | Gemini 4 Argon · 3.8 Flash |
| OpenRouter | GPT-6.1 Sol · Claude Sonnet 5.5 · GPT-6.1 Terra · Claude Fable 5.1 |

- **任意自定义端点**：兼容 OpenAI Chat Completions 与 Anthropic Messages 两种 API 格式
- **一个服务商多个模型**：连接信息（地址/密钥）共享，模型随意增删，聊天页按具体模型选择

## 获取与运行

- **下载**：前往 [GitHub Releases](https://github.com/Alex-758/jury/releases) 页获取安装版 / 便携版（如该页还没有发布产物，请从源码构建）；应用内「检查更新」也会指向这里
- **从源码构建**：见下方「自己构建」，产物在 `dist/`：
  - `Jury-Portable-x.x.x.exe`：免安装便携版，双击即用
  - `Jury Setup x.x.x.exe`：安装版

首次使用：左下角「设置 → 模型配置」填写各服务商的 API Key（密钥仅保存在本机用户目录，不上传任何服务器）。

## 自己构建

```bash
npm install        # 安装依赖（已配置 npmmirror 镜像加速）
npm start          # 开发模式运行
npm test           # 快门测试：零拉起窗口（全部 JS 语法门 + CSS 变量闭合门 + Node 套件）
npm run test:full  # 全量测试：19 套件（含拉起应用的端到端 / 性能 / 猴子测试）
node scripts/test.js --only smoke-review,e2e-app   # 定向拉起指定套件（改动面 → 套件映射见 --list）
node scripts/test.js --list                        # 列出全部套件与覆盖面
npm run icon       # 生成应用图标
npm run dist       # 打包 Windows 安装版 + 便携版 exe（先自动预置 markitdown 转换器）
```

测试体系按「改动面 → 套件」分层（19 套件）：纯逻辑与静态检查零拉起秒级完成，共享面改动用 `--only` 定向拉起，发布前 `--full` 全量回归。

## 目录结构

```
src/main/        Electron 主进程：无框窗口与自绘三键、IPC、并发流式请求（OpenAI / Anthropic 双格式）、
                 密钥加密存储（DPAPI / safeStorage）、图片落盘与系统 OCR、文档提取、搜索、
                 models.dev 模型目录缓存、GitHub Releases 更新检查
src/renderer/    渲染层（原生 JS，沙箱 + contextIsolation）：聊天界面、附件条、设置页、用量统计、
                 Markdown 渲染、智能合并与交叉审查、模型信息识别
scripts/         分层测试（单元 / 冒烟 / 端到端 / 性能 / 猴子测试）、图标生成、
                 打包辅助（markitdown 预置、dist-safe）、本地 mock 服务器与测试夹具
```

## 安全与隐私

- API 密钥与全部会话数据仅保存在本机（`%APPDATA%\Jury\`），不上传任何服务器
- 应用由 Multi-Model Chat 更名而来：以 Jury 之名首次启动时，会自动把旧数据目录的一次性迁移过来（store.json / catalog.json / window-state.json / images/，复制不删除，旧目录原样保留）
- 磁盘上的 API Key 使用系统凭据保护（Windows DPAPI / Electron safeStorage）加密存储；渲染层永远拿不到明文密钥（只有 hasKey 标记）
- 渲染层全程沙箱 + CSP（`connect-src 'self'`，渲染层不能直连任意网络），IPC API 面经白名单约束并有端到端回归；发请求的连接参数一律以主进程存量为准，防止被注入的页面把密钥引流到任意地址
- Markdown 渲染先转义后解析，链接仅放行 http/https 且经系统浏览器打开，应用内不发生页面导航
- 导出的备份文件包含明文密钥，请妥善保管
- 仓库不含任何密钥与运行时数据

## License

MIT
