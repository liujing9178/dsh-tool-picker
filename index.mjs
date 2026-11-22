/**
 * dsh-tool-picker — 按轮披露工具：先给目录，模型挑选，下一步只带选中的工具。
 *
 * 落地面（全部经源码核实，dsh 0.2.2-rc.3）：
 *  - 目录来源      ctx.tools.schemas()                         （全局视图，不受 restrict 影响）
 *  - 目录呈现      agent.ctx.systemPrompt.context({required:true})   （scoped 覆盖全局同名）
 *  - 挑选          tool_pick / tool_catalog / tool_search 三个桥工具
 *  - 装配          agent.ctx.tools.restrict({ allow })          （唯一能真正收窄模型面的接缝）
 *  - 生效时机      本步 toolSet 已冻结 → restrict 对"下一步"生效
 *
 * 不依赖任何 @deepseek-ai 包：本地插件（~/.dsh/plugins/...）没有 node_modules 也能跑。
 */

export const name = 'dsh-tool-picker';
export const inject = ['agents', 'tools', 'systemPrompt'];

const BRIDGES = ['tool_catalog', 'tool_pick', 'tool_search'];

const DEFAULTS = {
  enabled: 'auto',        // auto | on | off        off = 完全不裁（只留目录）
  autoPct: 10,            // auto 模式阈值 A：工具定义占上下文窗口 ≥ 这个百分比才启用（对齐 Claude Code 的 auto:N）
  minToolTokens: 10000,   // auto 模式阈值 B：工具定义绝对 token 数 ≥ 这个值才启用（对齐 Anthropic ">10K tokens 才值得上"的判据）
  thresholdPct: 5,        // 清单预算 = min(thresholdPct% × contextWindow, listingMaxTokens)
  listingMaxTokens: 3000,
  contextWindow: 1_000_000,
  minCatalogSize: 12,     // 目录 ≤ 这个数 → tier 0，不裁
  maxSelected: 40,        // 一次最多加载多少（一个中等任务常要 20-40 个：视频=canvas 35 + motion 13）
  maxWarmTools: 0,        // >0 时：pick 过的工具在 remove 之后仍保留 N 个
  detailChars: 70,        // tier 1 里每条描述的截断长度（中文约 30-35 字，够说清用途）
  core: ['read', 'write', 'edit', 'grep', 'glob', 'win_bash', 'todo_write', 'skill'],
};

const HEADER = [
  '以下工具尚未加载：清单里出现的名字现在不可直接调用。',
  '挑选：tool_pick({add:["名字", ...]})，下一步生效；检索：tool_search({query:"..."});全量：tool_catalog()。',
].join('\n');

/** sessionId -> { selected:Set<string>, disposer?:()=>void, contextDisposer?:()=>void, lastSig:string } */
const SESSIONS = new Map();

const idOf = (agent) => agent?.id ?? agent?.session?.id;
const clip = (text = '', n = 40) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);
/**
 * 粗估 token。中文（CJK）约 1.5-2 字符/token，英文约 3.6 字符/token，
 * 统一按 3.6 折算会把中文描述低估近一半，导致目录误判为"放得下"而实际超预算。
 */
const estTokens = (text) => {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return Math.ceil(cjk / 1.7 + (text.length - cjk) / 3.6);
};
const prefixOf = (toolName) => {
  const at = toolName.indexOf('_');
  return at > 0 ? toolName.slice(0, at) : 'misc';
};

function stateOf(agent) {
  const id = idOf(agent);
  if (id === undefined) return undefined;
  let state = SESSIONS.get(id);
  if (state === undefined) {
    state = { selected: new Set(), disposer: undefined, contextDisposer: undefined, lastSig: '', entries: [] };
    SESSIONS.set(id, state);
  }
  return state;
}

/* ───────────────────────────── 目录 ───────────────────────────── */

/**
 * 该 agent 的完整可见工具。
 * ⚠️ 必须用 agent 作用域取（ctx.tools.schemas(agent)）：无 scope 的全局视图看不到
 * preset / agent 层注册的工具（read / write / edit / grep / glob / todo_write 这类），
 * 拿它当白名单依据会把基础工具全裁掉。
 * 取值前先松开本插件自己的掩码，否则每次量到的是"上一轮裁过"的残留视图。
 */
function refreshEntries(agent, ctx) {
  const state = stateOf(agent);
  if (state === undefined) return [];
  state.disposer?.();
  state.disposer = undefined;
  state.lastSig = '';
  try {
    state.entries = ctx.tools.schemas(agent) ?? [];
  } catch {
    state.entries = [];
  }
  return state.entries;
}

/** 取当前缓存的完整视图；没有就现量一次。 */
function entriesOf(agent, ctx) {
  const state = stateOf(agent);
  if (state !== undefined && Array.isArray(state.entries) && state.entries.length > 0) return state.entries;
  return refreshEntries(agent, ctx);
}

/** 全局兜底视图（拿不到 agent 时用，内容不含 agent 作用域的注册）。 */
function catalog(ctx) {
  try {
    return ctx.tools.schemas() ?? [];
  } catch {
    return [];
  }
}

function budgetOf(cfg) {
  return Math.min((cfg.thresholdPct / 100) * cfg.contextWindow, cfg.listingMaxTokens);
}

/**
 * 该不该裁（auto 模式判据）。
 * 两条取「或」：
 *  A 占比 —— 工具定义占上下文窗口 ≥ autoPct（Claude Code 的 ENABLE_TOOL_SEARCH=auto:N 语义）
 *  B 绝对量 —— 工具定义 ≥ minToolTokens（Anthropic 官方建议：>10K tokens 才值得上）
 * 只按 A 会让 1M 窗口下的 4 万 token 工具面被判成"便宜"（4.1%），而它确实贵；只按 B
 * 会让小窗口场景裁得过猛。两条都在才安心。
 */
function toolTokensOf(entries) {
  let chars = 0;
  for (const entry of entries) {
    chars +=
      (entry.name?.length ?? 0) +
      (entry.description?.length ?? 0) +
      JSON.stringify(entry.parameters ?? {}).length;
  }
  return Math.ceil(chars / 3.6);
}

function shouldSlim(entries, cfg) {
  // YAML 会把不带引号的 off/on 解析成 boolean，两种形态都要认
  if (cfg.enabled === false || cfg.enabled === 'off') return false;
  if (cfg.enabled === true || cfg.enabled === 'on') return true;
  if ((entries?.length ?? 0) <= cfg.minCatalogSize) return false;
  const tokens = toolTokensOf(entries);
  if (tokens >= cfg.minToolTokens) return true;
  const sharePct = (tokens / cfg.contextWindow) * 100;
  return sharePct >= cfg.autoPct;
}

function tierFor(entries, cfg) {
  const budget = budgetOf(cfg);
  const names = estTokens(entries.map((e) => e.name).join('\n'));
  const full = estTokens(entries.map((e) => `${e.name} — ${clip(e.description, cfg.detailChars)}`).join('\n'));
  if (full <= budget) return 1;
  if (names <= budget) return 2;
  return 3;
}

function manifest(entries, loaded, cfg) {
  const rest = entries.filter((e) => !loaded.has(e.name));
  if (rest.length === 0) return '';
  const tier = tierFor(rest, cfg);
  const groups = new Map();
  for (const entry of rest) {
    const key = prefixOf(entry.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const lines = [];
  for (const [group, list] of groups) {
    lines.push(`## ${group} (${list.length})`);
    if (tier === 3) continue;
    for (const entry of list) {
      lines.push(tier === 1 ? `${entry.name} — ${clip(entry.description, cfg.detailChars)}` : entry.name);
    }
  }
  return lines.join('\n');
}

function catalogText(ctx, state, cfg) {
  const entries = state.entries ?? [];
  if (entries.length === 0) return '';
  if (!shouldSlim(entries, cfg)) return '';

  const loaded = new Set([...cfg.core, ...BRIDGES, ...state.selected]);
  const body = manifest(entries, loaded, cfg);
  const visible = [...loaded].filter((n) => entries.some((e) => e.name === n));
  const head = `${HEADER}\n\n已加载（可直接调用）：${visible.join(', ') || '(无)'}`;
  return `<tool-picker catalog>\n${head}\n\n${body || '(全部工具均已加载)'}\n</tool-picker catalog>`;
}

/* ───────────────────────────── 装配 ───────────────────────────── */

function allowOf(state, cfg) {
  const known = new Set((state.entries ?? []).map((e) => e.name));
  const want = new Set([...cfg.core, ...state.selected]);
  const allow = [...want].filter((n) => known.has(n));
  // 桥无条件并入：目录/挑选能力一旦被裁掉，模型就再也无法加载任何工具（死锁）。
  // 若桥此时确实未注册，restrict() 会抛 unknown tool，由调用方兜底成"不裁剪".
  for (const bridge of BRIDGES) if (!allow.includes(bridge)) allow.push(bridge);
  return allow;
}

function applySurface(agent, ctx, cfg) {
  const state = stateOf(agent);
  if (state === undefined) return;
  // 每一步都先松开、重新量完整视图，再决定要不要收紧：
  // 这样既不会因为"已裁过"而越裁越少，也能跟上插件热插拔带来的名字漂移。
  const entries = refreshEntries(agent, ctx);
  if (!shouldSlim(entries, cfg)) {
    state.lastSig = '';
    return;
  }
  const allow = allowOf(state, cfg);
  if (allow.length === 0) return;
  // 注：refreshEntries 已经撤销了上一层掩码，这里必须无条件重建。
  //（工具表最终是否变化由 dsh 的 toolsChanged 判断，不影响缓存命中）
  try {
    state.disposer = agent.ctx.tools.restrict({ allow });
    state.lastSig = allow.join('\u0000');
  } catch (error) {
    state.disposer = undefined;
    state.lastSig = '';
    try {
      ctx.logger?.warn?.(`tool-picker: restrict failed: ${String(error)}`);
    } catch {}
  }
}

function installContext(agent, ctx, cfg) {
  const state = stateOf(agent);
  if (state === undefined || state.contextDisposer !== undefined) return;
  if (typeof agent.ctx?.systemPrompt?.context !== 'function') return;
  try {
    state.contextDisposer = agent.ctx.systemPrompt.context({
      name: 'tool-picker:catalog',
      order: 250,
      required: true, // persona 是 complete section 时，只有 required 的 context 能活下来
      text: () => catalogText(ctx, state, cfg),
    });
  } catch (error) {
    try {
      ctx.logger?.warn?.(`tool-picker: context register failed: ${String(error)}`);
    } catch {}
  }
}

function install(agent, ctx, cfg) {
  if (agent?.ctx?.tools === undefined) return;
  installContext(agent, ctx, cfg);
  applySurface(agent, ctx, cfg);
}

/* ───────────────────────────── 桥工具 ───────────────────────────── */

function textBlocks(text) {
  return [{ type: 'text', text }];
}

function registerCatalogTool(ctx, cfg) {
  ctx.tools.register({
    name: 'tool_catalog',
    description:
      'List the full tool catalog grouped by prefix. Read-only: loading nothing. Use before tool_pick when unsure of exact names.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Optional prefix group to filter, e.g. ffmpeg.' },
      },

    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                group: { type: 'string' },
                tools: { type: 'array', items: { type: 'string' } },
              },
              required: ['group', 'tools'],
            },
          },
        },
        required: ['total', 'groups'],
      },
      render: (_args, value) =>
        textBlocks(
          value.groups
            .map((g) => `## ${g.group} (${g.tools.length})\n${g.tools.join(', ')}`)
            .join('\n\n') + `\n\ntotal: ${value.total}`,
        ),
    },
    async execute(args, exec) {
      const agent = exec?.agent;
      const entries = agent === undefined ? catalog(ctx) : entriesOf(agent, ctx);
      const groups = new Map();
      for (const entry of entries) {
        const group = prefixOf(entry.name);
        if (typeof args?.group === 'string' && args.group.length > 0 && group !== args.group) continue;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(entry.name);
      }
      const out = [...groups].map(([group, tools]) => ({ group, tools }));
      return { total: out.reduce((n, g) => n + g.tools.length, 0), groups: out };
    },
  });
}

function registerPickTool(ctx, cfg) {
  ctx.tools.register({
    name: 'tool_pick',
    description:
      'Load tools into this conversation. Names must come from the catalog. Loading takes effect from the NEXT step, and loaded tools stay across turns until removed or reset.',
    parameters: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string' }, description: 'Tool names to load.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tool names to unload.' },
        reset: { type: 'boolean', description: 'true = keep only core tools and the bridges.' },
      },

    },
    output: {
      schema: {
        type: 'object',
        properties: {
          loaded: { type: 'array', items: { type: 'string' } },
          pending: { type: 'array', items: { type: 'string' } },
          hint: { type: 'string' },
        },
        required: ['loaded', 'pending'],
      },
      render: (_args, value) =>
        textBlocks(
          `loaded (effective next step): ${value.loaded.join(', ') || '(none)'}\n` +
            (value.pending.length > 0 ? `not loaded: ${value.pending.join(', ')}\n` : '') +
            (value.hint ?? ''),
        ),
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error('tool_pick requires an agent');
      const state = stateOf(agent);
      if (state === undefined) throw new Error('tool_pick requires a session-scoped agent');
      const entries = entriesOf(agent, ctx);
      const known = new Set(entries.map((e) => e.name));

      if (args?.reset === true) state.selected.clear();
      for (const toolName of args?.remove ?? []) state.selected.delete(toolName);

      const loaded = [];
      const pending = [];
      for (const toolName of args?.add ?? []) {
        if (typeof toolName !== 'string' || toolName.length === 0) continue;
        if (!known.has(toolName) || BRIDGES.includes(toolName)) {
          pending.push(toolName);
          continue;
        }
        if (state.selected.size >= cfg.maxSelected) {
          pending.push(toolName);
          continue;
        }
        state.selected.add(toolName);
        loaded.push(toolName);
      }

      applySurface(agent, ctx, cfg);
      const hint =
        pending.length > 0
          ? 'Pending names are not in the catalog. Call tool_catalog() or tool_search() to get exact names.'
          : undefined;
      return hint === undefined ? { loaded, pending } : { loaded, pending, hint };
    },
  });
}

function registerSearchTool(ctx, cfg) {
  ctx.tools.register({
    name: 'tool_search',
    description:
      'Search the catalog by keyword (name and description) and return the best matching tool names. Read-only: loading nothing.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, e.g. "cut video" or "screenshot".' },
        limit: { type: 'integer', description: 'Max results, default 8.' },
      },
      required: ['query'],

    },
    output: {
      schema: {
        type: 'object',
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['name', 'description'],
            },
          },
        },
        required: ['matches'],
      },
      render: (_args, value) =>
        textBlocks(value.matches.map((m) => `${m.name} — ${clip(m.description, 80)}`).join('\n') || '(no match)'),
    },
    async execute(args, exec) {
      const query = String(args?.query ?? '')
        .toLowerCase()
        .trim();
      const limit = Math.min(Math.max(Number(args?.limit ?? 8) || 8, 1), 20);
      const terms = query.split(/[\s,，]+/).filter(Boolean);
      const scored = [];
      const agent = exec?.agent;
      for (const entry of agent === undefined ? catalog(ctx) : entriesOf(agent, ctx)) {
        const haystack = `${entry.name} ${entry.description}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (entry.name.toLowerCase() === term) score += 100;
          else if (entry.name.toLowerCase().includes(term)) score += 10;
          else if (haystack.includes(term)) score += 3;
        }
        if (score > 0) scored.push({ entry, score });
      }
      scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
      const matches = scored.slice(0, limit).map(({ entry }) => ({
        name: entry.name,
        description: entry.description ?? '',
      }));
      return { matches };
    },
  });
}

/* ───────────────────────────── 入口 ───────────────────────────── */

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config, core: [...new Set([...(config.core ?? []), ...DEFAULTS.core])] };
  // 关掉 = 彻底不注册：连三个桥和目录 context 都不装，工具面与未安装时完全一致。
  if (cfg.enabled === false || cfg.enabled === 'off') return { cfg, disabled: true };

  registerCatalogTool(ctx, cfg);
  registerPickTool(ctx, cfg);
  registerSearchTool(ctx, cfg);

  const reconcile = (agent) => {
    const state = stateOf(agent);
    if (state === undefined) return;
    // 插件热插拔后名字会漂移：把已消失的名字剔掉，避免 allow 里留死名
    const known = new Set(entriesOf(agent, ctx).map((e) => e.name));
    for (const toolName of [...state.selected]) if (!known.has(toolName)) state.selected.delete(toolName);
    if (state.lastSig !== '' && state.lastSig.split('\u0000').some((n) => !known.has(n))) state.lastSig = '';
    applySurface(agent, ctx, cfg);
  };

  for (const agent of ctx.agents.list()) install(agent, ctx, cfg);
  ctx.on('agent/created', ({ agent }) => install(agent, ctx, cfg));
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (payload?.agent !== undefined) reconcile(payload.agent);
    } catch {}
    return next();
  }, { prepend: true });
  ctx.on('agent/disposed', ({ agent }) => {
    const id = idOf(agent);
    const state = SESSIONS.get(id);
    if (state === undefined) return;
    try {
      state.disposer?.();
    } catch {}
    try {
      state.contextDisposer?.();
    } catch {}
    SESSIONS.delete(id);
  });

  return { cfg, sessions: SESSIONS };
}
