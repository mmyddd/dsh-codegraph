// codegraph「未初始化」检测与初始化指引。
// 这是从 lazycodex components/codegraph/dist/cli.js 中提取的纯逻辑
// （原 utils/src/codegraph/guidance.ts），DSH 化后只改写提示文本，检测规则保持一致。
//
// 用法：在 codegraph 工具结果（tools/result 或 tools/post-execute）上调用
// `buildCodegraphInitGuidanceForToolResult({ toolName, toolOutput, cwd }, { homeDir })`，
// 返回 null 表示无需注入，否则返回指引文本。

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const CODEGRAPH_UNINITIALIZED_PATTERN = /CodeGraph not initialized in ([\s\S]*?)\.\s*Run ['`]codegraph init['`] in that project first\./i
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const CODEGRAPH_STATUS_PROJECT_PATTERN = /^.*?\bProject:\s*(.+?)\s*$/im
const CODEGRAPH_STATUS_UNINITIALIZED_PATTERN = /^.*?\bNot initialized\s*$/im
const CODEGRAPH_INIT_HINT_PATTERN = /Run\s+["'`]codegraph init["'`]\s+(?:in that project first|to initialize)\.?/i
const CODEGRAPH_PROJECT_NOT_INDEXED_PATTERN = /The project at (.+?) isn't indexed with codegraph\b/i
const CODEGRAPH_NO_PROJECT_LOADED_PATTERN = /No CodeGraph project is loaded for this session\./i
const CODEGRAPH_NO_PROJECT_SEARCHED_FROM_PATTERN = /^Searched for a \.codegraph\/ directory starting from:\s*(.+?)\s*$/im

/**
 * 从一次 codegraph 工具结果里判断「未初始化」项目根目录。
 * @param input { toolName, toolOutput, cwd }
 * @returns 项目路径或 null
 */
export function getCodegraphUninitializedProject(input) {
  const output = textFromUnknown(input?.toolOutput)
  if (!isCodegraphTool(input?.toolName)) return null
  const projectPath = extractProjectPath(output)
  if (projectPath !== null) return projectPath
  if (!looksLikeCodegraphUninitializedOutput(output)) return null
  return typeof input.cwd === 'string' && input.cwd.trim().length > 0 ? input.cwd.trim() : null
}

/**
 * 构造一条 DSH 化的 CodeGraph 初始化指引文本。
 * @param projectPath 未初始化项目的绝对路径
 * @param options.homeDir 用户主目录（默认 os.homedir()）
 */
export function buildCodegraphInitGuidance(projectPath, options = {}) {
  const { dataDir, dataRoot, projectLink } = resolveCodegraphWorkspacePaths(projectPath, {
    homeDir: options.homeDir ?? homedir(),
  })
  const displayProjectPath = formatDisplayPath(projectPath)
  const displayProjectLink = formatDisplayPath(projectLink)
  const displayDataDir = formatDisplayPath(dataDir)
  const displayDataRoot = formatDisplayPath(dataRoot)
  return [
    'dsh-codegraph initialization guidance:',
    '',
    `CodeGraph is not initialized for ${displayProjectPath}.`,
    '',
    `- Link or create ${displayProjectLink} so it points at ${displayDataDir} under the codegraph store ${displayDataRoot}.`,
    `- Then run \`codegraph init\` from ${displayProjectPath} and retry the codegraph tool.`,
    "- dsh-codegraph's session-start bootstrap does this automatically; if bootstrap just ran, wait for it to finish and retry.",
  ].join('\n')
}

/**
 * 针对一次 codegraph 工具结果构造指引；无需注入时返回 null。
 */
export function buildCodegraphInitGuidanceForToolResult(input, options = {}) {
  const projectPath = getCodegraphUninitializedProject(input)
  return projectPath === null ? null : buildCodegraphInitGuidance(projectPath, options)
}

// ---- 提取自原实现 ----

function extractProjectPath(output) {
  const normalizedOutput = normalizeCodegraphOutput(output)
  const uninitializedMatch = normalizedOutput.match(CODEGRAPH_UNINITIALIZED_PATTERN)
  const uninitializedProject = uninitializedMatch?.[1]?.trim()
  if (uninitializedProject && uninitializedProject.length > 0) return uninitializedProject
  const notIndexedMatch = normalizedOutput.match(CODEGRAPH_PROJECT_NOT_INDEXED_PATTERN)
  const notIndexedProject = notIndexedMatch?.[1]?.trim()
  if (notIndexedProject && notIndexedProject.length > 0) return notIndexedProject
  if (CODEGRAPH_NO_PROJECT_LOADED_PATTERN.test(normalizedOutput)) {
    const searchedFromMatch = normalizedOutput.match(CODEGRAPH_NO_PROJECT_SEARCHED_FROM_PATTERN)
    const searchedFromProject = searchedFromMatch?.[1]?.trim()
    if (searchedFromProject && searchedFromProject.length > 0) return searchedFromProject
  }
  if (!looksLikeCodegraphUninitializedOutput(normalizedOutput)) return null
  const statusMatch = normalizedOutput.match(CODEGRAPH_STATUS_PROJECT_PATTERN)
  const statusProject = statusMatch?.[1]?.trim()
  return statusProject && statusProject.length > 0 ? statusProject : null
}

function looksLikeCodegraphUninitializedOutput(output) {
  const normalizedOutput = normalizeCodegraphOutput(output)
  if (normalizedOutput.match(CODEGRAPH_UNINITIALIZED_PATTERN) !== null) return true
  return CODEGRAPH_STATUS_UNINITIALIZED_PATTERN.test(normalizedOutput) && CODEGRAPH_INIT_HINT_PATTERN.test(normalizedOutput)
}

function normalizeCodegraphOutput(output) {
  return output.replace(ANSI_ESCAPE_PATTERN, '')
}

function isCodegraphTool(toolName) {
  if (typeof toolName !== 'string') return false
  return toolName.startsWith('codegraph.') || toolName.startsWith('codegraph_') || toolName.startsWith('mcp__codegraph__')
}

function formatDisplayPath(value) {
  return JSON.stringify(value)
}

function textFromUnknown(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join('\n')
  if (!isRecord(value)) return ''
  return Object.entries(value)
    .map(([key, nested]) => `${key}: ${textFromUnknown(nested)}`)
    .filter((line) => line.trim().length > 0)
    .join('\n')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---- 与 lazycodex utils/src/codegraph/workspace.ts 的路径约定一致 ----

function codegraphDataRoot(homeDir) {
  return join(homeDir, '.omo', 'codegraph')
}

function canonicalizeCodegraphPath(path) {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  } catch (error) {
    if (error instanceof Error) return resolved
    throw error
  }
}

function sanitizeBase(value) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-')
  return sanitized.length > 0 ? sanitized : 'workspace'
}

function workspaceStorageName(workspace) {
  const resolved = canonicalizeCodegraphPath(workspace)
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 16)
  return `${sanitizeBase(basename(resolved))}-${hash}`
}

export function resolveCodegraphWorkspacePaths(workspace, options = {}) {
  const resolvedWorkspace = canonicalizeCodegraphPath(workspace)
  const dataRoot = codegraphDataRoot(options.homeDir ?? homedir())
  return {
    dataDir: join(dataRoot, 'projects', workspaceStorageName(resolvedWorkspace)),
    dataRoot,
    projectLink: join(resolvedWorkspace, '.codegraph'),
  }
}

/** 精确探测：项目根目录是否存在 codegraph 数据库文件。 */
export function probeCodegraphExactDatabase(projectRoot) {
  return existsSync(join(projectRoot, '.codegraph', 'codegraph.db'))
}
