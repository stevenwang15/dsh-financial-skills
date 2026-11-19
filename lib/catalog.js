/**
 * dsh-financial-skills —— 上游目录抓取、归一化、缓存与快照兜底
 *
 * 数据唯一真相源是 openfcp/awesome-financial-skills 仓库的 catalog.json。
 * 运行时按契约里的镜像链依次尝试；任何一条失败都降级到下一跳，全部失败才用
 * 随包快照 catalog.snapshot.json。6 小时内的成功结果落盘缓存，重启后仍然生效。
 *
 * 上游自 2026-11-13 起是 format 3：目录只存引用，顶层 `resolve` 给出取回模板，
 * 每条技能带 source 坐标。format 2 的旧缓存 / 旧快照 / 旧 fixture 仍然兼容。
 *
 * 归一化后的形状是两半之间的稳定契约（CONTRACT §2），字段名不再改动。
 *
 * @module dsh-financial-skills/catalog
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 上游站点（归一化结果里的 upstreamSite）。 */
export const UPSTREAM_SITE = 'https://openfcp.github.io/awesome-financial-skills/'

/** 目录镜像降级链：raw → fastly jsDelivr → gcore jsDelivr → cdn jsDelivr。 */
export const DEFAULT_INDEX_URLS = Object.freeze([
  'https://raw.githubusercontent.com/openfcp/awesome-financial-skills/main/catalog.json',
  'https://fastly.jsdelivr.net/gh/openfcp/awesome-financial-skills@main/catalog.json',
  'https://gcore.jsdelivr.net/gh/openfcp/awesome-financial-skills@main/catalog.json',
  'https://cdn.jsdelivr.net/gh/openfcp/awesome-financial-skills@main/catalog.json',
])

/** 目录缓存有效期：6 小时。 */
export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** 单次网络请求超时：10 秒。 */
export const DEFAULT_TIMEOUT_MS = 10 * 1000

/** 官方上游仓库（format 2 的 source 缺 repo、旧 fixture 默认路径用）。 */
export const DEFAULT_SOURCE_REPO = 'openfcp/awesome-financial-skills'

/** format 3 的缺省取回规则：上游 resolve 缺失或非法时使用。 */
export const DEFAULT_RESOLVE = Object.freeze({
  skillhub: Object.freeze({
    kind: 'zip',
    url: 'https://api.skillhub.cn/api/v1/download?slug={slug}',
  }),
  github: Object.freeze({
    kind: 'files',
    raw: 'https://raw.githubusercontent.com/{repo}/{ref}/{path}/{file}',
    api: 'https://api.github.com/repos/{repo}/contents/{path}?ref={ref}',
  }),
})

/** 取模板字符串；空值回落默认模板。 */
function templateString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * 归一化顶层 resolve 取回规则。
 *
 * format 3 上游给出 skillhub zip 与 github files 两套模板；缺失 / 非法字段一律
 * 回落官方默认值，保证旧 format 2 快照也能装配出可用的 resolve。
 *
 * @param {unknown} raw 上游 resolve 对象。
 * @returns {{ skillhub: { kind: string, url: string }, github: { kind: string, raw: string, api: string } }} 归一化规则。
 */
export function normalizeResolve(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const skillhub = source.skillhub !== null && typeof source.skillhub === 'object' ? source.skillhub : {}
  const github = source.github !== null && typeof source.github === 'object' ? source.github : {}
  return {
    skillhub: { kind: 'zip', url: templateString(skillhub.url, DEFAULT_RESOLVE.skillhub.url) },
    github: {
      kind: 'files',
      raw: templateString(github.raw, DEFAULT_RESOLVE.github.raw),
      api: templateString(github.api, DEFAULT_RESOLVE.github.api),
    },
  }
}

/** 去掉 `./` 前缀与首尾斜杠，得到仓库内相对路径。 */
function normalizeRepoPath(value) {
  return typeof value === 'string' ? value.trim().replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '') : ''
}

/**
 * 归一化 `source.exclude`：技能目录内不需要取回的相对路径前缀。
 *
 * 上游把纯展示资源（`examples/`、`assets/showcase/`）写在 exclude 里，避免把几十 MB
 * 成品图一起装进技能目录。空值、`..` 段与重复项一律丢弃。
 *
 * @param {unknown} value 上游 source.exclude。
 * @returns {string[]} 干净的排除前缀。
 */
export function normalizeExclude(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const path = normalizeRepoPath(entry)
    if (path === '') continue
    if (!path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')) continue
    if (!out.includes(path)) out.push(path)
  }
  return out
}

/**
 * 归一化一条技能的来源坐标。
 *
 * format 3：skillhub → `{type,namespace,slug}`；github → `{type,repo,path,ref,vendored}`。
 * format 2：github 的仓库内路径从 `install.plugin`（`./plugins/<id>`）推导；
 * skillhub 的 slug 缺省取技能 id。`install.skillhub` 命令始终保留为
 * `source.skillhubCommand`，供详情页“复制命令”使用。
 *
 * @param {unknown} rawSource 上游 skill.source。
 * @param {unknown} install 上游 skill.install。
 * @param {string} skillId 技能 id。
 * @returns {{ type: 'skillhub' | 'github' } & Record<string, unknown>} 归一化来源。
 */
export function normalizeSkillSource(rawSource, install, skillId) {
  const source = rawSource !== null && typeof rawSource === 'object' ? rawSource : {}
  const installer = install !== null && typeof install === 'object' ? install : {}
  const type = asString(source.type) === 'skillhub' ? 'skillhub' : 'github'

  if (type === 'skillhub') {
    const normalized = { type, slug: asString(source.slug) || skillId }
    const namespace = asString(source.namespace)
    if (namespace !== '') normalized.namespace = namespace
    const command = asString(installer.skillhub)
    if (command !== '') normalized.skillhubCommand = command
    return normalized
  }

  const pluginPath = normalizeRepoPath(installer.plugin)
  const repo = asString(source.repo) || DEFAULT_SOURCE_REPO
  // source.path 显式为 "" 表示技能就在仓库根目录（上游不少第三方仓库是这种布局），
  // 只有 source.path 缺失时才回落到 install.plugin / 旧 plugins/<id> 布局。
  const declaredPath = typeof source.path === 'string' ? normalizeRepoPath(source.path) : undefined
  const path = declaredPath !== undefined ? declaredPath : pluginPath || `plugins/${skillId}`
  const ref = asString(source.ref) || 'main'
  const vendored = source.vendored === true || (source.vendored === undefined && pluginPath !== '')
  const normalized = { type, repo, path, ref, vendored }
  const exclude = normalizeExclude(source.exclude)
  if (exclude.length > 0) normalized.exclude = exclude
  return normalized
}

/** 缓存文件名（落在 <dshHome>/storages/financial-skills/ 下）。 */
export const CACHE_FILE_NAME = 'catalog.cache.json'

/** 随包快照的绝对路径（本文件在 lib/ 下，快照在包根）。 */
export const SNAPSHOT_FILE = fileURLToPath(new URL('../catalog.snapshot.json', import.meta.url))

/** 技能 id 文法：小写字母或数字开头，只含小写字母 / 数字 / 连字符。 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * 判断技能 id 是否合法。
 *
 * 客户端只能传 id，服务端据此重建路径；id 文法本身就把路径分隔符挡在外面。
 *
 * @param {unknown} value 候选 id。
 * @returns {boolean} 是否合法。
 */
export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/**
 * 判断一个值是否是合法的 http(s) 地址。
 *
 * @param {unknown} value 候选值。
 * @returns {boolean} 是否可作为目录源。
 */
export function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 正数回落：非有限正数一律取默认值。 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 计算出目录缓存文件路径。
 *
 * @param {string} dshHome 用户配置根。
 * @returns {string} 缓存文件绝对路径。
 */
export function cacheFileFor(dshHome) {
  return join(dshHome, 'storages', 'financial-skills', CACHE_FILE_NAME)
}

/** 规整镜像链：只保留合法 http(s) 地址；整条非法则回落到默认链。 */
export function normalizeIndexUrls(value) {
  const urls = Array.isArray(value) ? value.filter(isHttpUrl) : []
  return urls.length > 0 ? urls : [...DEFAULT_INDEX_URLS]
}

/**
 * 双语字段归一化。
 *
 * 上游字段可能缺失、可能是纯字符串；这里统一成 { zh, en }，并给单侧缺失
 * 补另一侧，保证客户端永远拿到两个可显示的字符串。
 *
 * @param {unknown} value 原始双语字段。
 * @param {{ zh: string, en: string }} fallback 两侧都缺失时的兜底。
 * @returns {{ zh: string, en: string }} 归一化结果。
 */
function textPair(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim()
    return { zh: text, en: text }
  }
  const source = value !== null && typeof value === 'object' ? value : {}
  const zh = typeof source.zh === 'string' && source.zh.trim() !== '' ? source.zh.trim() : ''
  const en = typeof source.en === 'string' && source.en.trim() !== '' ? source.en.trim() : ''
  return { zh: zh !== '' ? zh : en !== '' ? en : fallback.zh, en: en !== '' ? en : zh !== '' ? zh : fallback.en }
}

/** 字符串化并去空白；非字符串返回空串。 */
function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 归一化上游目录。
 *
 * 这一步同时完成三件事：字段改名（pluginPath / installed 等）、分类计数、
 * 已安装状态合并。非法条目（id 不合法、分类缺失）被丢弃而不是让整份目录失败。
 *
 * @param {unknown} raw 上游 catalog.json 解析结果。
 * @param {Map<string, { version?: string, installedAt?: number, path?: string }>} [installed] 已安装索引。
 * @returns {object} CONTRACT §2 定义的归一化 catalog。
 */
export function normalizeCatalog(raw, installed = new Map()) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const id = asString(source.id) || 'awesome-financial-skills'

  const categoryIds = new Set()
  const categories = Array.isArray(source.categories)
    ? source.categories
        .map((category) => {
          if (category === null || typeof category !== 'object') return undefined
          const categoryId = asString(category.id)
          if (categoryId === '') return undefined
          categoryIds.add(categoryId)
          return {
            id: categoryId,
            title: textPair(category.title, { zh: categoryId, en: categoryId }),
            description: textPair(category.description, { zh: '', en: '' }),
          }
        })
        .filter((category) => category !== undefined)
    : []

  const skills = []
  const counts = new Map()
  const rawSkills = Array.isArray(source.skills) ? source.skills : []
  for (const skill of rawSkills) {
    if (skill === null || typeof skill !== 'object') continue
    const skillId = asString(skill.id)
    if (!isValidId(skillId)) continue
    const rawCategory = asString(skill.category)
    const category = rawCategory !== '' ? rawCategory : 'other'
    const pairFallback = { zh: skillId, en: skillId }
    const install = skill.install !== null && typeof skill.install === 'object' ? skill.install : undefined
    const normalizedSource = normalizeSkillSource(skill.source, install, skillId)

    const record = {
      id: skillId,
      name: textPair(skill.name, pairFallback),
      summary: textPair(skill.summary, { zh: '', en: '' }),
      category,
      tags: Array.isArray(skill.tags)
        ? [...new Set(skill.tags.map((tag) => asString(tag)).filter((tag) => tag !== ''))]
        : [],
      version: asString(skill.version),
      author: asString(skill.author),
      license: asString(skill.license),
      source: normalizedSource,
      installed: false,
    }
    if (normalizedSource.type === 'github' && typeof normalizedSource.path === 'string' && normalizedSource.path !== '') {
      record.pluginPath = `./${normalizedSource.path}`
    }

    const state = installed instanceof Map ? installed.get(skillId) : undefined
    if (state !== undefined && state !== null) {
      record.installed = true
      if (typeof state.version === 'string' && state.version !== '') record.installedVersion = state.version
      if (typeof state.installedAt === 'number' && Number.isFinite(state.installedAt)) {
        record.installedAt = state.installedAt
      }
      if (typeof state.path === 'string' && state.path !== '') record.installedPath = state.path
    }

    skills.push(record)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }

  const categoriesWithCount = categories.map((category) => ({
    ...category,
    count: counts.get(category.id) ?? 0,
  }))

  return {
    id,
    updated: asString(source.updated),
    title: textPair(source.title, { zh: '金融行业技能清单', en: 'Awesome Financial Skills' }),
    description: textPair(source.description, { zh: '', en: '' }),
    upstreamSite: UPSTREAM_SITE,
    resolve: normalizeResolve(source.resolve),
    categories: categoriesWithCount,
    skills,
  }
}

/** 校验一份目录载荷的基本形状；形状不对就换下一条镜像。 */
function assertPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('catalog payload is not an object')
  }
  if (!Array.isArray(payload.categories) || !Array.isArray(payload.skills)) {
    throw new Error('catalog payload is missing categories/skills')
  }
}

/** 调一次 logger（没有 logger 时静默）。 */
function warn(logger, message) {
  try {
    if (logger && typeof logger.warn === 'function') logger.warn(message)
  } catch {
    /* 日志本身不能影响主流程 */
  }
}

/** 进程内临时文件序号，避免同一毫秒并发写同一个临时名。 */
let cacheSeq = 0

/**
 * 创建目录服务。
 *
 * 所有依赖（fetch、缓存路径、快照路径、超时）都可注入，测试因此不需要联网。
 *
 * @param {object} [options] 配置。
 * @param {string[]} [options.indexUrls] 镜像降级链。
 * @param {number} [options.cacheTtlMs] 缓存有效期。
 * @param {string} [options.cacheFile] 缓存文件路径；缺省不落盘。
 * @param {string} [options.snapshotFile] 随包快照路径。
 * @param {boolean} [options.offline] true 时完全不联网。
 * @param {Function} [options.fetchImpl] fetch 实现（测试注入）。
 * @param {number} [options.timeoutMs] 单次请求超时。
 * @param {{ warn: Function }} [options.logger] 日志。
 * @returns {object} 目录服务。
 */
export function createCatalog(options = {}) {
  const indexUrls = normalizeIndexUrls(options.indexUrls)
  const cacheTtlMs = positiveNumber(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS)
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const cacheFile = typeof options.cacheFile === 'string' && options.cacheFile !== '' ? options.cacheFile : undefined
  const snapshotFile =
    typeof options.snapshotFile === 'string' && options.snapshotFile !== '' ? options.snapshotFile : SNAPSHOT_FILE
  const offline = options.offline === true
  const fetchImpl =
    typeof options.fetchImpl === 'function' ? options.fetchImpl : typeof options.fetch === 'function' ? options.fetch : undefined
  const logger = options.logger

  /**
   * 读磁盘缓存。
   *
   * 文件缺失、损坏、字段类型不对都返回 undefined：缓存只是加速，坏了就当没有。
   *
   * @returns {Promise<{ fetchedAt: number, data: unknown } | undefined>} 缓存内容。
   */
  async function readCache() {
    if (cacheFile === undefined) return undefined
    let parsed
    try {
      parsed = JSON.parse(await readFile(cacheFile, 'utf8'))
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (typeof parsed.fetchedAt !== 'number' || !Number.isFinite(parsed.fetchedAt)) return undefined
    if (parsed.data === null || typeof parsed.data !== 'object') return undefined
    const data = /** @type {{ categories?: unknown, skills?: unknown }} */ (parsed.data)
    if (!Array.isArray(data.categories) || !Array.isArray(data.skills)) return undefined
    return { fetchedAt: parsed.fetchedAt, data: parsed.data }
  }

  /** 原子写缓存：临时文件 + rename；写失败只告警，不影响本次响应。 */
  async function writeCache(data, fetchedAt) {
    if (cacheFile === undefined) return
    try {
      await mkdir(dirname(cacheFile), { recursive: true })
      cacheSeq += 1
      const temp = `${cacheFile}.${process.pid}.${cacheSeq}.tmp`
      await writeFile(temp, JSON.stringify({ version: 1, fetchedAt, urls: indexUrls, data }), 'utf8')
      await rename(temp, cacheFile)
    } catch (error) {
      warn(logger, `[financial-skills] 目录缓存写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 读随包快照；读不到或形状不对就抛错，由路由转成 503。 */
  async function readSnapshot() {
    const text = await readFile(snapshotFile, 'utf8')
    const data = JSON.parse(text)
    assertPayload(data)
    return data
  }

  /** 拉一条镜像。 */
  async function fetchCatalog(url) {
    const impl = fetchImpl ?? globalThis.fetch
    if (typeof impl !== 'function') throw new Error('fetch is unavailable')
    const init = {
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
      cache: 'no-store',
    }
    if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs)
    const response = await impl(url, init)
    if (response === undefined || response === null || response.ok !== true) {
      throw new Error(`HTTP ${response === undefined || response === null ? 'unknown' : response.status}`)
    }
    const text = await response.text()
    const data = JSON.parse(text)
    assertPayload(data)
    return data
  }

  return {
    indexUrls,
    cacheFile,
    snapshotFile,
    offline,
    cacheTtlMs,
    timeoutMs,

    /**
     * 加载目录。
     *
     * 顺序：新鲜缓存 → 镜像链 → 过期缓存 → 随包快照。refresh 为 true 时跳过
     * 新鲜缓存直接联网；offline 为 true 时跳过网络，只走缓存 / 快照。
     *
     * @param {object} [loadOptions] 加载选项。
     * @param {boolean} [loadOptions.refresh] 强制刷新。
     * @param {Map<string, object>} [loadOptions.installed] 已安装索引。
     * @returns {Promise<{ catalog: object, meta: object }>} 归一化目录与元信息。
     */
    async load(loadOptions = {}) {
      const refresh = loadOptions.refresh === true
      const installed = loadOptions.installed instanceof Map ? loadOptions.installed : new Map()
      const now = Date.now()

      const cached = await readCache()
      if (!refresh && cached !== undefined && now - cached.fetchedAt < cacheTtlMs) {
        return {
          catalog: normalizeCatalog(cached.data, installed),
          meta: { source: 'cache', fetchedAt: cached.fetchedAt, stale: false, offline },
        }
      }

      let lastError
      if (!offline) {
        for (const url of indexUrls) {
          try {
            const data = await fetchCatalog(url)
            await writeCache(data, now)
            return {
              catalog: normalizeCatalog(data, installed),
              meta: { source: 'network', fetchedAt: now, stale: false, offline: false },
            }
          } catch (error) {
            lastError = error
            warn(logger, `[financial-skills] 目录镜像失败 ${url}：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }

      const offlineReason = offline ? 'offline mode' : undefined
      const errorText = lastError !== undefined ? (lastError instanceof Error ? lastError.message : String(lastError)) : offlineReason

      if (cached !== undefined) {
        return {
          catalog: normalizeCatalog(cached.data, installed),
          meta: {
            source: 'cache',
            fetchedAt: cached.fetchedAt,
            stale: true,
            offline,
            ...(errorText !== undefined ? { error: errorText } : {}),
          },
        }
      }

      const data = await readSnapshot()
      return {
        catalog: normalizeCatalog(data, installed),
        meta: {
          source: 'snapshot',
          fetchedAt: now,
          stale: true,
          offline,
          ...(errorText !== undefined ? { error: errorText } : {}),
        },
      }
    },

    /**
     * 只读本地（缓存任何年龄 → 快照），绝不联网。
     *
     * 详情 / 安装只需要目录里的 version、license、source 元信息，不必为了这些
     * 字段等 4 条镜像超时。
     *
     * @param {object} [loadOptions] 加载选项。
     * @param {Map<string, object>} [loadOptions.installed] 已安装索引。
     * @returns {Promise<{ catalog: object, meta: object }>} 归一化目录与元信息。
     */
    async loadLocal(loadOptions = {}) {
      const installed = loadOptions.installed instanceof Map ? loadOptions.installed : new Map()
      const now = Date.now()
      const cached = await readCache()
      if (cached !== undefined) {
        return {
          catalog: normalizeCatalog(cached.data, installed),
          meta: { source: 'cache', fetchedAt: cached.fetchedAt, stale: now - cached.fetchedAt >= cacheTtlMs, offline },
        }
      }
      const data = await readSnapshot()
      return {
        catalog: normalizeCatalog(data, installed),
        meta: { source: 'snapshot', fetchedAt: now, stale: true, offline },
      }
    },

    /**
     * 只窥视缓存时间戳（health 用），不读正文、不联网。
     *
     * @returns {Promise<{ fetchedAt: number } | undefined>} 缓存元信息。
     */
    async peekCache() {
      const cached = await readCache()
      return cached === undefined ? undefined : { fetchedAt: cached.fetchedAt }
    },
  }
}
