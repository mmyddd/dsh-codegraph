import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildCodegraphInitGuidance,
  buildCodegraphInitGuidanceForToolResult,
  getCodegraphUninitializedProject,
  probeCodegraphExactDatabase,
} from '../lib/guidance.js'

test('detects the "CodeGraph not initialized in ..." error and returns the project', () => {
  const output = 'CodeGraph not initialized in /repo/src. Run `codegraph init` in that project first.'
  const project = getCodegraphUninitializedProject({
    toolName: 'mcp__codegraph__codegraph_explore',
    toolOutput: output,
    cwd: '/repo',
  })
  assert.equal(project, '/repo/src')
})

test('detects "isn\'t indexed with codegraph" output', () => {
  const output = "The project at /work/app isn't indexed with codegraph"
  const project = getCodegraphUninitializedProject({
    toolName: 'codegraph_explore',
    toolOutput: output,
    cwd: '/work',
  })
  assert.equal(project, '/work/app')
})

test('falls back to cwd when the output merely looks uninitialized', () => {
  const output = 'Project: /work\nStatus: Not initialized\nRun "codegraph init" to initialize.'
  const project = getCodegraphUninitializedProject({
    toolName: 'codegraph_explore',
    toolOutput: output,
    cwd: '/work',
  })
  assert.equal(project, '/work')
})

test('returns null for non-codegraph tools', () => {
  const project = getCodegraphUninitializedProject({
    toolName: 'read',
    toolOutput: 'CodeGraph not initialized in /x. Run `codegraph init` in that project first.',
    cwd: '/x',
  })
  assert.equal(project, null)
})

test('returns null for initialized output', () => {
  const project = getCodegraphUninitializedProject({
    toolName: 'codegraph_explore',
    toolOutput: 'Found 12 symbols across 3 files.',
    cwd: '/repo',
  })
  assert.equal(project, null)
})

test('buildCodegraphInitGuidanceForToolResult returns guidance text for uninitialized', () => {
  const guidance = buildCodegraphInitGuidanceForToolResult({
    toolName: 'codegraph_explore',
    toolOutput: 'CodeGraph not initialized in /repo. Run `codegraph init` in that project first.',
    cwd: '/repo',
  }, { homeDir: '/home/u' })
  assert.equal(typeof guidance, 'string')
  assert.match(guidance, /dsh-codegraph initialization guidance:/)
  assert.match(guidance, /codegraph init/)
})

test('buildCodegraphInitGuidanceForToolResult returns null when initialized', () => {
  const guidance = buildCodegraphInitGuidanceForToolResult({
    toolName: 'codegraph_explore',
    toolOutput: 'Found 3 symbols.',
    cwd: '/repo',
  })
  assert.equal(guidance, null)
})

test('buildCodegraphInitGuidance renders store paths', () => {
  const text = buildCodegraphInitGuidance('/repo', { homeDir: '/home/u' })
  // 平台相关：Windows 上 node:path 会输出反斜杠，这里只断言关键片段。
  assert.ok(text.includes('projects'), `expected store path, got: ${text}`)
  assert.ok(text.includes('.codegraph'), `expected project link, got: ${text}`)
  assert.match(text, /codegraph init/)
})

test('probeCodegraphExactDatabase only matches an exact project database', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codegraph-probe-'))
  try {
    assert.equal(probeCodegraphExactDatabase(root), false)
    mkdirSync(join(root, '.codegraph'))
    writeFileSync(join(root, '.codegraph', 'codegraph.db'), 'x')
    assert.equal(probeCodegraphExactDatabase(root), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
