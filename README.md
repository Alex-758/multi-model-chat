# Multi-Model Chat

同时调用多个大模型、并行对比回答、一键合并综合的本地桌面应用（Electron）。

![平台](https://img.shields.io/badge/platform-Windows-blue) ![框架](https://img.shields.io/badge/framework-Electron%2044-47848f)

## 功能特性

- **多模型并行对话**：一次提问，同时调用多个模型（可单选/多选），每个模型独立卡片流式输出
- **预置 5 家服务商**：DeepSeek / 硅基流动 / 阿里百炼 / 智谱 BigModel / OpenRouter，填 API Key 即用
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

## 下载使用

从 [Releases](../../releases) 页面下载 `Multi-Model-Chat-Portable-x.x.x.exe`，双击即用（免安装便携版）。

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
- 仓库不含任何密钥与运行时数据

## License

MIT
