# @ssk_dev/rpiv-ask-user-question-lean

<!-- token-benchmark:summary:start -->
> **Token 基准：Lean 220，上游 `@juicesharp/rpiv-ask-user-question@2.13.8` 1,258，减少 82.5%。**
<!-- token-benchmark:summary:end -->
> **完整配置参考：** [查看 Pi Lean Setup](https://github.com/kunkun9527/my-lean-pi-setup)

[English](README.md)

基于 [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) 的精简封装。在完整保留交互式问卷界面与选项校验的同时，精简工具描述与提示词，大幅减少初始化上下文开销。

## 初始化上下文占用对比

<!-- token-benchmark:benchmark:start -->
单独启用本扩展时，模型可见的常驻初始化上下文如下：

| 版本 | 工具与 Prompt 构成 | 合计 |
| --- | --- | ---: |
| Lean `@ssk_dev/rpiv-ask-user-question-lean@2.13.11` | `ask_user_question` (220) | **220** |
| 上游 `@juicesharp/rpiv-ask-user-question@2.13.8` | `ask_user_question` (1,258) | **1,258** |

节省 **1,038 tokens（82.5%）**。
测量环境为 Pi 1.3.0 的独立临时进程、空白工作目录与空白配置。排除内置工具、Skills、上下文文件、会话历史、用户消息、无关扩展、运行时 UI 与 Slash Commands；计入扩展的 `before_agent_start` 注入。Token 是按 `ceil(字符数 / 4)` 计算的固定字符代理估算，并非模型 tokenizer 实际计费值。
<!-- token-benchmark:benchmark:end -->

## 核心特性

* 完整交互体验：保留原版问卷交互界面、选项预览以及 RPC 回退机制；在 RPC 宿主（如经 codexhost 接入的 Codex）中改用原生选项卡片，支持返回上一题、提交前检查和多选勾选；这类宿主无法显示预览，因此 RPC 下的提示词会要求模型不使用 preview。
* 结构化输入验证：支持单选、多选、推荐选项排序与严格的输入校验。
* 精简 Prompt 描述：精简工具说明中的冗余文本，让模型更轻快地发起澄清提问。

## 安装

```bash
pi install npm:@ssk_dev/rpiv-ask-user-question-lean
```

请勿与其它 `rpiv-ask-user-question` 包装扩展同时加载，以防重复注册工具。

## 使用方法

模型仅会看到一个工具：

```text
ask_user_question
```

当遇到不明确的需求或需要用户做选择时使用。每次调用可提出 1 到 4 个结构化问题，每个问题提供 2 到 4 个明确选项。参数写错时会在校验前自动纠正：单个问题被平铺在顶层、`header`/`options` 漏在只有一项的 `questions` 外面、缺少 `header`（由问题文本生成）；多个问题时不做猜测。

## 版本说明

上游运行时锁定为 `@juicesharp/rpiv-ask-user-question@2.13.8`。

## 本地开发

```bash
npm ci
npm run check
```

测试套件使用本地 Harness 运行，不会弹出实际的交互问卷 UI。

## 开源协议与致谢

MIT 协议。本项目封装自采用 MIT 协议的 [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)。