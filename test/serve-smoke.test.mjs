import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { fileURLToPath } from 'node:url'

const MCP_SMOKE_TIMEOUT_MS = 45_000
const servePath = fileURLToPath(new URL('../lib/codegraph/serve.js', import.meta.url))

// vendored serve.js 在 Windows 上默认把 OS 临时目录加入排除策略，
// 因此测试目录要放在仓库根（当前工作目录）下，而不是 os.tmpdir()。
const smokeRoot = process.cwd()

test('#given vendored codegraph MCP wrapper #when an MCP client initializes #then the resolved child responds over stdio', () => {
  const tempRoot = mkdtempSync(join(smokeRoot, '.dsh-cg-smoke-'))
  try {
    const fakeBinaryPath = join(tempRoot, 'codegraph-fake.cjs')
    writeFileSync(
      fakeBinaryPath,
      [
        '#!/usr/bin/env node',
        "const readline = require('node:readline');",
        'const rl = readline.createInterface({ input: process.stdin });',
        "rl.on('line', (line) => {",
        '  const request = JSON.parse(line);',
        "  if (request.method !== 'initialize') return;",
        '  process.stdout.write(JSON.stringify({',
        "    jsonrpc: '2.0',",
        '    id: request.id,',
        '    result: {',
        "      protocolVersion: request.params?.protocolVersion ?? '2024-11-05',",
        '      capabilities: { tools: { listChanged: false } },',
        "      serverInfo: { name: 'fake-codegraph', version: '0.0.0' }",
        '    }',
        '  }) + \'\\n\');',
        '});',
        '',
      ].join('\n'),
    )
    chmodSync(fakeBinaryPath, 0o755)

    const result = spawnSync(process.execPath, [servePath], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMO_CODEGRAPH_BIN: fakeBinaryPath,
      },
      input: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: { name: 'dsh-codegraph-smoke', version: '0.0.0' },
          protocolVersion: '2024-11-05',
        },
      })}\n`,
      timeout: MCP_SMOKE_TIMEOUT_MS,
    })

    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    const response = JSON.parse(result.stdout.trim())
    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: { tools: { listChanged: false } },
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'fake-codegraph', version: '0.0.0' },
      },
    })
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
