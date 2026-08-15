# dsh-codegraph

DSH（DeepSeek Harness）host 插件：把 lazycodex（`omo` 插件）里**向上下文注入 CodeGraph**的工具提取出来，移植到 DSH。

> **来源 / Source**：`lazycodex` → `plugins/omo/components/codegraph/`
> （`@sisyphuslabs/codex-codegraph`，CodeGraph MCP 包装 + 引导/初始化指引 hooks）

## 它做了什么

| 能力 | lazycodex（Codex） | dsh-codegraph（DSH） |
| --- | --- | --- |
| 工具注入 | `.mcp.json` 的 `codegraph` MCP server → `codegraph_explore` | spawn vendored `serve.js` 作为 MCP server，把 `codegraph_explore` 注册为 `mcp__codegraph__codegraph_explore` |
| 上下文指引 | SessionStart/PostToolUse hooks 与 skills 注入 CodeGraph 使用说明 | `ctx.systemPrompt.section({ name: 'codegraph:policy' })` 注入系统提示词 |
| 自动索引引导 | SessionStart hook → `codegraph init` | `agent/session-start` → 复用 vendored `cli.js hook session-start` 后台执行 `codegraph init`（含项目锁、指数退避冷却、后台 worker） |
| 未初始化指引 | PostToolUse hook → additionalContext | `tools/result` 监听 codegraph 工具，检测到「未初始化」→ `agent.inject()` 向下一次请求注入指引 |

## 结构

```
dsh-codegraph/
├── package.json          # dsh bundle 插件清单（dsh.bundle.patch = cordis.patch.yml）
├── cordis.patch.yml      # bundle patch：要插入的 loader 行（id: codegraph）
├── dsh.plugin.json       # 插件注册表清单
├── lib/
│   ├── index.js          # host 半 cordis 插件：工具注册 + 提示词注入 + 引导 + 结果指引
│   ├── config.js         # 配置 schema（schemastery）
│   ├── constants.js      # 环境变量名 / 工具名匹配 / 默认指引文本
│   ├── guidance.js       # 「未初始化」检测 + 指引文本（提取自 cli.js 的 guidance.ts）
│   ├── mcp-client.js     # 最小自包含 MCP stdio 客户端桥（无 SDK 依赖）
│   ├── bootstrap.js      # 会话开始引导驱动
│   └── codegraph/        # 从 lazycodex 原样提取的自包含产物（零 Node 外依赖）
│       ├── serve.js      #   codegraph MCP 包装器（自动解析/安装二进制、Node 版本门、unavailable stub）
│       └── cli.js        #   hook CLI（session-start / post-tool-use / session-start-worker）
└── test/                 # node --test 自测
```

`lib/codegraph/serve.js` / `cli.js` 是 lazycodex 构建产物（`bun build` 打成自包含 Node ESM，
无运行时依赖），原样复制，未做改动。

## 挂载（三选一）

```sh
# 1. 本地 link（推荐开发方式）
dsh plugin --profile web add link:C:/Git/dsh-codegraph

# 2. npm 已发布后
dsh plugin --profile web add dsh-codegraph

# 3. 手动改 profile（~/.dsh/profiles/web/）
#    package.json dependencies 加 "dsh-codegraph": "^0.1.0"
#    dsh.profile.bundles 追加 "dsh-codegraph"
#    cordis.patch.yml 追加：
#    - insert:
#        - id: codegraph
#          name: 'dsh-codegraph'
```

挂载后 `pnpm install`（profile 目录），**完全退出并重开 DSH web**（bundle 型插件需要重启加载），
然后重启会话。模型侧应能看到 `mcp__codegraph__codegraph_explore` 工具。

## 配置

通过 profile 的 `cordis.patch.yml` 里的 loader 行 `config:` 传入，或在代码里以
`{ name: 'dsh-codegraph', config: {...} }` 方式加载：

```yaml
- insert:
    - id: codegraph
      name: 'dsh-codegraph'
      config:
        enabled: true
        serverName: codegraph
        projectRoot: ''            # 留空 = DSH_CODEGRAPH_PROJECT_CWD → 进程 cwd
        codegraphBin: ''           # 二进制路径覆盖（原 OMO_CODEGRAPH_BIN）
        installDir: ''             # 受管安装目录（原 CODEGRAPH_INSTALL_DIR），默认 ~/.omo/codegraph
        mcpEnabled: true
        toolCallTimeoutMs: 120000
        bootstrap: true
        initGuidance: true
        # guidanceSection: '自定义系统提示词指引…'
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `serverName` | string | `codegraph` | 工具名前缀 `mcp__<serverName>__…` |
| `projectRoot` | string | `''` | CodeGraph 索引起点；留空自动 |
| `codegraphBin` | string | `''` | 二进制覆盖（原 `OMO_CODEGRAPH_BIN`） |
| `installDir` | string | `''` | 受管安装目录（原 `CODEGRAPH_INSTALL_DIR`） |
| `mcpEnabled` | boolean | `true` | 是否注册 MCP 工具 |
| `toolCallTimeoutMs` | number | `120000` | 单次工具调用超时 |
| `bootstrap` | boolean | `true` | 会话开始后台 `codegraph init` |
| `initGuidance` | boolean | `true` | 未初始化时注入指引 |
| `guidanceSection` | string | 内置 | 系统提示词里的 CodeGraph 指引 |

> 注意：vendored 运行时内部的 `auto_provision`、`session_start_cooldown_ms`、
> `trustedCodegraphInstallDir` 等仍由 OMO 配置（`~/.omo/omo.jsonc` 或项目 `.omo/omo.jsonc`）或
> 其默认值决定；插件配置不重复实现，只通过环境变量（`OMO_CODEGRAPH_BIN` / `CODEGRAPH_INSTALL_DIR`）
> 覆盖二进制与安装目录。

## 验证

```sh
# 1) 单元自测（纯 Node，无 DSH 依赖）
cd C:/Git/dsh-codegraph && node --test test/*.test.mjs

# 2) 冒烟：用假 codegraph 二进制跑一遍 vendored MCP 包装器（test/serve-smoke.test.mjs）

# 3) 在 DSH 里
dsh web --dump-config | grep codegraph      # 组合里能看到插件行
```

重启后在任意会话里问「用 codegraph 看看 X 是怎么工作的」，模型应优先调用
`mcp__codegraph__codegraph_explore`。若项目未索引，会看到后台 bootstrap 生成 `.codegraph/`，
且工具结果会附带初始化指引。

## 环境变量（透传给 vendored 运行时）

| 变量 | 说明 |
| --- | --- |
| `OMO_CODEGRAPH_BIN` / `CODEGRAPH_BIN` | codegraph 可执行文件路径覆盖 |
| `OMO_CODEGRAPH_PROJECT_CWD` / `OMO_CODEGRAPH_SESSION_START_CWD` | 项目根目录覆盖 |
| `CODEGRAPH_INSTALL_DIR` | 受管安装目录（默认 `~/.omo/codegraph`） |
| `OMO_CODEGRAPH_DEBUG=1` | 打开 vendored 运行时调试日志 |
| `DSH_CODEGRAPH_PROJECT_CWD` | 插件专用项目根目录覆盖（优先级低于 `config.projectRoot`） |

## 与 lazycodex 的映射

| lazycodex 文件 | 本仓库 |
| --- | --- |
| `plugins/omo/components/codegraph/dist/serve.js` | `lib/codegraph/serve.js`（原样复制） |
| `plugins/omo/components/codegraph/dist/cli.js` | `lib/codegraph/cli.js`（原样复制） |
| `src/post-tool-use-hook.ts` + `utils/src/codegraph/guidance.ts` | `lib/guidance.js`（提取 + DSH 化文本） |
| `src/hook.ts` / `src/session-start-worker.ts`（SessionStart 引导） | `lib/bootstrap.js` + 复用 `cli.js hook session-start` |
| `.codex-plugin/plugin.json` hooks | `lib/index.js` 的 `ctx.systemPrompt` / `agent/session-start` / `tools/result` |
| `.mcp.json` server `codegraph` | `lib/mcp-client.js`（DSH 侧 MCP 客户端桥） |

## 许可

本仓库的插件胶水代码为 MIT（见 `LICENSE`）；`lib/codegraph/` 下的构建产物与其
`NOTICE` / `NODE-RUNTIME-LICENSES.md` 一并保留 lazycodex / OmO 的原始归属与第三方许可声明。
