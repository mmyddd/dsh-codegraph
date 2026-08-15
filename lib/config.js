// dsh-codegraph 插件配置。
// 使用 DSH 标准的 schemastery schema（`export const Config` 会被 Cordis 用作插件配置校验）。

import z from '@deepseek-ai/schemastery'
import { DEFAULT_GUIDANCE_SECTION } from './constants.js'

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * dsh-codegraph 插件配置。
 *
 * 说明：
 * - `enabled=false` 时整个插件（MCP 工具、引导、指引注入）都不生效。
 * - `codegraphBin` / `installDir` 会以 `OMO_CODEGRAPH_BIN` / `CODEGRAPH_INSTALL_DIR`
 *   传给 vendored 的 lazycodex 运行时（serve.js / cli.js）。
 * - vendored 运行时内部的 `auto_provision`、`excluded_roots`、`trusted_install_dir`、
 *   `daemon`、`session_start_cooldown_ms` 等仍由 OMO 配置
 *   （`~/.omo/omo.jsonc` 或项目 `.omo/omo.jsonc`）或默认值决定，插件配置不重复实现。
 */
export const Config = z.object({
  /** 总开关；false 时插件不注册工具、不引导、不注入指引。默认 true。 */
  enabled: z.boolean().default(true),
  /**
   * MCP 服务器命名空间，决定工具名前缀 `mcp__<serverName>__<rawName>`。
   * 默认 `codegraph` → `mcp__codegraph__codegraph_explore`。
   */
  serverName: z.string().pattern(SERVER_NAME_PATTERN).default('codegraph'),
  /**
   * 项目根目录（CodeGraph 索引起点）。
   * 留空时依次使用 `DSH_CODEGRAPH_PROJECT_CWD` 环境变量 → 进程当前目录。
   */
  projectRoot: z.string().default(''),
  /** codegraph 可执行文件路径覆盖（原 `OMO_CODEGRAPH_BIN`）。留空表示自动解析/自动安装。 */
  codegraphBin: z.string().default(''),
  /**
   * 映射为子进程的 `CODEGRAPH_INSTALL_DIR` 环境变量（codegraph 自身数据目录）。
   * 注意：**不是** lazycodex 的 `trusted_install_dir`（后者才改变受管二进制安装目录，
   * 且只从 OMO 配置读取）。需要重定向受管二进制安装目录时，请配置
   * OMO 的 `[codex].codegraph.install_dir`。
   */
  installDir: z.string().default(''),
  /** 是否启动 MCP 桥并注册 codegraph 工具。默认 true。 */
  mcpEnabled: z.boolean().default(true),
  /** 单个 MCP 工具调用的超时（毫秒）。默认 120000。 */
  toolCallTimeoutMs: z.number().min(1).default(120_000),
  /** 会话开始时是否在后台自动执行 codegraph init 引导。默认 true。 */
  bootstrap: z.boolean().default(true),
  /** codegraph 工具结果显示「未初始化」时，是否向下一次请求注入初始化指引。默认 true。 */
  initGuidance: z.boolean().default(true),
  /** 注入系统提示词的 CodeGraph 使用指引文本。 */
  guidanceSection: z.string().default(DEFAULT_GUIDANCE_SECTION),
})
