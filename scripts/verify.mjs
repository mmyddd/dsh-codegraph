#!/usr/bin/env node
// dsh-codegraph 端到端功能验证（不依赖 DSH 运行时）：
//   1. 造一个临时小项目（放在仓库根下，避免 vendored 运行时的 OS 临时目录排除策略）
//   2. 用 vendored cli.js `hook session-start` 触发后台 codegraph init，轮询 .codegraph/codegraph.db
//   3. 用 lib/mcp-client.js（stub ctx.tools）连接 vendored serve.js，列出工具并真实调用 codegraph_explore
//
// 用法：node scripts/verify.mjs

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { McpStdioClient } from '../lib/mcp-client.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const servePath = join(root, 'lib', 'codegraph', 'serve.js')
const cliPath = join(root, 'lib', 'codegraph', 'cli.js')
const scratchRoot = join(root, '.verify-scratch')
const project = join(scratchRoot, 'sample')
const DB = join(project, '.codegraph', 'codegraph.db')
const INIT_WAIT_MS = 120_000

function log(...args) {
  console.log('[verify]', ...args)
}

function makeSampleProject() {
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(
    join(project, 'src', 'greeter.ts'),
    `export class Greeter {
  constructor(private name: string) {}
  greet(): string { return \`Hello, \${this.name}!\` }
}
export function greetAll(names: string[]): string[] { return names.map((n) => new Greeter(n).greet()) }
`,
  )
  writeFileSync(join(project, 'src', 'main.ts'), `import { Greeter } from './greeter'\nconsole.log(new Greeter('world').greet())\n`)
  log('sample project created:', project)
}

async function bootstrapIndex() {
  log('running vendored cli.js hook session-start ...')
  const res = spawnSync(process.execPath, [cliPath, 'hook', 'session-start'], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, OMO_CODEGRAPH_PROJECT_CWD: project },
    input: `${JSON.stringify({ hook_event_name: 'SessionStart', cwd: project })}\n`,
    timeout: 60_000,
  })
  if (res.error !== undefined) throw new Error(`spawn hook failed: ${res.error.message}`)
  log(`hook exited ${res.status}; waiting for ${DB}`)

  const started = Date.now()
  while (Date.now() - started < INIT_WAIT_MS) {
    if (existsSync(DB)) return
    // 简单轮询
    await sleep(1500)
  }
  throw new Error(`codegraph init did not produce ${DB} within ${INIT_WAIT_MS}ms`)
}

async function verifyMcpBridge() {
  log('connecting vendored serve.js via lib/mcp-client.js ...')
  const registered = []
  const stubCtx = {
    tools: {
      register: (def) => {
        registered.push(def)
        return () => {}
      },
    },
    logger: console,
  }
  const client = new McpStdioClient({
    ctx: stubCtx,
    serverName: 'codegraph',
    command: process.execPath,
    args: [servePath],
    cwd: project,
    env: { ...process.env, OMO_CODEGRAPH_PROJECT_CWD: project },
    toolCallTimeoutMs: 120_000,
    logger: { info: log, warn: log, error: log },
  })

  try {
    await client.start()
    const names = registered.map((d) => d.name)
    log('registered tools:', names.join(', '))
    if (names.length === 0) throw new Error('no tools registered from codegraph MCP server')

    const explore = registered.find((d) => d.name === 'mcp__codegraph__codegraph_explore')
    if (explore === undefined) throw new Error('mcp__codegraph__codegraph_explore not registered')

    log('calling codegraph_explore { query: "Greeter greetAll" } ...')
    const result = await explore.execute(
      { query: 'Greeter greetAll', projectPath: project },
      { signal: new AbortController().signal },
    )
    const text = result?.content?.[0]?.text ?? JSON.stringify(result)
    log('explore output preview:')
    console.log(text.slice(0, 600))
    if (!/Greeter/.test(text)) throw new Error('codegraph_explore output did not mention Greeter')
    log('VERIFY OK: bridge registered codegraph_explore and returned real results')
  } finally {
    await client.stop()
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  rmSync(scratchRoot, { recursive: true, force: true })
  try {
    makeSampleProject()
    await bootstrapIndex()
    await verifyMcpBridge()
  } finally {
    // 尽力清理：codegraph 后台 daemon 可能短暂持有项目目录句柄，EPERM 可忽略。
    try {
      rmSync(scratchRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
    log('scratch cleaned')
  }
}

main().catch((error) => {
  console.error('[verify] FAILED:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
