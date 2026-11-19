/**
 * dsh-financial-skills —— 本机安装目录：扫描、安装、卸载
 *
 * 磁盘布局（全部相对安装根，默认 `<dshHome>/skills`）：
 *
 *   <installRoot>/<id>/SKILL.md              目录形态技能（官方推荐）
 *   <installRoot>/<id>.md                    平铺形态技能（只读识别，不做安装）
 *   <installRoot>/<id>/.financial-skills.json 本插件写入的来源记录
 *   <installRoot>/.staging-<id>-<rand>/      安装暂存区（成功后整目录 rename）
 *   <installRoot>/.trash/<id>-<ts>/          卸载归档（只移不删）
 *
 * 安装流程先把全部文件写进暂存区并逐项校验（文件数 / 单文件 / 总量 / 相对路径
 * 文法），全部通过才 rename 到目标目录；任何一步失败都会清掉暂存区，目标路径上
 * 的磁盘状态保持原样。目标已存在时返回 409，绝不覆盖。
 *
 * format 3 起正文不在上游仓库里，安装 / 详情按技能来源分发：
 *   - github  → 目录清单 + 逐文件 raw（见 lib/github.js）；
 *   - skillhub → zip 下载 + 进程内解压（见 lib/skillhub.js）。
 *
 * @module dsh-financial-skills/store
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

import { DEFAULT_RESOLVE, isValidId } from './catalog.js'
import { isSafeRelativePath, SOURCE_REPO_LABEL } from './github.js'

/** 安装上限默认值。 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
})

/** 来源记录文件名。 */
export const PROVENANCE_FILE = '.financial-skills.json'

/** 卸载归档目录名。 */
export const TRASH_DIR = '.trash'

/** 安装暂存目录前缀。 */
export const STAGING_PREFIX = '.staging-'

/** 安装 / 卸载过程中的可映射错误。 */
export class StoreError extends Error {
  /**
   * @param {string} code 稳定错误码。
   * @param {string} message 可读文案。
   * @param {number} status 建议的 HTTP 状态码。
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.status = typeof status === 'number' ? status : 500
  }
}

/** 正数回落。 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 调一次 logger（没有 logger 时静默）。 */
function warn(logger, message) {
  try {
    if (logger && typeof logger.warn === 'function') logger.warn(message)
  } catch {
    /* 日志本身不能影响主流程 */
  }
}

/**
 * 解析用户配置根。
 *
 * 优先级：显式配置 > `DSH_FINANCIAL_SKILLS_HOME` > `DSH_HOME` > `~/.dsh`。
 * 非法值一律回落，绝不因为配置写错把插件 boot 打断。
 *
 * @param {unknown} configured 插件配置里的 dshHome。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  const own = env !== undefined && env !== null ? env.DSH_FINANCIAL_SKILLS_HOME : undefined
  if (typeof own === 'string' && own.trim() !== '') return resolve(own.trim())
  const shared = env !== undefined && env !== null ? env.DSH_HOME : undefined
  if (typeof shared === 'string' && shared.trim() !== '') return resolve(shared.trim())
  return join(homedir(), '.dsh')
}

/**
 * 解析安装根。
 *
 * 优先级：显式配置 > `DSH_FINANCIAL_SKILLS_INSTALL_ROOT` > `<dshHome>/skills`。
 *
 * @param {unknown} configured 插件配置里的 installRoot。
 * @param {string} dshHome 用户配置根。
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 绝对路径。
 */
export function resolveInstallRoot(configured, dshHome, env = process.env) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  const own = env !== undefined && env !== null ? env.DSH_FINANCIAL_SKILLS_INSTALL_ROOT : undefined
  if (typeof own === 'string' && own.trim() !== '') return resolve(own.trim())
  return join(dshHome, 'skills')
}

/**
 * 判断 candidate 是否落在 root 内部（严格位于其下，不含 root 本身）。
 *
 * 写盘前用它做最后一道路径逃逸检查，防止任何拼出来的路径跑到安装根外面。
 *
 * @param {string} root 安装根。
 * @param {string} candidate 目标路径。
 * @returns {boolean} 是否在内部。
 */
export function isWithinRoot(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false
  const rootResolved = resolve(root)
  const candidateResolved = resolve(candidate)
  return candidateResolved !== rootResolved && candidateResolved.startsWith(rootResolved + sep)
}

/** 去掉标量两侧的引号。 */
function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/** 需要从 frontmatter 里读出的字段。 */
const FRONTMATTER_KEYS = new Set(['name', 'description', 'version'])

/**
 * 解析 SKILL.md 的 frontmatter。
 *
 * 只关心 name / description / version 三个字段，支持行内值与 `|` / `>` 块标量；
 * 解析失败按"没有 frontmatter"处理，扫描不能因为某个技能文件写坏而整体失败。
 *
 * @param {unknown} content SKILL.md 全文。
 * @returns {{ name?: string, description?: string, version?: string }} 解析结果。
 */
export function parseFrontmatter(content) {
  if (typeof content !== 'string') return {}
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (match === null) return {}
  const lines = match[1].split(/\r?\n/)
  const out = {}
  for (let index = 0; index < lines.length; index += 1) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index])
    if (pair === null) continue
    const key = pair[1]
    if (!FRONTMATTER_KEYS.has(key) || out[key] !== undefined) continue
    const rest = pair[2].trim()
    if (rest === '') continue
    if (/^[|>][-+]?$/.test(rest)) {
      const collected = []
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor]
        if (line === '' || /^\s/.test(line)) {
          collected.push(line.trim())
          continue
        }
        break
      }
      const text = collected.join(' ').trim()
      if (text !== '') out[key] = text
      continue
    }
    out[key] = unquote(rest)
  }
  return out
}

/**
 * 去掉 SKILL.md 开头的 frontmatter 块。
 *
 * 详情接口要的是"正文"：frontmatter 是元信息（name/description 等），
 * 混进 Markdown 渲染只会变成一串 `---` 与 YAML 行。
 *
 * @param {unknown} content SKILL.md 全文。
 * @returns {string} 去掉 frontmatter 后的正文。
 */
export function stripFrontmatter(content) {
  if (typeof content !== 'string') return ''
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content)
  return match === null ? content : content.slice(match[0].length)
}

/** stat 包装：不存在返回 undefined。 */
async function statOrUndefined(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/** 把各种时间写法收敛成毫秒数；认不出来就 undefined。 */
function normalizeInstalledAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 读一个技能目录的来源记录。 */
async function readProvenance(directory) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(join(directory, PROVENANCE_FILE), 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed
}

/** 读一个技能文件的 frontmatter；读不到按空对象处理。 */
async function readFrontmatter(file) {
  try {
    return parseFrontmatter(await readFile(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 扫描安装根下的技能。
 *
 * 目录形态（`<id>/SKILL.md`）与平铺形态（`<id>.md`）都识别；目录形态优先。
 * `managed` 表示该技能由本插件安装（存在 `.financial-skills.json`），
 * version / installedAt 只来自来源记录，没有就留空。
 *
 * @param {string} installRoot 安装根。
 * @returns {Promise<Array<object>>} 按 id 排序的技能记录。
 */
export async function scanInstalled(installRoot) {
  const root = resolve(installRoot)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const records = new Map()
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !isValidId(entry.name)) continue
    const directory = join(root, entry.name)
    const skillFile = join(directory, 'SKILL.md')
    const skillStat = await statOrUndefined(skillFile)
    if (skillStat === undefined || !skillStat.isFile()) continue
    const frontmatter = await readFrontmatter(skillFile)
    const provenance = await readProvenance(directory)
    const record = {
      id: entry.name,
      name: typeof frontmatter.name === 'string' && frontmatter.name !== '' ? frontmatter.name : entry.name,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
      path: directory,
      managed: provenance !== undefined,
    }
    if (provenance !== undefined && typeof provenance.version === 'string' && provenance.version !== '') {
      record.version = provenance.version
    }
    if (provenance !== undefined) {
      const installedAt = normalizeInstalledAt(provenance.installedAt)
      if (installedAt !== undefined) record.installedAt = installedAt
    }
    records.set(entry.name, record)
  }

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue
    const id = entry.name.slice(0, -'.md'.length)
    if (!isValidId(id) || records.has(id)) continue
    const file = join(root, entry.name)
    const frontmatter = await readFrontmatter(file)
    records.set(id, {
      id,
      name: typeof frontmatter.name === 'string' && frontmatter.name !== '' ? frontmatter.name : id,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
      path: file,
      managed: false,
    })
  }

  return [...records.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * rename 重试（Windows 上杀毒 / 索引可能短暂占用目录）。
 *
 * @param {string} from 源路径。
 * @param {string} to 目标路径。
 */
async function renameWithRetry(from, to) {
  const delays = [50, 150, 400, 800]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (attempt >= delays.length || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      await new Promise((done) => setTimeout(done, delays[attempt]))
    }
  }
}

/**
 * 把调用方给的技能描述收敛成安装 / 详情需要的形状。
 *
 * routes 会传 format 3 的 `{version, license, source, resolve}`；旧调用方（以及
 * 旧 format 2 数据）可以只传 `{version, license}`，此时按旧 `plugins/<id>/` 布局
 * 与默认 resolve 模板处理。
 *
 * @param {string} id 技能 id。
 * @param {unknown} descriptor 技能描述。
 * @returns {{ version: string, license: string, source: object, resolve: object }} 归一化描述。
 */
function normalizeDescriptor(id, descriptor) {
  const raw = descriptor !== null && typeof descriptor === 'object' ? descriptor : {}
  const rawSource = raw.source !== null && typeof raw.source === 'object' ? raw.source : undefined
  const source =
    rawSource !== undefined
      ? rawSource
      : { type: 'github', repo: SOURCE_REPO_LABEL, path: `plugins/${id}`, ref: 'main' }
  const resolveTemplates = raw.resolve !== null && typeof raw.resolve === 'object' ? raw.resolve : DEFAULT_RESOLVE
  return {
    version: typeof raw.version === 'string' ? raw.version : '',
    license: typeof raw.license === 'string' ? raw.license : '',
    source,
    resolve: resolveTemplates,
  }
}

/** 取技能在仓库内的目录坐标（github 来源）。空串表示仓库根目录，不能回落成 plugins/<id>。 */
function coordsOf(source, id) {
  return {
    repo: typeof source.repo === 'string' && source.repo !== '' ? source.repo : SOURCE_REPO_LABEL,
    path: typeof source.path === 'string' ? source.path : `plugins/${id}`,
    ref: typeof source.ref === 'string' && source.ref !== '' ? source.ref : 'main',
  }
}

/**
 * 创建安装目录服务。
 *
 * @param {object} options 配置。
 * @param {string} options.dshHome 用户配置根。
 * @param {string} options.installRoot 安装根。
 * @param {object} options.source 上游 GitHub 引用读取源（createSource）。
 * @param {object} [options.github] `source` 的别名（兼容旧调用方）。
 * @param {object} [options.skillhub] SkillHub 读取源（createSkillhub）。
 * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits] 安装上限。
 * @param {{ warn: Function }} [options.logger] 日志。
 * @param {() => number} [options.now] 时钟（测试注入）。
 * @returns {object} 安装目录服务。
 */
export function createStore(options) {
  const dshHome = resolve(options.dshHome)
  const installRoot = resolve(options.installRoot)
  const github = options.source !== undefined && options.source !== null ? options.source : options.github
  if (github === undefined || github === null || typeof github.listFiles !== 'function' || typeof github.readFile !== 'function') {
    throw new Error('store requires a github source with listFiles/readFile')
  }
  const skillhub = options.skillhub !== undefined && options.skillhub !== null ? options.skillhub : undefined
  const configuredLimits = options.limits !== undefined && options.limits !== null ? options.limits : {}
  const limits = {
    maxFiles: Math.floor(positiveNumber(configuredLimits.maxFiles, DEFAULT_LIMITS.maxFiles)),
    maxFileBytes: Math.floor(positiveNumber(configuredLimits.maxFileBytes, DEFAULT_LIMITS.maxFileBytes)),
    maxTotalBytes: Math.floor(positiveNumber(configuredLimits.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes)),
  }
  const logger = options.logger
  const now = typeof options.now === 'function' ? options.now : Date.now

  /** 校验文件清单的路径与声明大小。 */
  function validateList(id, files) {
    if (files.length === 0) throw new StoreError('not-found', `上游没有 skill ${id} 的文件`, 404)
    if (!files.some((file) => file.path === 'SKILL.md')) {
      throw new StoreError('invalid-package', `skill ${id} 的来源里没有 SKILL.md`, 502)
    }
    if (files.length > limits.maxFiles) {
      throw new StoreError('too-many-files', `skill ${id} 有 ${files.length} 个文件，超过上限 ${limits.maxFiles}`, 400)
    }
    const seen = new Set()
    for (const file of files) {
      if (!isSafeRelativePath(file.path)) {
        throw new StoreError('unsafe-path', `skill ${id} 的清单里有不安全路径：${String(file.path)}`, 400)
      }
      if (seen.has(file.path)) throw new StoreError('invalid-package', `skill ${id} 的清单里有重复路径：${file.path}`, 502)
      seen.add(file.path)
      if (Number.isFinite(file.size) && file.size > limits.maxFileBytes) {
        throw new StoreError('file-too-large', `${file.path} 声明 ${file.size} 字节，超过单文件上限 ${limits.maxFileBytes}`, 400)
      }
    }
  }

  /** 拉取一个技能的全部文件内容（github 逐文件 / skillhub zip 解压）。 */
  async function materialize(id, descriptor) {
    const source = descriptor.source
    if (source.type === 'skillhub') {
      if (skillhub === undefined) throw new StoreError('unsupported-source', 'skillhub 读取源未装配', 502)
      const extracted = await skillhub.listSkillFiles({ id, source }, descriptor.resolve.skillhub)
      validateList(id, extracted.files.map((file) => ({ path: file.path, size: file.buffer.length })))
      return extracted
    }

    const coords = coordsOf(source, id)
    const listing = await github.listFiles(coords, descriptor.resolve.github, { id, exclude: source.exclude })
    validateList(id, listing)
    const files = []
    let totalBytes = 0
    for (const entry of listing) {
      const buffer = await github.readFile(coords, descriptor.resolve.github, entry.path, { id })
      if (buffer.length > limits.maxFileBytes) {
        throw new StoreError('file-too-large', `${entry.path} 实际 ${buffer.length} 字节，超过单文件上限 ${limits.maxFileBytes}`, 400)
      }
      totalBytes += buffer.length
      if (totalBytes > limits.maxTotalBytes) {
        throw new StoreError('total-too-large', `skill ${id} 超过总量上限 ${limits.maxTotalBytes} 字节`, 400)
      }
      files.push({ path: entry.path, buffer })
    }
    return { files, totalBytes }
  }

  /** 只列文件清单与总量（详情用，不下载全部正文）。 */
  async function listOnly(id, descriptor) {
    const source = descriptor.source
    if (source.type === 'skillhub') {
      if (skillhub === undefined) throw new StoreError('unsupported-source', 'skillhub 读取源未装配', 502)
      const extracted = await skillhub.listSkillFiles({ id, source }, descriptor.resolve.skillhub)
      validateList(id, extracted.files.map((file) => ({ path: file.path, size: file.buffer.length })))
      return {
        files: extracted.files.map((file) => ({ path: file.path, size: file.buffer.length })),
        totalBytes: extracted.totalBytes,
      }
    }
    const listing = await github.listFiles(coordsOf(source, id), descriptor.resolve.github, { id, exclude: source.exclude })
    validateList(id, listing)
    const totalBytes = listing.reduce((sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0), 0)
    return { files: listing, totalBytes }
  }

  /**
   * 安装一个技能。
   *
   * @param {string} id 技能 id。
   * @param {{ version?: string, license?: string, source?: object, resolve?: object }} [descriptor] 技能描述。
   * @returns {Promise<{ id: string, path: string, files: number, bytes: number, version: string, license: string }>} 安装结果。
   */
  async function install(id, descriptor) {
    if (!isValidId(id)) throw new StoreError('invalid-id', 'invalid skill id', 400)
    const normalized = normalizeDescriptor(id, descriptor)
    const target = resolve(installRoot, id)
    if (!isWithinRoot(installRoot, target)) {
      throw new StoreError('path-escape', `安装路径逃出了安装根：${id}`, 400)
    }

    const targetStat = await statOrUndefined(target)
    const flatStat = await statOrUndefined(join(installRoot, `${id}.md`))
    if (targetStat !== undefined || flatStat !== undefined) {
      throw new StoreError('conflict', `skill ${id} 已安装，如需更新请先卸载`, 409)
    }

    let payload
    try {
      payload = await materialize(id, normalized)
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'not-found') {
        throw new StoreError('not-found', `上游仓库里没有 skill ${id}`, 404)
      }
      throw error
    }
    validateList(
      id,
      payload.files.map((file) => ({ path: file.path, size: file.buffer.length })),
    )

    const stamp = `${now().toString(36)}-${randomBytes(4).toString('hex')}`
    const staging = join(installRoot, `${STAGING_PREFIX}${id}-${stamp}`)
    await mkdir(staging, { recursive: true })

    let fileCount = 0
    let totalBytes = 0
    try {
      for (const file of payload.files) {
        totalBytes += file.buffer.length
        if (totalBytes > limits.maxTotalBytes) {
          throw new StoreError('total-too-large', `skill ${id} 超过总量上限 ${limits.maxTotalBytes} 字节`, 400)
        }
        const destination = resolve(staging, ...file.path.split('/'))
        if (!isWithinRoot(staging, destination)) {
          throw new StoreError('unsafe-path', `拒绝把文件写到暂存目录之外：${file.path}`, 400)
        }
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, file.buffer)
        fileCount += 1
      }

      const provenance = {
        id,
        version: normalized.version,
        license: normalized.license,
        sourceRepo:
          normalized.source.type === 'github' && typeof normalized.source.repo === 'string' && normalized.source.repo !== ''
            ? normalized.source.repo
            : SOURCE_REPO_LABEL,
        installedAt: now(),
        files: payload.files.map((file) => file.path),
        fileCount,
        bytes: totalBytes,
        sourceType: normalized.source.type === 'skillhub' ? 'skillhub' : 'github',
      }
      if (provenance.sourceType === 'github') {
        const coords = coordsOf(normalized.source, id)
        provenance.sourcePath = coords.path
        provenance.sourceRef = coords.ref
      } else {
        if (typeof normalized.source.slug === 'string' && normalized.source.slug !== '') provenance.sourceSlug = normalized.source.slug
        if (typeof normalized.source.namespace === 'string' && normalized.source.namespace !== '') {
          provenance.sourceNamespace = normalized.source.namespace
        }
        if (typeof normalized.source.skillhubCommand === 'string' && normalized.source.skillhubCommand !== '') {
          provenance.skillhubCommand = normalized.source.skillhubCommand
        }
      }
      await writeFile(join(staging, PROVENANCE_FILE), JSON.stringify(provenance, null, 2), 'utf8')

      try {
        await renameWithRetry(staging, target)
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined
        if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') {
          throw new StoreError('conflict', `skill ${id} 已安装，如需更新请先卸载`, 409)
        }
        throw error
      }

      return {
        id,
        path: target,
        files: fileCount,
        bytes: totalBytes,
        version: provenance.version,
        license: provenance.license,
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch((cleanupError) => {
        warn(logger, `[financial-skills] 暂存目录清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      })
      throw error
    }
  }

  /**
   * 卸载一个技能：移到 `<installRoot>/.trash/<id>-<ts>/`，不直接删除。
   *
   * @param {string} id 技能 id。
   * @returns {Promise<{ id: string, trashedTo: string }>} 归档位置。
   */
  async function uninstall(id) {
    if (!isValidId(id)) throw new StoreError('invalid-id', 'invalid skill id', 400)
    const directory = resolve(installRoot, id)
    const flatFile = resolve(installRoot, `${id}.md`)
    const directoryStat = await statOrUndefined(directory)
    const flatStat = directoryStat === undefined ? await statOrUndefined(flatFile) : undefined
    if (directoryStat === undefined && flatStat === undefined) {
      throw new StoreError('not-found', `skill ${id} 未安装`, 404)
    }
    if (!isWithinRoot(installRoot, directory) || !isWithinRoot(installRoot, flatFile)) {
      throw new StoreError('path-escape', `拒绝卸载安装根之外的路径：${id}`, 400)
    }

    const trashRoot = join(installRoot, TRASH_DIR)
    await mkdir(trashRoot, { recursive: true })
    const stamp = `${id}-${now()}`
    let trashedTo = join(trashRoot, stamp)
    let suffix = 0
    while ((await statOrUndefined(trashedTo)) !== undefined) {
      suffix += 1
      trashedTo = join(trashRoot, `${stamp}-${suffix}`)
    }

    if (directoryStat !== undefined && directoryStat.isDirectory()) {
      await rename(directory, trashedTo)
    } else {
      await mkdir(trashedTo, { recursive: true })
      await rename(flatFile, join(trashedTo, `${id}.md`))
    }
    return { id, trashedTo }
  }

  return {
    dshHome,
    installRoot,
    limits,
    source: github,
    github,
    skillhub,

    /** 扫描安装根。 */
    scan() {
      return scanInstalled(installRoot)
    },

    /** installed 路由的载荷：安装根 + 计数 + 技能列表。 */
    async list() {
      const skills = await scanInstalled(installRoot)
      return { root: installRoot, count: skills.length, skills }
    },

    /** id → 已安装记录，供目录归一化合并 installed 状态。 */
    async installedMap() {
      const skills = await scanInstalled(installRoot)
      return new Map(skills.map((skill) => [skill.id, skill]))
    },

    /**
     * 上游文件清单 + 总大小（详情用）。
     *
     * @param {string} id 技能 id。
     * @param {{ source?: object, resolve?: object }} [descriptor] 技能描述。
     * @returns {Promise<{ files: Array<{ path: string, size: number }>, totalBytes: number }>} 清单与总量。
     */
    manifest(id, descriptor) {
      return listOnly(id, normalizeDescriptor(id, descriptor))
    },

    /**
     * 读一个上游文件的正文。
     *
     * @param {string} id 技能 id。
     * @param {{ source?: object, resolve?: object }} [descriptor] 技能描述。
     * @param {string} relPath 技能目录内的相对路径。
     * @returns {Promise<Buffer>} 文件字节。
     */
    async readSkillFile(id, descriptor, relPath) {
      const normalized = normalizeDescriptor(id, descriptor)
      if (normalized.source.type === 'skillhub') {
        if (skillhub === undefined) throw new StoreError('unsupported-source', 'skillhub 读取源未装配', 502)
        const extracted = await skillhub.listSkillFiles({ id, source: normalized.source }, normalized.resolve.skillhub)
        const found = extracted.files.find((file) => file.path === relPath)
        if (found === undefined) throw new StoreError('invalid-package', `skill ${id} 的来源里没有 ${relPath}`, 502)
        return found.buffer
      }
      return github.readFile(coordsOf(normalized.source, id), normalized.resolve.github, relPath, { id })
    },

    install,
    uninstall,
  }
}
