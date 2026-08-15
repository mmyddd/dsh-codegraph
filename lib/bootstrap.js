// 会话开始引导：复用 lazycodex 提取的 cli.js `hook session-start` 全流程
// （精确探测 `.codegraph/codegraph.db` → 祖先覆盖探测 → 每项目原子锁 → 指数退避
// 冷却 → 分离后台 worker 执行 `codegraph init`）。
//
// DSH 插件只负责「何时触发」：项目根目录没有数据库时，把 hook 输入通过 stdin 喂给
// cli.js，剩余决策全部交给 vendored 运行时（与 lazycodex 的 SessionStart hook 等价）。

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {
  CODEGRAPH_BIN_ENV,
  CODEGRAPH_DEBUG_ENV,
  CODEGRAPH_INSTALL_DIR_ENV,
  CODEGRAPH_SESSION_START_CWD_ENV,
  DSH_CODEGRAPH_PROJECT_CWD_ENV,
  BOOTSTRAP_SCHEDULED_NOTICE,
} from './constants.js'
import { probeCodegraphExactDatabase } from './guidance.js'

/**
 * 解析插件应使用的项目根目录。
 * 顺序：config.projectRoot → DSH_CODEGRAPH_PROJECT_CWD 环境变量 → 进程当前目录。
 */
export function resolveProjectRoot(config, env = process.env) {
  if (typeof config.projectRoot === 'string' && config.projectRoot.trim().length > 0) {
    return resolve(config.projectRoot.trim())
  }
  const fromEnv = env[DSH_CODEGRAPH_PROJECT_CWD_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv)
  return process.cwd()
}

/**
 * 把插件配置翻译成 vendored 运行时认的环境变量（serve.js / cli.js 共用）。
 */
export function buildCodegraphEnv(config, projectRoot, env = process.env) {
  const result = { ...env }
  if (typeof config.codegraphBin === 'string' && config.codegraphBin.trim().length > 0) {
    result[CODEGRAPH_BIN_ENV] = config.codegraphBin.trim()
  }
  if (typeof config.installDir === 'string' && config.installDir.trim().length > 0) {
    result[CODEGRAPH_INSTALL_DIR_ENV] = config.installDir.trim()
  }
  result[CODEGRAPH_SESSION_START_CWD_ENV] = projectRoot
  if (env[CODEGRAPH_DEBUG_ENV] === '1') result[CODEGRAPH_DEBUG_ENV] = '1'
  return result
}

// 内存级去重：同一项目在 cli.js 自身锁/冷却之外，避免重复 spawn 决策进程。
const inflightProjects = new Set()

/**
 * 触发后台 codegraph init 引导（决策交给 vendored cli.js）。
 * @returns { { action: 'skipped-initialized' } | { action: 'scheduled' } | { action: 'in-flight' } }
 */
export function maybeScheduleCodegraphBootstrap({ projectRoot, cliPath, env, logger }) {
  const log = logger ?? { info() {}, warn() {}, error() {} }
  if (probeCodegraphExactDatabase(projectRoot)) {
    return { action: 'skipped-initialized' }
  }
  if (inflightProjects.has(projectRoot)) {
    return { action: 'in-flight' }
  }
  inflightProjects.add(projectRoot)

  let child
  try {
    child = spawn(process.execPath, [cliPath, 'hook', 'session-start'], {
      cwd: projectRoot,
      env,
      stdio: ['pipe', 'ignore', 'inherit'],
      windowsHide: true,
    })
  } catch (error) {
    inflightProjects.delete(projectRoot)
    log.error(`dsh-codegraph: failed to spawn codegraph bootstrap: ${String(error)}`)
    return { action: 'spawn-failed', error }
  }

  const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd: projectRoot })
  child.stdin.end(input)

  child.once('error', (error) => {
    inflightProjects.delete(projectRoot)
    log.warn(`dsh-codegraph: codegraph bootstrap process error: ${String(error)}`)
  })
  child.once('exit', (code, signal) => {
    inflightProjects.delete(projectRoot)
    if (code === 0) {
      log.info(BOOTSTRAP_SCHEDULED_NOTICE)
    } else {
      log.warn(`dsh-codegraph: codegraph bootstrap process exited (code=${code ?? 'null'}, signal=${signal ?? ''})`)
    }
  })

  return { action: 'scheduled' }
}
