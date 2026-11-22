# dsh-tool-picker

<sub>DSH（DeepSeek Harness）的**渐进式工具披露**插件 —— English: [README.md](README.md)</sub>

先把一份**工具目录**交给模型，让它用 `tool_pick` **点单**，**下一步**只带上点过的那些工具的 schema。为"工具很多"的场景做的：在 207 个工具的真实配置上，把每步的工具定义从 **约 45,400 token 压到约 4,000**。

## 解决的问题

DSH 会把每个已注册工具的定义塞进每一次模型请求。插件和 MCP 一多，每步就是几万 token，而其中大部分工具这次根本用不上。

```
改之前：207 个工具 · 163,480 字符 · ≈45,400 token / 步
改之后：11 个常驻 + 一份约 3,000 token 的目录 + 点过的那几个
```

## 怎么做的

```
① 目录    ctx.tools.schemas(agent)  → 按前缀分组、按预算分档的清单
② 呈现    agent.ctx.systemPrompt.context({required:true})  → runtime context
③ 点单    tool_catalog / tool_pick / tool_search
④ 装配    agent.ctx.tools.restrict({ allow })  → 只留 常驻 ∪ 点过 ∪ 三个桥
```

- **目录**是一段纯文本清单（名字 + 一句话描述，按工具名前缀分组），挂成 runtime context —— 这样即使人设是"完整段落"（complete section）也不会把它盖掉。
- **点单**是结构化的：`tool_pick({ add: [...], remove: [...], reset?: true })`。
- **装配**用的是 `ToolsService.restrict({ allow })` —— DSH 里唯一能同时收窄"模型看得见"和"调得动"的接缝。白名单每一步都从 **agent 作用域** 重新量一遍再设。

> 点单在**下一步**生效，因为每一步的工具集在模型开口之前就冻结了。这是 DSH 的机制，不是插件的毛病。

## 安装

```sh
# 从 npm
dsh plugin --profile desktop add dsh-tool-picker

# 或从本地目录
dsh plugin --profile desktop add "link:/path/to/dsh-tool-picker"
```

装完重启 DSH。它会出现在 **设置 → 插件 → 已安装插件** 列表里，带启用/停用开关，和别的插件一样。

配置写在插件的 `cordis.patch.yml`（bundle 层）或你的 profile patch：

```yaml
- insert:
    - id: tool-picker
      name: dsh-tool-picker
      config:
        enabled: "auto"        # auto | on | off（必须加引号：裸 off 会被 YAML 读成布尔 false）
        minToolTokens: 10000   # 绝对阈值
        autoPct: 10            # 或 占上下文窗口 ≥10%
        thresholdPct: 5        # 目录预算 = min(5% × contextWindow, listingMaxTokens)
        listingMaxTokens: 3000
        contextWindow: 1000000
        minCatalogSize: 12
        maxSelected: 40
        detailChars: 70
        core: [read, write, edit, grep, glob, win_bash, todo_write, skill]
```

## 它加的三个工具

| 工具 | 作用 |
|---|---|
| `tool_catalog` | 按前缀列出完整目录（只读） |
| `tool_pick` | 为下一步加载/卸载工具（`add` / `remove` / `reset`） |
| `tool_search` | 在目录里按关键词检索（只读） |

## 代价与坑

- **任务第一步会多一次往返**（先点单再干活）。选择会跨轮保留，所以后续轮次不额外付费。
- **工具集一变，prompt cache 的前缀就作废**。所以：一个任务点一次，别反复换。
- **没点过的工具调用会 `UNKNOWN_TOOL`**。目录和 `tool_pick` 的返回里都写明了这条规矩。
- 与 Anthropic 官方 [Tool Search Tool](https://www.anthropic.com/research/advanced-tool-use) 的差别：官方是**服务端**延迟加载（`defer_loading`），所以缓存不受影响；DeepSeek 的 Anthropic 兼容端点会忽略 `defer_loading`，因此本插件改在**客户端**把工具从请求里拿掉 —— 省下的量一样，代价是缓存会被打断。

## 设计依据

源码级的接缝对照、实测数字和失败模式都在 [DESIGN.md](DESIGN.md)。两条值得单独强调：

- 在 `system-prompt/assemble` 瀑布里改写 `assembly.tools` 在 DSH ≥ 0.2.1-rc.3 上是 **no-op**（`return { ...transformed, tools }` 会把它覆盖）。
- `ctx.tools.schemas()` **不带 scope** 只看得见全局层，preset/agent 层注册的工具（`read`、`write`、`grep` 这些）不在里面。量工具面必须用 `schemas(agent)`。

## 许可证

MIT
