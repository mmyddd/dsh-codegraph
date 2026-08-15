// dsh-codegraph 共享常量。
// 这些常量与原 lazycodex components/codegraph（omo）保持一致的命名，
// 便于复用其自包含的 dist/serve.js 与 dist/cli.js 运行时约定。

/** vendored codegraph 包装器相对本包 lib/ 的位置 */
export const SERVED_BUNDLE_REL = './codegraph/serve.js'
export const CLI_BUNDLE_REL = './codegraph/cli.js'

/** 从 lazycodex 提取的包装器使用的环境变量 */
export const CODEGRAPH_BIN_ENV = 'OMO_CODEGRAPH_BIN'
export const CODEGRAPH_LEGACY_BIN_ENV = 'CODEGRAPH_BIN'
export const CODEGRAPH_PROJECT_CWD_ENV = 'OMO_CODEGRAPH_PROJECT_CWD'
export const CODEGRAPH_SESSION_START_CWD_ENV = 'OMO_CODEGRAPH_SESSION_START_CWD'
export const CODEGRAPH_INSTALL_DIR_ENV = 'CODEGRAPH_INSTALL_DIR'
export const CODEGRAPH_DEBUG_ENV = 'OMO_CODEGRAPH_DEBUG'

/** 插件私有覆盖变量（DSH 侧新增，不影响 vendored 运行时） */
export const DSH_CODEGRAPH_PROJECT_CWD_ENV = 'DSH_CODEGRAPH_PROJECT_CWD'

/**
 * 判定一个模型可见的工具名是否属于 codegraph 命名空间。
 * 匹配 `codegraph_*` / `mcp__<serverName>__*`（不含 lazycodex 旧命名空间）。
 */
export function isCodegraphToolName(toolName, serverName = 'codegraph') {
  if (typeof toolName !== 'string' || toolName.length === 0) return false
  if (toolName.startsWith('codegraph') || toolName.startsWith('codegraph_')) return true
  if (toolName.startsWith('mcp__')) return toolName.includes(`mcp__${serverName}__`)
  return false
}

/**
 * 默认注入到系统提示词的 CodeGraph 使用指引。
 * 脱胎于上游 @colbymchenry/codegraph 的 CODEGRAPH_INSTRUCTIONS_BLOCK 与
 * lazycodex 的 ulw-plan/ultrawork 技能，DSH 化后指向 `mcp__codegraph__codegraph_explore`。
 */
export const DEFAULT_GUIDANCE_SECTION = [
  '## CodeGraph',
  '',
  '在已被 CodeGraph 索引的仓库（根目录存在 `.codegraph/`）里，需要理解或定位代码时，优先用 `mcp__codegraph__codegraph_explore`，再考虑 grep/find/直接读文件：',
  '',
  '- **一次调用回答大多数问题**：返回相关符号的逐字源码（按文件分组，视为已 Read，不要重复打开）以及它们之间的调用路径，包括 grep 追不上的动态分发（callback / 事件 / 反射等）。',
  '- **按名字查询**：在 query 里写符号名或文件名即可读取对应文件当前带行号的源码；结果被延迟加载时，再用名字查询加载。',
  '- **Shell 兜底**：`codegraph explore "<符号名或问题>"` 输出同样的结果。',
  '',
  '如果根目录没有 `.codegraph/`，说明该仓库未索引 —— 不要自行猜测；`codegraph init` 是用户的决定（本插件的会话引导会在后台自动初始化）。',
  '',
].join('\n')

/** 会话开始后台引导的提示语（写日志用，不注入模型上下文） */
export const BOOTSTRAP_SCHEDULED_NOTICE = 'dsh-codegraph: CodeGraph bootstrap scheduled in background'
