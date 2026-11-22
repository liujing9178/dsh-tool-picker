# dsh-tool-picker 方案（完整版）

> 目标：每轮对话开始前先给模型一份**工具目录**，让它挑选本轮要用的工具，只把这些工具的定义带进请求，而不是把全部工具（本机 196 个 / 约 4.2 万 token）都带上。
>
> 环境：dsh 0.2.2-rc.3（`@deepseek-ai/dsh-desktop-runtime` 0.2.2-rc.3），Windows，profile = desktop。
> 依据：源码取自 `app.asar` 内 `@deepseek-ai/*` 的 `src/*.ts`；数字取自本机真实会话的 `request/header`。凡未核实的标 (待补充)。

---

## 1. dsh 现在的工具注册与注入机制

### 1.1 三个数据结构

| 层 | 形态 | 关键点 |
|---|---|---|
| `ToolDefinition` | `{ name, description, parameters, output:{schema,render,presentationMeta?}, execute(args,exec), deferLoading?, timeoutMs?, presentCall?, presentResult? }` | `register()` 强制 `output.render` 是函数 |
| `ToolSchema` | `{ name, description, parameters, deferLoading? }` | **模型只看这四个字段**，`schemas()` 走白名单投影 |
| `defineTool()` | 参数/输出 DSL 包装 | 可选 `deferLoading: true` |

源码：`@deepseek-ai/dsh-tools/src/contracts.ts:29`、`src/schema.ts:502/643/557`。

### 1.2 注册表 `ToolsService`（六个动作）

| 动作 | 语义 | 作用域 |
|---|---|---|
| `register(def,{when?})` | 注册；同 scope 同名报错；scoped 注册**遮蔽**全局同名 | 到 disposer |
| `restrict({allow?,deny?})` | 对**全局工具**加一层掩码，多层取**交集** | agent scope，到 disposer |
| `resolve({agent,modelSelection,signal})` | 跑 `when()` → 本步 `ResolvedToolSet`（冻结） | 单步 |
| `schemas(scope?,toolSet?)` | 投影 `ToolSchema[]` | 只读 |
| `execute(batch)` | 派发，走完整管线（policy→guards→dispatch） | 单次调用 |
| `guard(fn)` | 单调拒绝 | scope |

要点：`restrict` 只认**全局名**（`restrictableNames`），scoped 注册的工具既不受限、也永远可见；未知名会 throw。
源码：`dsh-tools/src/index.ts:130/164/181/216/266/318/377`。

### 1.3 每一步的注入时序

`dsh-agent-loop/src/agent.ts:290-324`：

```
preStep():
 ① toolSet = await tools.resolve({agent, modelSelection, signal})     // 跑 when()，冻结本步可用集
 ② assembly = await systemPrompt.assemble({scope, toolSet, ...})      // ← 工具面在此定型
      收集所有 toolProviders → schemas[] → orderTools() → 跑 system-prompt/assemble 瀑布
 ③ emit 'agent/pre-step'（waterfall，只能改 messages）
 ④ return { assembly, toolSet }
...
buildRequest(config, preparedCall, assembly.tools, ...)              // 工具表进请求体
```

两条硬事实：

1. **`agent/pre-step` 在 `assemble` 之后**，payload 无 `assembly`，返回只有 `messages` → 改不了本步工具面，只影响下一步。
2. **`assemble()` 最后 `return { ...transformed, tools }`** → 瀑布里改写 `assembly.tools` 被覆盖（`dsh-system-prompt/src/index.ts:685-696`）。这不是推测：社区插件 `dsh-tool-search` 的源码里写着同名结论，并因此只在 PTC 模式改 `tools:sdk` 段。

`ToolsService` 自己的 provider 是 `({scope,toolSet}) => executor.describe(this.definitions(scope, toolSet))`（`index.ts:115`），而 `definitions → toolSet.view → resolve() 的 admitted 集 → 受 restrict 影响`。**这就是 restrict 能减面、瀑布改不动面的原因。**

### 1.4 五个候选接缝的真实能力

| 接缝 | 判定 | 依据 |
|---|---|---|
| `agent.ctx.tools.restrict({allow})` | ✅ **主用**：真正收窄“可见 + 可调用” | 源码 + 实测 |
| `register(def,{when})` | ⚠️ 只对**自建**工具生效 | `contracts.ts:108-127` |
| `ctx.systemPrompt.tools(provider)` | ❌ 多 provider 是 push 叠加，删不掉别人的项 | `system-prompt:642-659` |
| 瀑布改 `assembly.tools` | ❌ 被 `{...transformed,tools}` 覆盖 | `system-prompt:685-696` |
| `ToolSchema.deferLoading` | ⚠️ 仅自建工具；且 DeepSeek 端点忽略该字段（见 §2.6） | `schema.ts:643`、`dsh-llm-deepseek/src/serialize.ts:167` |
| `ctx.tools.setExecutor()` | ❌ 过重，影响 PTC 与审批链 | `index.ts:327` |

### 1.5 本机实测

| 项 | 数值 | 方法 |
|---|---|---|
| 单请求工具数 | **196** | 解压会话 `session.v4.jsonl.zstd` 读 `request/header.data.header.tools` |
| 工具表体积 | **149,698 字符** | 同上 |
| 折算 token | **≈ 37K–42K / 轮**（4.0–3.6 字符/token） | 同上 |
| 单工具均值 | ≈ 210 token；最大 `video_engine` 7,472 字符 | 逐工具统计 |
| restrict 是否真生效 | **是**：`preset=cordis` 会话 `denied=52 pending=0`，其 header 里 `advanced_search / multi_search / research / screen_shot / task_board_create / sd_img2img / purge_status` 全部缺席 | `~/.dsh/tool-surface-policy.log` + 会话 header 对查 |

既存同类实现：`~/.dsh/plugins/dsh-tool-surface-policy/index.mjs`（用 `agent.ctx.tools.restrict({deny})` + `agent/pre-step`），生命周期写法可直接照抄。

---

## 2. 调研

### 2.1 Claude 官方 Tool Search Tool（2025-11）

原文：[Introducing advanced tool use for Claude](https://www.anthropic.com/research/advanced-tool-use)；本机 `@anthropic-ai/sdk` 内有一字不差的类型定义可交叉验证。

- 机制：工具照常随请求提交但标 `defer_loading: true` → **不进初始 prompt**；模型只看到 `tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119` + 少数常驻工具；搜索后服务端返回 `tool_reference` 块，被引用的工具定义**当轮展开**。
- SDK 原文：`defer_loading?: boolean` — “If true, tool will not be included in initial system prompt. Only loaded when returned via tool_reference from tool search.”
- 官方数字：50+ MCP 工具 ~72K → **8.7K token（-85%）**；内部见过 134K；Opus 4 选对率 49%→74%，Opus 4.5 79.5%→88.1%。
- beta 头：`advanced-tool-use-2025-11-20`。
- 缓存：deferred 工具不进初始 prompt → prompt caching 不受影响。
- 启用判据（官方）：工具定义 **>10K token**、工具 ≥10 个、有误选问题；工具 <10 个 / 每轮全用 / 定义很短则收益低。建议“3–5 个最常用工具常驻”。

### 2.2 Claude Code 自己的做法（对标）

[code.claude.com/docs/en/mcp#scale-with-mcp-tool-search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)：
MCP 工具**默认全部 defer**，会话开始只把工具名 + server instructions 交给模型，由内置 `ToolSearch` 按需检索加载；`ENABLE_TOOL_SEARCH` 取 `false|true|auto|auto:N`，**默认阈值 = 工具定义占上下文 10%**。工具条目见 [tools-reference](https://code.claude.com/docs/en/tools-reference)。

→ 与目标形状完全一致：**先给名字、按需加载、加载后常驻**。

### 2.3 开源可参考

[openai/openai-agents-python](https://github.com/openai/openai-agents-python)（Apache-2.0）：`@tool(defer_loading=True)` / `tool_namespace(name=...,tools=[...])` + `ToolSearchTool()`；MCP 侧另有 `create_static_tool_filter` 与 `(ToolFilterContext,tool)=>bool` 回调（[docs/tools.md](https://github.com/openai/openai-agents-python/blob/main/docs/tools.md)、[docs/mcp.md](https://github.com/openai/openai-agents-python/blob/main/docs/mcp.md)）。

### 2.4 方案对比

| 方案 | 核心思路 | 适用 | 优点 | 缺点 |
|---|---|---|---|---|
| Claude 官方 Tool Search | `defer_loading` + 服务端搜索 + `tool_reference` | 托管在 Anthropic | 零协议开销、缓存友好、官方基准提升 | 绑 Anthropic 端点 |
| [Hermes Agent tool search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search) | 折叠成 `tool_search/describe/call` 三桥 + 分级清单 | 任意 provider | 厂商解耦 | 多一跳；`tool_call` 桥要保证审批仍对真实工具名 |
| [dsh-tool-search](https://github.com/Letter2025/dsh-tool-search)（本机已装） | Hermes 式三桥 + tier0–3 + warm LRU，走瀑布 | dsh 0.2.x | 与本机版本适配、配置齐 | **native 模式下折叠失效**：瀑布拿不到 tools 表，196 仍是 196 |
| 语义工具检索（[2409.02141](https://arxiv.org/abs/2409.02141)、[2412.03573](https://arxiv.org/abs/2412.03573)） | 向量/重排检索 top-K 再注入 | 工具上千 | 命中率高 | 需额外模型；检索错=任务失败 |
| [MCP 分页](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination) / [tools 能力](https://spec.modelcontextprotocol.io/specification/2025-03-26/server/tools/) | `tools/list` 分页 + `list_changed` | 客户端自管 | 协议原生 | 只解决“传多少” |
| MCP 网关（docker/mcp-gateway 一类） | 网关聚合、按需暴露子集 | 多 MCP 统一接入 | 集中治理 | 粒度是 server，非“本轮任务” |

opencode / Cline / Roo Code / goose / Continue / aider 的同类机制：(待补充：一手材料未取到)

### 2.5 与 Claude 的对应关系

| Claude | dsh | 本方案 |
|---|---|---|
| `defer_loading: true` | `ToolSchema.deferLoading`（definition 级） | 主用 restrict 达成同效果；deferLoading 作旁路（本机不适用，§2.6） |
| `tool_search_tool_regex_20251119` | 无内建 | 自建 `tool_pick` + `tool_search` |
| `tool_reference` 展开定义 | 无 | restrict 白名单重算 → 下一步 `schemas()` 自动带上 |
| 系统提示 “You have access to…” | `systemPrompt.context()` | 目录注入 runtime context（`required:true`） |
| `advanced-tool-use-2025-11-20` | — | 应用层实现，无需 beta 头 |
| deferred 不进初始 prompt → 缓存不破 | — | **本方案会破缓存**（工具面变 → 新 series），见 §4 |

### 2.6 关键结论：DeepSeek 端点忽略 `defer_loading`

DeepSeek 有 Anthropic 兼容口（`https://api.deepseek.com/anthropic`），但[官方兼容性文档](https://api-docs.deepseek.com/guides/anthropic_api)：`anthropic-beta` 头**被忽略**，`tools` 只认 `name` / `input_schema` / `description`，无 `defer_loading`、`tool_search_tool_*`、`tool_reference`。（页面上的 `usage.server_tool_use.tool_search` 是 Web 搜索计数，与此无关。）

→ dsh 里 `ToolSchema.deferLoading → defer_loading` 的通路虽在，对这个端点**没有语义**。**restrict 是唯一可行路径。**

---

## 3. 设计

### 3.1 架构

```
① 目录层  catalog()   ctx.tools.schemas()（全局视图，不受 restrict 影响）→ 分组 → 按预算出 tier 文案
② 呈现层  context     agent.ctx.systemPrompt.context({name:'tool-picker:catalog', required:true, text})
③ 挑选层  桥工具      tool_catalog(只读) / tool_pick(加载) / tool_search(关键词检索)
④ 装配层  surface     selected → allow 白名单 → agent.ctx.tools.restrict({allow})，先 dispose 旧的
```

主链路（同一 turn 内）：

```
step N   resolve(S0) → assemble → 模型看到 [core 8 + 3 桥 + 目录]
         ↓ 模型调 tool_pick({add:["ffmpeg_cut","browser_click"]})
         桥 execute：更新 selected → dispose 旧 restriction → restrict({allow: core∪selected∪桥})
step N+1 resolve(S1) → assemble → 模型看到 [core + 桥 + 那两个工具]
         ↓ 直接原生调用 ffmpeg_cut(...)
```

### 3.2 目录生成与呈现

- **来源**：插件在全局 ctx 调 `ctx.tools.schemas()`（无 scope）→ 全量全局工具（scoped 工具不进目录，因为 restrict 管不到它们）。
- **分组**：工具名前缀（`ffmpeg_`/`douyin_`/`canvas_`…），无前缀归 `misc`。
- **分档**：

```
budget = min(thresholdPct% × contextWindow, listingMaxTokens)     // 默认 5% × 1M 与 3000 取小 = 3000
tier 1  full（名字 + ≤40 字描述）≤ budget  → 桥 + full 清单
tier 2  names-only ≤ budget                 → 桥 + 纯名字
tier 3  否则                                 → 桥 + 每组一行（组名: 数量）
```

- **文本样例（tier 1）**：

```text
<tool-picker catalog>
以下工具尚未加载：清单里出现的名字现在不可直接调用。
挑选：tool_pick({add:["名字", ...]})，下一步生效；检索：tool_search({query:"..."});全量：tool_catalog()。

已加载（可直接调用）：read, write, edit, grep, glob, win_bash, todo_write, skill, tool_catalog, tool_pick, tool_search

## ffmpeg (9)
ffmpeg_cut — 按时间区间剪辑；流拷贝极快，reencode=true 精确到帧
...
## douyin (28)
douyin_like — 给当前播放的视频点赞（真实点击）
```

- **必须挂 `contexts` 且 `required: true`**：GUI persona 是 complete section，会整体替换 `sections`；而 `contexts` 在 runtime-context 被 suppress 时只保留 `required:true` 的项（`system-prompt:689-696`）。context 内容相同则不会重复追加（`runtime-context.ts` 里 `deepEqualJson` 去重）。

### 3.3 挑选（`tool_pick`）

结构化 schema，不用自然语言回 JSON：

```js
parameters: { add: string[], remove?: string[], reset?: boolean }
output.schema: { loaded: string[], pending: string[], hint?: string }
```

解析规则（确定性）：
1. `reset` → 清空 `selected`
2. `remove` 逐个删（core / 桥名忽略）
3. `add` 逐个校验：∈ catalog 且 ∉ 桥 → 入 `selected`；否则进 `pending`
4. `selected` 上限 `maxSelected`（默认 40），超出进 `pending`
5. 重算 allow 并应用（先 dispose 旧的）
6. 幂等：重复 pick 同一组名字，结果一致

### 3.4 装配（本方案的引擎）

```js
function allowOf(ctx, state, cfg) {
  const known = new Set(catalog(ctx).map(e => e.name));
  const allow = [...cfg.core, ...state.selected].filter(n => known.has(n));
  for (const b of BRIDGES) if (!allow.includes(b)) allow.push(b);  // 桥无条件保留，否则死锁
  return allow;
}

function applySurface(agent, ctx, cfg) {
  if (!shouldSlim(ctx, cfg)) { state.disposer?.(); state.disposer = undefined; return; }
  const allow = allowOf(ctx, state, cfg);
  if (allow.join('\0') === state.lastSig && state.disposer) return;   // 没变就不动，省缓存
  state.disposer?.();                                                  // ★ 必须先撤销：restriction 取交集
  state.disposer = agent.ctx.tools.restrict({ allow });
  state.lastSig = allow.join('\0');
}
```

四条纪律：
- **先 dispose 再 restrict**，否则白名单越缩越窄。
- **allow 只放已知全局名**，否则 throw；每次 apply 前用 catalog 名过滤（插件热插拔名字会漂移）。
- **桥必须在 allow 里**，否则模型连挑选都做不到。
- **本步已冻结**：restrict 只影响下一步。

### 3.5 未选中工具怎么处理

| 模型行为 | 实际发生 | 兜底 |
|---|---|---|
| 调不在 allow 的工具 | `UNKNOWN_TOOL`（`pipeline.ts:73-82`） | 目录与 `tool_pick` 文案都写明“先 pick 再调”；错误带工具名，模型能自我纠正 |
| 想在桥里代调未选中工具 | 同样 `UNKNOWN_TOOL`（toolSet 冻结） | 桥只做挑选/检索，不做代调 |
| 挑错名字 | 进 `pending`，不进 allow | 返回提示去 `tool_catalog` / `tool_search` 取准确名 |
| catalog 太小 / 未达阈值 | 不加 restrict | 等价现状，零风险 |
| 插件自身出错 | 卸载 | 钩子全包 try/catch，失败即 dispose 恢复全量 |

### 3.6 多轮/多步怎么变

```
turn 1  step1  S0 = core ∪ 桥                     （只看目录，必须 pick）
        step2  S1 = S0 ∪ {ffmpeg_cut}             （干活）
turn 2  step1  S1（跨 turn 保留，不重置）          ← 免掉第二次 pick
turn N  换任务 → tool_pick({reset:true}) → 回 S0
```

钩子：`agent/created`（安装）、`agent/pre-step`（对账：目录漂移 / selected 失效 → 重算）、`agent/disposed`（清理）。

### 3.6b token 估算（中文坑）

`estTokens` 不能按单一字符比折算：中文（CJK）约 **1.5–2 字符/token**，英文约 **3.6**。统一用 3.6 会把中文工具描述低估近一半，目录因而误判“放得下”，实际超预算。

```js
const estTokens = (text) => {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return Math.ceil(cjk / 1.7 + (text.length - cjk) / 3.6);
};
```

实测：26 字中文描述 → 旧估 8 token、新估 15 token；80 字符英文 → 两者都是 23 token。196 个中文描述的工具、预算 3000 → 自动落到 names-only 档（正确），预算 8000 才给 full。

### 3.7 启用判据（auto 双门槛）

只按“占上下文比例”会误判：本机 `contextWindow` 默认 **1,000,000**，196 个工具只占 **4.1% < 10%** → 照 Claude Code 的 10% 判据会永远不启用，而它确实贵（4 万 token）。故两条取“或”：

```js
if (tokens >= cfg.minToolTokens) return true;                 // A: ≥10K token（Anthropic 官方门槛）
return (tokens / cfg.contextWindow) * 100 >= cfg.autoPct;      // B: ≥10% 窗口（Claude Code auto:N）
```

实测：196 工具 / 1M 与 128K 窗口均启用；10 工具不启用；`enabled:off` 完全不动。

---

## 4. token 影响与代价

### 4.1 账（按实测 196 工具 / 149,698 字符）

| 项 | 现状 | 方案后（core 8 + pick 8 个） |
|---|---|---|
| 工具 schema | ≈ 41.6K token | core 8×210 ≈ 1.7K + 桥 ≈ 0.5K + 选中 8×210 ≈ 1.7K |
| 目录文本 | 无 | tier1 ≈ **3.0K**；tier2（纯名）≈ **0.8K** |
| 单步合计 | **≈ 41.6K** | **≈ 6.9K**（tier1）/ **≈ 4.7K**（tier2） |
| 净节省 | — | **≈ 34–37K / 步（-80% 以上）** |

### 4.2 代价

| 代价 | 说明 | 缓解 |
|---|---|---|
| 多一次挑选推理 | 首步只做 pick，约 0.5–1.5K token + 一跳延迟 | `selected` 跨 turn 保留，第二轮起几乎为零 |
| **prompt cache 前缀失效** | 工具面变 → `toolsChanged()` 真 → `startsSeries:true` → system prompt 重写（`agent.ts:327/460-465`）。工具定义在请求最前部，一变整段作废 | 工具集稳定优先：一轮内一次 pick 做完；`lastSig` 相同不动 allow |
| 目录快照在历史里累积 | 每次目录变化追加一条 user 快照（旧条被 supersede 但仍占位） | 目录做小（tier2/3）；只在跨阈值时刷新 |
| 选错/漏选 | 目录描述质量决定命中率 | 分组 + 一句话 + 高频进 core + `tool_search` 兜底 |
| `UNKNOWN_TOOL` 死路 | 没 pick 就调 → 本步白跑 | 文案写清规则；`pending` 给提示 |
| 工具名漂移 | 插件热插拔 → allow 里有死名 → throw | 每次 apply 用 catalog 过滤 + try/catch |

### 4.3 兜底

1. 未达阈值（`shouldSlim` 假）→ 不裁、不显示目录，零影响。
2. 任何钩子抛错 → dispose → 回到全量。
3. `enabled:'off'` 只跳过 restrict（可做对照实验）。
4. 名字双向校验：allow 只取 catalog 名；`add` 只接 catalog 名。
5. `core` 必含：read/write/edit/grep/glob/win_bash/todo_write/skill + 3 桥。
6. 可见性与可调用性同源（restrict 同时管两边），不出现“看得见调不动”。

---

## 5. 落地

### 5.1 已完成

| 文件 | 状态 |
|---|---|
| `dsh-tool-picker/index.mjs`（15.4 KB） | 语法检查通过；用假 ctx 跑通 smoke：目录分档、allow 11→13、add/remove/reset、disposer、上限、auto 双门槛 |
| `dsh-tool-picker/package.json` | 与 `dsh-tool-surface-policy` 同形，免编译 |
| `dsh-tool-picker/patch-snippet.yml` | 可直接追加到 `cordis.patch.yml` 的配置片段（含 `off` 静默试用档与共存说明） |
| `_probe/count-tools.mjs` | 验收脚本；已在本机真实会话跑出 196 / 149,698 / ≈41,583 token |
| `~/.dsh/plugins/dsh-tool-picker/` | 已同步最新版；**patch 未引用 → 当前不会被加载** |

### 5.2 要你做的两步

1. `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: tool-picker
      name: dsh-tool-picker
      config:
        enabled: auto          # auto | on | off
        minToolTokens: 10000
        autoPct: 10
        thresholdPct: 5
        listingMaxTokens: 3000
        contextWindow: 1000000
```

2. 重启 dsh（新插件只有重启后才加载）。

### 5.3 验收

```bash
node F:/dsh/问题修/_probe/count-tools.mjs "C:/Users/LENOVO/.dsh/sessions/<工作区><会话id>" --verbose
```

判据：`tools=` 196 → **15 上下**；`chars` 149,698 → **2 万以内**。
其他检查：目录只出现一次；pick 后下一步 tools 里出现被选工具；调未选中的工具返回 `UNKNOWN_TOOL`；`enabled:off` 后恢复 196。

### 5.4 待验证 / 待补充

- DeepSeek 端点对 `defer_loading` 的具体表现（现已确认字段被忽略，故旁路方案在本机作废）。
- opencode / Cline / Roo Code / goose / Continue / aider 的懒加载机制一手材料：(待补充)。
- 插件在 `ptc` / `cordis` 等 preset 下与 `dsh-tool-search`、`dsh-tool-surface-policy` 同时存在时的交互顺序（三者都用 `agent/pre-step` + restrict，需实测谁压谁）。

### 5.5 与既有插件共存（源码推演结论）

| 插件 | 用法 | 叠加结果 |
|---|---|---|
| `dsh-tool-surface-policy`（已装、在跑） | `restrict({ deny: [52 个重工具] })` | dsh 的掩码是**多层取交集**（`ToolLayer.admits` 要求每层都放行），最终 = 本插件 allow 的 ∩ 它没 deny 的。互不打架，各自持有自己的 disposer，不会清掉对方的设置。 |
| `dsh-tool-search`（已装，`enabled: auto`） | 自己挂一份清单 context + `tool_search/tool_describe/tool_call` 三桥 | 会出现**两份工具目录**，模型容易读混；且它的 native 折叠在本版本本就无效（196 照旧全发）。 |
| 本插件 | `restrict({ allow })` | 上两行的交集。 |

**建议**：装本插件时把 `dsh-tool-search` 设为 `enabled: off`。理由不是它写得差——它的 DESIGN 里明确记着“瀑布拿不到 tools 表所以折叠是 no-op”，在本版 dsh 上它兑现不了承诺，留着只多一份重复目录。

### 5.6 一句话验收口径

`enabled: off` 时：工具表应仍是 196（确认插件零副作用）。
`enabled: auto` 时：工具表应降到 15 上下，且目录 context 只出现一次、被 pick 的工具在下一步出现。

