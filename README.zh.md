# dsh-token-limits-notice

DSH 上下文限额提示插件 · DeepSeek Harness 插件：每次会话上下文越过 1M token 限额时，同时提醒模型和你。

[English](README.md) | 中文

## 功能

DeepSeek V4 默认 1M token 上下文窗口。本插件监视每个 agent 的 pre-step 消息面，当下一次请求的 prompt 估算超过配置的 token 阈值（默认 1,000,000）时，向该请求追加一条提醒消息，告知模型已处于上下文窗口上限——输出可能被截断、请求可能失败，应保持简洁或建议压缩对话。

- **模型侧守卫**（本包）：以 `notice` 形式注入上下文消息，每次"越过"（under → over）触发一次，不否决也不改写任何请求。
- **GUI 警示圆环 + toast**：位于 DeepSeek Harness monorepo 外壳（`ui-conversation` 的 `ContextMeter`/输入栏）——用量越过 1M 时圆环变红并弹一次提示。本包只负责宿主侧守卫。

## 安装

在 dsh 检出或已安装 CLI 中，把 bundle 注册到 web profile：

```sh
dsh plugin --profile web add dsh-token-limits-notice
```

或手动在 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: context-size-reminder
      name: 'dsh-token-limits-notice'
      config:
        thresholdTokens: 1000000
```

依赖 `token-meter` 服务（dsh base bundle 默认已挂载）。

## 配置

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `thresholdTokens` | `number` | `1000000` | 估算的下一次 prompt token 数超过该值即向模型注入提醒。必须为正整数，否则插件加载时快速失败。 |
| `reminderText` | `string` | 内置 | 整体替换默认提醒文案。 |

## 工作原理

每次 `agent/pre-step` 读取 `ctx.tokenMeter.measure(session)`——与输入框上下文圆环同一套可重放计量——再加上尚未写入会话日志的待发送消息的启发式价格。当估算首次越过 `thresholdTokens` 时，守卫通过 `next()` 委托，并向该请求的 `enter` 决策追加一条提醒（source 为 `{kind: 'plugin', plugin: 'dsh-token-limits-notice', form: 'notice'}`），循环将其作为注入的 `user/message` 写入日志。

- **每次越过触发一次**：按 agent 隔离的 `WeakMap` 闩锁只在 under → over 转换时触发，持续超限不会重复注入同一条提醒，警告本身也不会撑大它要保护的上下文。压缩使用量回到阈值以下后，下一次越过会再次触发。
- **追加而非前置**：提醒落在对话之后，请求前缀可继续复用 KV-cache。
- **仅存于内存**：恢复的会话从全新闩锁开始；本守卫是启发式提醒，不是日志化不变量。

## 模型体验

### 默认提醒

#### 模型看到什么

当估算的下一次 prompt 首次越过 `thresholdTokens` 时，该 agent 的请求会在最后一条消息收到下面的提醒——文案中会插入 `thresholdTokens` 的实际数值，配置 `reminderText` 时整体替换为自定义文案。工具 schema 与请求文本均不改变。

##### 提醒文案

```markdown
Context size warning: the model-visible context has exceeded 1000000 tokens.
The conversation is at the context-window limit: responses may be truncated
and requests may fail. If the task is not complete, keep subsequent replies
concise and recommend compacting the conversation or starting a new session
to free context.
```

#### Token 影响

越过阈值之前为 0 token；提醒本身（几百 token）作为该 agent 的保留历史，每次越过追加一条。

#### KV Cache 影响

仅追加：提醒落在可复用请求前缀之后，不会使已有 KV-cache 条目失效。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

测试针对已发布的 `@deepseek-ai/*` 包（0.1.0-rc.8）配合脚本化 mock adapter 运行——无需网络或 API key。

## 已知限制与待办

- 度量是锚定 provider 用量的估算，不是请求闸门：越过阈值的 prompt 仍会发出，provider 自身的限制执行不变。
- 闩锁仅在内存中：重启后恢复的持久化会话会在下一次超限 pre-step 再次触发（无状态启发式提醒的可接受代价）。
- GUI 警示（红色圆环 + toast）是 DeepSeek Harness 外壳改动，不包含在本独立包内；本包的宿主守卫仅面向模型。
