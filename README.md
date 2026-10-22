# Multi-Model Chat

同时调用多个大模型、并行对比回答、一键合并综合的本地桌面应用（Electron）。

![平台](https://img.shields.io/badge/platform-Windows-blue)

![框架](https://img.shields.io/badge/framework-Electron%2044-47848f)

## 功能特性

- **多模型并行对话**：一次提问，同时调用多个模型（可单选/多选），每个模型独立卡片流式输出
- **预置 9 家服务商**：DeepSeek / Kimi 月之暗面 / 阿里百炼 / 智谱 BigModel / MiniMax / OpenAI / Anthropic / Google Gemini / OpenRouter，填 API Key 即用
  （预置模型：DeepSeek V4 Pro/V4.1 Flash；Kimi K3/K2.6；Qwen3.8 Max/Flash；GLM-5.3/5.3-Flash；MiniMax M3.1-Flash/M3；GPT-5.6/5.5；Claude Opus 5/Sonnet 5；Gemini 3.8 Flash/3.1 Pro；OpenRouter 上为 GPT-5.5、Claude Sonnet 5）
- **任意自定义端点**：兼容 OpenAI Chat Completions 与 Anthropic Messages 两种 API 格式
- **一个服务商多个模型**：连接信息（地址/密钥）共享，模型随意增删，聊天页按具体模型选择
- **合并回答**：
  - 前端智能合并：本地要点提取 + 相似度聚类，不消耗额外 token
  - 模型二次综合：指定一个模型把各回答综合为一份更全面的回答
- **联网搜索**：必应（免密钥）/ Tavily / 博查；百炼、智谱、OpenRouter 自动启用原生联网能力
- **多会话管理**：新建 / 切换 / 重命名 / 置顶 / 删除，数据本地持久化
- **多轮对话**：完整上下文；按模型上下文窗口自动裁剪历史，避免超限
- **模型信息自动识别**：根据模型 ID 自动填充上下文窗口 / 最大输出 / 多模态标记（models.dev 目录 + 内置规则库 + 服务商元数据三级来源）
- **亮 / 暗主题**，数据导入导出备份

## 获取与运行

本仓库不发布 Release，请从源码构建（见下方「自己构建」）。构建产物在 `dist/`：

- `Multi-Model-Chat-Portable-x.x.x.exe`：免安装便携版，双击即用
- `Multi-Model Chat Setup x.x.x.exe`：安装版

首次使用：左下角「设置 → 模型配置」填写各服务商的 API Key（密钥仅保存在本机用户目录，不上传任何服务器）。

## 自己构建

```bash
npm install        # 安装依赖（已配置 npmmirror 镜像加速）
npm start          # 开发模式运行
npm run icon       # 生成应用图标
npm run dist       # 打包 Windows 安装版 + 便携版 exe
```

## 目录结构

```
src/main/        Electron 主进程：窗口、IPC、并发流式请求、搜索、本地存储
src/renderer/    渲染层：聊天界面、设置页、Markdown 渲染、智能合并
scripts/         图标生成、本地 mock 测试服务器
```

## 隐私说明

- API 密钥与全部会话数据仅保存在本机（`%APPDATA%\Multi-Model Chat\`），不上传任何服务器
- 磁盘上的 API Key 使用系统凭据保护（Windows DPAPI / Electron safeStorage）加密存储
- 导出的备份文件包含明文密钥，请妥善保管
- 仓库不含任何密钥与运行时数据

## License

MIT
