import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { McpStdioClient } from '../lib/mcp-client.js'

const servePath = fileURLToPath(new URL('../lib/codegraph/serve.js', import.meta.url))
const smokeRoot = process.cwd()

// 回归测试：McpStdioClient 的完整 I/O 链路（spawn serve.js → initialize → tools/list → tools/call）。
// 曾因 pending 请求用数字键、响应查找用字符串键（Map 严格相等）导致所有请求超时；本测试可捕获该回归。
test('McpStdioClient connects, registers codegraph_explore and executes a call', async () => {
  const tmp = mkdtempSync(join(smokeRoot, '.io-test-'))
  try {
    const fake = join(tmp, 'fake.cjs')
    writeFileSync(
      fake,
      [
        '#!/usr/bin/env node',
        "const readline = require('node:readline');",
        'const rl = readline.createInterface({ input: process.stdin });',
        "rl.on('line', (line) => {",
        '  const req = JSON.parse(line);',
        '  if (req.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-codegraph", version: "0.0.0" } } }) + "\\n");',
        '    return;',
        '  }',
        '  if (req.method === "tools/list") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "codegraph_explore", description: "fake explore", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] } }) + "\\n");',
        '    return;',
        '  }',
        '  if (req.method === "tools/call") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "fake result" }] } }) + "\\n");',
        '    return;',
        '  }',
        '});',
      ].join('\n'),
    )
    chmodSync(fake, 0o755)

    const registered = []
    const client = new McpStdioClient({
      ctx: {
        tools: {
          register: (def) => {
            registered.push(def)
            return () => {}
          },
        },
        logger: console,
      },
      serverName: 'codegraph',
      command: process.execPath,
      args: [servePath],
      cwd: tmp,
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp, OMO_CODEGRAPH_BIN: fake },
      toolCallTimeoutMs: 20_000,
      logger: { info() {}, warn() {}, error() {} },
    })

    try {
      await client.start()
      assert.deepEqual(
        registered.map((d) => d.name),
        ['mcp__codegraph__codegraph_explore'],
      )
      const def = registered[0]
      const result = await def.execute({ query: 'x' }, { signal: new AbortController().signal })
      assert.equal(result.content[0].text, 'fake result')
    } finally {
      await client.stop()
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
