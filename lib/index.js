// dsh-codegraph —— DeepSeek Harness 插件。
//
// 把 lazycodex（omo 插件）里「向上下文注入 CodeGraph」的能力移植到 DSH：
//  1. 系统提示词注入：CodeGraph 使用指引 section（等价 Codex 的 rules/skill 注入）。
//  2. MCP 工具注入：spawn vendored 的 codegraph MCP 包装器（lib/codegraph/serve.js，
//     提取自 lazycodex components/codegraph/dist/serve.js），把 `codegraph_explore`
//     注册为 `mcp__<serverName>__codegraph_explore`。
//  3. 会话开始自动引导：复用 vendored cli.js `hook session-start`（等价 lazycodex 的
//     SessionStart CodeGraph bootstrap hook），在后台执行 `codegraph init`。
//  4. 结果指引注入：codegraph 工具结果提示「未初始化」时，向下一次请求注入初始化指引
//     （等价 lazycodex 的 PostToolUse CodeGraph init guidance hook）。

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Config } from './config.js'
import { CLI_BUNDLE_REL, SERVED_BUNDLE_REL, isCodegraphToolName } from './constants.js'
import { buildCodegraphEnv, maybeScheduleCodegraphBootstrap, resolveProjectRoot } from './bootstrap.js'
import { buildCodegraphInitGuidanceForToolResult } from './guidance.js'
import { McpStdioClient } from './mcp-client.js'

export const name = 'dsh-codegraph'

/** 插件依赖的 DSH 服务。 */
export const inject = ['tools', 'systemPrompt']

export { Config }

export function apply(ctx, config = {}) {
  // Cordis 已按导出的 Config schema 解析并填入默认值；这里再兜底一次。
  const options = Config(config)
  if (options.enabled !== true) return

  const here = dirname(fileURLToPath(import.meta.url))
  const servePath = join(here, SERVED_BUNDLE_REL)
  const cliPath = join(here, CLI_BUNDLE_REL)
  const projectRoot = resolveProjectRoot(options, process.env)
  const codegraphEnv = buildCodegraphEnv(options, projectRoot)

  // 2) MCP 桥 —— 注册 codegraph 工具（先声明，供系统提示词 provider 动态读取 instructions）。
  let mcpClient = null
  if (options.mcpEnabled) {
    mcpClient = new McpStdioClient({
      ctx,
      serverName: options.serverName,
      command: process.execPath,
      args: [servePath],
      cwd: projectRoot,
      env: codegraphEnv,
      toolCallTimeoutMs: options.toolCallTimeoutMs,
      logger: ctx.logger,
    })
    void mcpClient.start().catch((error) => {
      ctx.logger.warn(`dsh-codegraph: MCP bridge start failed: ${String(error)}`)
    })
  }

  // 1) 系统提示词注入 —— 工具调用前的 CodeGraph 指引。
  //    连接成功后优先使用 codegraph MCP server 自带的 instructions（权威、详尽），
  //    未连接/不可用时回退到配置的默认指引；guidanceSection 置空表示显式关闭。
  ctx.systemPrompt.section({
    name: 'codegraph:policy',
    order: 120, // 工具指引区间 100–199
    text: () => {
      if (options.guidanceSection.trim().length === 0) return ''
      const serverInstructions = mcpClient?.instructions?.trim()
      if (typeof serverInstructions === 'string' && serverInstructions.length > 0) {
        return serverInstructions
      }
      return options.guidanceSection
    },
  })

  // 3) 会话开始自动引导 —— 未初始化时后台执行 codegraph init。
  if (options.bootstrap) {
    ctx.on('agent/session-start', () => {
      try {
        const result = maybeScheduleCodegraphBootstrap({
          projectRoot,
          cliPath,
          env: codegraphEnv,
          logger: ctx.logger,
        })
        if (result.action === 'scheduled') {
          ctx.logger.info('dsh-codegraph: scheduled background codegraph bootstrap for %s', projectRoot)
        }
      } catch (error) {
        ctx.logger.warn(`dsh-codegraph: bootstrap trigger failed: ${String(error)}`)
      }
    })
  }

  // 4) codegraph 工具结果显示「未初始化」→ 向下一次请求注入初始化指引。
  if (options.initGuidance) {
    ctx.on('tools/result', (exec, result) => {
      if (!isCodegraphToolName(exec.name, options.serverName)) return
      if (exec.agent === undefined || exec.agent === null) return
      const toolOutput = textFromToolResult(result)
      const guidance = buildCodegraphInitGuidanceForToolResult(
        { toolName: exec.name, toolOutput, cwd: projectRoot },
        { homeDir: homedir() },
      )
      if (guidance === null) return
      try {
        exec.agent.inject(
          createUserMessage({
            content: [{ type: 'text', text: guidance }],
            source: { kind: 'plugin', plugin: 'dsh-codegraph' },
          }),
        )
      } catch (error) {
        ctx.logger.warn(`dsh-codegraph: failed to inject init guidance: ${String(error)}`)
      }
    })
  }

  // 卸载时停止 MCP 桥。
  ctx.effect(() => () => {
    if (mcpClient !== null) void mcpClient.stop()
  })
}

/** 从 DSH 工具结果里提取模型可见文本，作为「未初始化」检测的输入。 */
function textFromToolResult(result) {
  if (result === undefined || result === null || typeof result !== 'object') return ''
  const content = result.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}
