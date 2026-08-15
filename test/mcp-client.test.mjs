import assert from 'node:assert/strict'
import test from 'node:test'

import { extractMcpText, publicToolName } from '../lib/mcp-client.js'

test('publicToolName keeps the clean mcp__server__tool shape', () => {
  assert.equal(publicToolName('codegraph', 'codegraph_explore'), 'mcp__codegraph__codegraph_explore')
})

test('publicToolName normalizes invalid chars deterministically', () => {
  const name = publicToolName('cg', 'explore me!')
  assert.match(name, /^mcp__cg__[A-Za-z0-9_-]+$/)
  assert.ok(name.length <= 64)
  assert.equal(publicToolName('cg', 'explore me!'), publicToolName('cg', 'explore me!'))
})

test('publicToolName truncates long names with a stable hash suffix', () => {
  const raw = `tool-${'x'.repeat(100)}`
  const name = publicToolName('codegraph', raw)
  assert.ok(name.length <= 64)
  assert.match(name, /_[0-9a-f]{12}$/)
  assert.equal(publicToolName('codegraph', raw), publicToolName('codegraph', raw))
})

test('distinct identities never collapse after truncation', () => {
  const rawA = `tool-${'a'.repeat(100)}`
  const rawB = `tool-${'b'.repeat(100)}`
  assert.notEqual(publicToolName('codegraph', rawA), publicToolName('codegraph', rawB))
})

test('extractMcpText joins text blocks and renders placeholders for others', () => {
  const text = extractMcpText([
    { type: 'text', text: 'hello' },
    { type: 'image', mimeType: 'image/png' },
    { type: 'resource' },
    'not-a-block',
  ], 'codegraph_explore')
  assert.match(text, /^hello\n\[image: image\/png, content discarded\]\n\[resource: content discarded\]/)
})

test('extractMcpText reports empty results', () => {
  assert.equal(extractMcpText([], 'codegraph_explore'), '(codegraph_explore returned no text content)')
})
