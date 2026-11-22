# dsh-tool-picker

<sub>Progressive tool disclosure for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 中文说明见 [README.zh.md](README.zh.md)</sub>

Hand the model a **tool catalog** first, let it **pick** with `tool_pick`, then send **only the picked tools' schemas** on the next step. Built for large tool surfaces: on a real profile with **207 tools** it cut the per-step tool payload from **~45,400 tokens to ~4,000**.

## Why

DSH injects every registered tool's schema into each model request. With many plugins and MCP servers that is tens of thousands of tokens **per step**, most of it for tools the task never touches.

```
before: 207 tools · 163,480 chars · ≈45,400 tokens / step
after : 11 eager tools + a ~3,000-token catalog + the picked ones
```

## How it works

```
① catalog   ctx.tools.schemas(agent)  → grouped listing, budget-tiered
② present   agent.ctx.systemPrompt.context({required:true})  → runtime context
③ pick      tool_catalog / tool_pick / tool_search
④ apply     agent.ctx.tools.restrict({ allow })  → only core ∪ picked ∪ bridges
```

- **Catalog** is a plain text listing (names, one-line descriptions, grouped by tool-name prefix). It is injected as a runtime context, so a GUI persona prompt can't clobber it.
- **Picking** is structured: `tool_pick({ add: [...], remove: [...], reset?: true })`.
- **Applying** uses `ToolsService.restrict({ allow })`, the only DSH seam that narrows what the model can *see and call*. A whitelist mask, rebuilt from the agent-scoped view each step.
- Loading takes effect on the **next step** (each step's tool set is frozen before the model speaks). That is a property of DSH, not a bug here.

## Install

```sh
# from npm
dsh plugin --profile desktop add dsh-tool-picker

# or from a local checkout
dsh plugin --profile desktop add "link:/path/to/dsh-tool-picker"
```

Then add the bundle to the profile (or let the CLI do it) and restart DSH. The plugin appears in **Settings → Plugins → Installed** with an enable/disable switch, like any other plugin.

Config lives in the plugin's `cordis.patch.yml` (bundle layer) or your profile patch:

```yaml
- insert:
    - id: tool-picker
      name: dsh-tool-picker
      config:
        enabled: "auto"        # auto | on | off   (quote it — bare off parses as boolean false)
        minToolTokens: 10000   # absolute threshold
        autoPct: 10            # or ≥10% of the context window
        thresholdPct: 5        # catalog budget = min(5% × contextWindow, listingMaxTokens)
        listingMaxTokens: 3000
        contextWindow: 1000000
        minCatalogSize: 12
        maxSelected: 40
        detailChars: 70
        core: [read, write, edit, grep, glob, win_bash, todo_write, skill]
```

## Tools it adds

| Tool | Purpose |
|---|---|
| `tool_catalog` | List the full catalog grouped by prefix (read-only) |
| `tool_pick` | Load/unload tools for the next step (`add` / `remove` / `reset`) |
| `tool_search` | Keyword search over the catalog (read-only) |

## Costs and caveats

- **One extra round-trip** on the first step of a task (the model picks, then works). Selections persist across turns, so later turns pay nothing extra.
- **Prompt cache prefix changes** when the tool set changes. Pick once per task; don't churn the selection.
- **Not available on the next step?** Tools you didn't pick return `UNKNOWN_TOOL` if called. The catalog and `tool_pick` results both state the rule.
- Compared to Anthropic's [Tool Search Tool](https://www.anthropic.com/research/advanced-tool-use): that one defers loading **server-side** (`defer_loading`), so the prompt cache survives. DeepSeek's Anthropic-compatible endpoint ignores `defer_loading`, so this plugin narrows the request **client-side** instead — same savings, at the cost of cache churn.

## Design notes

See [DESIGN.md](DESIGN.md) for the source-level mapping (which DSH seam works and which silently does nothing), measurements, and failure modes. Two findings worth repeating:

- Rewriting `assembly.tools` in the `system-prompt/assemble` waterfall is a **no-op** on DSH ≥ 0.2.1-rc.3 (`return { ...transformed, tools }` wins).
- `ctx.tools.schemas()` **without a scope** sees only the global layer — preset/agent-scoped tools (`read`, `write`, `grep`, …) are missing from it. Always measure with `schemas(agent)`.

## License

MIT
