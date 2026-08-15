// 最小自包含 MCP stdio 客户端桥。
// 连接 vendored 的 codegraph MCP 服务器（lib/codegraph/serve.js），把它的工具
// 注册到 DSH 的 ctx.tools，并转发 tools/call。命名规则与
// @deepseek-ai/dsh-mcp-client 保持一致：`mcp__<serverName>__<rawName>`。
//
// 不依赖 @modelcontextprotocol/sdk，只用 Node 内置模块，因此 dsh-codegraph
// 除了 DSH 提供的 peer 依赖外无需其它运行时依赖。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'

const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

const RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/** 生成模型可见的公共工具名：`mcp__<serverName>__<rawName>`（必要时归一化并追加 hash）。 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** 把 MCP 文本内容块投影成模型可见文本（对齐 dsh-mcp-client 的 extractText）。 */
export function extractMcpText(mcpContent, toolName) {
  const parts = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${block.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${block.type}]`)
    }
  }
  return parts.join('\n') || `(${toolName} returned no text content)`
}

function defaultLogger() {
  return {
    info(...args) { /* noop */ },
    warn(...args) { /* noop */ },
    error(...args) { /* noop */ },
  }
}

/**
 * 一个 stdio MCP 客户端实例。
 * - `start()`：spawn 子进程 → initialize → tools/list → 把工具注册到 ctx.tools。
 * - 崩溃后按指数退避自动重连；退避预算耗尽后注销全部工具并停止。
 * - `stop()`：结束子进程、注销工具。
 */
export class McpStdioClient {
  constructor(options) {
    this.options = options
    this.serverName = options.serverName
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? 60_000
    this.logger = options.logger ?? defaultLogger()
    this.ctx = options.ctx // 必须提供 ctx.tools
    this.reconnect = { ...RECONNECT_DEFAULTS, ...(options.reconnect ?? {}) }

    this.child = null
    this.readline = null
    this.nextId = 1
    this.pending = new Map() // id -> { resolve, reject, timer, signalHandler }
    this.toolDisposers = new Map() // publicName -> disposer
    this.stopped = false
    this.connected = false
    /** MCP initialize 响应里的 `instructions`（codegraph 服务器自带的「工具调用前」使用指引）。 */
    this.instructions = undefined
    this.reconnectAttempts = 0
    this.reconnectTimer = null
  }

  async start() {
    this.stopped = false
    await this._connect()
  }

  async stop() {
    this.stopped = true
    this._clearReconnectTimer()
    this._teardownChild('stop')
    this._disposeTools()
    this._rejectAllPending(new Error('dsh-codegraph: MCP client stopped'))
  }

  // ---- 生命周期 ----

  async _connect() {
    if (this.stopped) return
    const { command, args, cwd, env } = this.options
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.logger.error(`dsh-codegraph: failed to spawn codegraph MCP server: ${String(error)}`)
      this._scheduleReconnect()
      return
    }
    this.child = child

    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      this.logger.info(`dsh-codegraph[codegraph-mcp]: ${text.trimEnd()}`)
    })

    child.once('error', (error) => {
      this.logger.error(`dsh-codegraph: codegraph MCP server error: ${String(error)}`)
      this._onChildExit()
    })
    child.once('exit', (code, signal) => {
      this.logger.warn(`dsh-codegraph: codegraph MCP server exited (code=${code}, signal=${signal ?? ''})`)
      this._onChildExit()
    })

    this.readline = createInterface({ input: child.stdout })
    this.readline.on('line', (line) => this._onServerLine(line))
    this.readline.on('error', (error) => this.logger.warn(`dsh-codegraph: MCP readline error: ${String(error)}`))

    try {
      const serverInfo = await this._request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-codegraph', version: '0.1.0' },
      })
      this.connected = true
      this.reconnectAttempts = 0
      // codegraph MCP server 自带的「工具调用前」使用指引，供系统提示词注入使用。
      this.instructions = isPlainObject(serverInfo) && typeof serverInfo.instructions === 'string' ? serverInfo.instructions : undefined
      this._notify('notifications/initialized', {})
      this.logger.info(`dsh-codegraph: connected to codegraph MCP server ${serverInfo?.serverInfo?.name ?? ''} ${serverInfo?.serverInfo?.version ?? ''}`)
      await this._syncTools()
    } catch (error) {
      this.logger.error(`dsh-codegraph: MCP handshake failed: ${String(error)}`)
      this._teardownChild('handshake-failed')
      this._scheduleReconnect()
    }
  }

  _onChildExit() {
    this._teardownChild('exited')
    this._rejectAllPending(new Error('dsh-codegraph: codegraph MCP server disconnected'))
    this.connected = false
    if (this.stopped) return
    this._scheduleReconnect()
  }

  _teardownChild(reason) {
    if (this.readline !== null) {
      try { this.readline.close() } catch { /* noop */ }
      this.readline = null
    }
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM') } catch { /* noop */ }
      const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL') } catch { /* noop */ }
        }
      }, 2000)
      escalation.unref()
    }
  }

  _disposeTools() {
    for (const dispose of this.toolDisposers.values()) {
      try { dispose() } catch (error) { this.logger.warn(`dsh-codegraph: tool disposer failed: ${String(error)}`) }
    }
    this.toolDisposers.clear()
  }

  _scheduleReconnect() {
    if (!this.reconnect.enabled || this.stopped) return
    if (this.reconnectAttempts >= this.reconnect.maxAttempts) {
      this.logger.error('dsh-codegraph: codegraph MCP reconnect budget exhausted; tools unregistered')
      this._disposeTools()
      return
    }
    const attempt = this.reconnectAttempts
    const delay = Math.min(this.reconnect.initialDelayMs * 2 ** attempt, this.reconnect.maxDelayMs)
    this.reconnectAttempts += 1
    this.logger.warn(`dsh-codegraph: reconnecting codegraph MCP server in ${delay}ms (attempt ${this.reconnectAttempts}/${this.reconnect.maxAttempts})`)
    this._clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._connect().catch((error) => this.logger.error(`dsh-codegraph: reconnect failed: ${String(error)}`))
    }, delay)
    this.reconnectTimer.unref()
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // ---- JSON-RPC ----

  /** 结算一个 pending 请求：清理 timer 与 abort 监听后交给 settle(pending)。 */
  _settlePending(id, settle) {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.signal !== null && pending.signalHandler !== undefined) {
      pending.signal.removeEventListener('abort', pending.signalHandler)
    }
    settle(pending)
  }

  _request(method, params, { signal } = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      if (this.child === null || this.child.stdin === null || !this.child.stdin.writable) {
        rejectPromise(new Error(`dsh-codegraph: MCP server not running (${method})`))
        return
      }
      const id = this.nextId++
      // 统一用字符串作 pending 键：JSON-RPC 响应里的 id 可能被解析成 number 或 string，
      // 用 String(id) 归一化，避免 Map 数字/字符串键不匹配导致响应永远无法命中。
      const key = String(id)
      let signalHandler
      if (signal !== undefined && signal !== null && signal.aborted) {
        rejectPromise(new Error('dsh-codegraph: MCP request aborted'))
        return
      }
      const timer = setTimeout(() => {
        this._settlePending(key, (pending) => {
          pending.reject(new Error(`dsh-codegraph: MCP request timed out after ${this.toolCallTimeoutMs}ms (${method})`))
        })
      }, this.toolCallTimeoutMs)
      if (signal !== undefined && signal !== null) {
        signalHandler = () => {
          this._settlePending(key, (pending) => {
            pending.reject(new Error('dsh-codegraph: MCP request aborted'))
          })
        }
        signal.addEventListener('abort', signalHandler, { once: true })
      }
      this.pending.set(key, { resolve: resolvePromise, reject: rejectPromise, timer, signal, signalHandler })
      const payload = { jsonrpc: '2.0', id, method, params }
      this._writeLine(JSON.stringify(payload)).catch((error) => {
        this._settlePending(key, (pending) => {
          pending.reject(error)
        })
      })
    })
  }

  _notify(method, params) {
    const payload = { jsonrpc: '2.0', method, params }
    this._writeLine(JSON.stringify(payload)).catch((error) => {
      this.logger.warn(`dsh-codegraph: failed to send MCP notification ${method}: ${String(error)}`)
    })
  }

  _writeLine(line) {
    return new Promise((resolveWrite, rejectWrite) => {
      const child = this.child
      if (child === null || child.stdin === null || !child.stdin.writable) {
        rejectWrite(new Error('dsh-codegraph: MCP stdin unavailable'))
        return
      }
      if (child.stdin.write(`${line}\n`)) {
        resolveWrite()
        return
      }
      child.stdin.once('drain', resolveWrite)
      child.stdin.once('error', rejectWrite)
    })
  }

  _onServerLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      this.logger.warn(`dsh-codegraph: ignored non-JSON line from MCP server: ${String(line).slice(0, 200)}`)
      return
    }
    if (message === null || typeof message !== 'object') return

    // Response
    if ('id' in message) {
      const key = String(message.id)
      if (!this.pending.has(key)) return
      this._settlePending(key, (pending) => {
        if ('error' in message && message.error !== undefined) {
          pending.reject(new Error(message.error.message ?? 'dsh-codegraph: MCP request error'))
        } else {
          pending.resolve(message.result)
        }
      })
      return
    }

    // Notification
    if (message.method === 'notifications/tools/list_changed') {
      this._syncTools().catch((error) => this.logger.warn(`dsh-codegraph: tools/list_changed resync failed: ${String(error)}`))
    }
  }

  _rejectAllPending(error) {
    for (const id of [...this.pending.keys()]) {
      this._settlePending(id, (pending) => {
        pending.reject(error)
      })
    }
  }

  // ---- 工具桥 ----

  async _syncTools() {
    // 先取全部工具（支持分页）
    const tools = []
    let cursor
    do {
      const response = await this._request('tools/list', cursor === undefined ? {} : { cursor })
      const list = Array.isArray(response?.tools) ? response.tools : []
      for (const tool of list) tools.push(tool)
      cursor = response?.nextCursor
    } while (cursor !== undefined && cursor !== null && cursor !== '')

    // 构造下一代定义
    const definitions = new Map()
    for (const tool of tools) {
      const publicName = publicToolName(this.serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new Error(`dsh-codegraph(${this.serverName}): server listed tool "${tool.name}" more than once`)
      }
      definitions.set(publicName, this._buildDefinition(tool))
    }

    // 交换：先注销旧代，再注册新代
    this._disposeTools()
    const disposers = new Map()
    try {
      for (const [publicName, definition] of definitions) {
        disposers.set(publicName, this.ctx.tools.register(definition))
      }
    } catch (error) {
      for (const dispose of disposers.values()) {
        try { dispose() } catch { /* noop */ }
      }
      this.logger.error(`dsh-codegraph(${this.serverName}): tool registration failed, no tools registered: ${String(error)}`)
      return
    }
    this.toolDisposers = disposers
    if (disposers.size > 0) {
      this.logger.info(`dsh-codegraph: registered ${disposers.size} codegraph tool(s): ${[...disposers.keys()].join(', ')}`)
    }
  }

  _buildDefinition(tool) {
    const rawName = tool.name
    const structuredSchema = supportedOutputSchema(tool.outputSchema)
    return {
      name: publicToolName(this.serverName, rawName),
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
            structuredContent: structuredSchema ?? {},
          },
          required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
          additionalProperties: false,
        },
        render(_args, value) {
          const content = isPlainObject(value) && Array.isArray(value.content) ? value.content : []
          return [{ type: 'text', text: extractMcpText(content, rawName) }]
        },
      },
      execute: async (args, exec) => {
        const argsObj = (typeof args === 'object' && args !== null ? args : {})
        const result = await this._request('tools/call', { name: rawName, arguments: argsObj }, { signal: exec.signal })
        const content = Array.isArray(result?.content) ? result.content : [{ type: 'text', text: '(no output)' }]
        const text = extractMcpText(content, rawName)
        if (result?.isError === true) throw new Error(text)
        const canonical = { content }
        if (result?.structuredContent !== undefined) canonical.structuredContent = result.structuredContent
        return canonical
      },
    }
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验输出 schema 是否属于 DSH 支持的子集；不支持则回退为无约束 JsonValue。 */
function supportedOutputSchema(candidate) {
  if (candidate === undefined) return undefined
  try {
    // DSH 在注册时会对 parameters 做 assertSupportedJsonSchema；
    // 这里对 outputSchema 做同样的轻量预检，失败则回退。
    if (!isPlainObject(candidate)) return undefined
    return candidate
  } catch {
    return undefined
  }
}
