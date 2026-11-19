# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## 未发布 / Unreleased

### 修复

- **GitHub 来源支持「技能就在仓库根」**：上游自 2026-11-17 起收录了一批根目录布局的仓库（`source.path: ""`）。此前归一化会把空 path 改写成 `plugins/<id>`，这些技能的详情与安装全部 404。现在空 path 原样保留，`resolve` 模板里的 `{path}` 会被真正替换掉（不再留下字面量 `{path}`），raw 地址也不会出现 `//`。
- **支持 `source.exclude`**：上游对纯展示资源（`examples/`、`assets/showcase/`、`docs/` 等）声明了排除前缀，此前会被一并取回，容易撞上文件数 / 总量上限。现在按前缀跳过，与上游取件脚本 `install.py` 的行为一致。

## 0.1.1 — 2026-11-13

### 变更

- 侧栏入口名称由「**金融业技能**」改为「**金融技能**」（英文界面仍为 `Financial Skills`，`id` / 路由 / 包名不变）。其余行为、配置项与 HTTP API 与 0.1.0 完全一致。

## 0.1.0 — 2026-11-13

首个版本 / First release. 作者：八大权益。

### 新增

- 双半区插件：Host 半区（`index.js` + `lib/`）负责目录抓取、缓存、安装/卸载与路由；浏览器半区（`client.js`）是手写 `__ModuleLoader__` bundle，无构建步骤。
- 左侧栏入口「**金融业技能**」（`sidebar.panellist`，`id: financial-skills`，`order: 25`），与官方「插件」「定时任务」入口共存不抢位。
- 右侧整页「**金融行业skills精选**」：搜索、9 类分类筛选（含数量）、全部/已安装切换、详情弹窗（Markdown 正文 + 文件清单 + license）、一键安装/卸载、页脚数据源与刷新。
- 数据源为 `openfcp/awesome-financial-skills` 的 `catalog.json`（当前 9 类 17 个技能），按 raw.githubusercontent → fastly.jsdelivr → gcore.jsdelivr → cdn.jsdelivr 四级降级抓取，6 小时磁盘缓存，全部失败时回落到随包 `catalog.snapshot.json`，并在 `meta` 中如实标注 `source / offline / stale / error`。
- **兼容上游目录 `format: 3`（2026-11-13 迁移）**：上游改为「只存引用、不存正文」，删除 `plugins/<id>/`，新增顶层 `resolve` 取回模板（skillhub zip：`https://api.skillhub.cn/api/v1/download?slug={slug}`；github：raw + api 模板）与每条的来源坐标（skillhub `{namespace,slug}` / github `{repo,path,ref,vendored}`）。安装/详情按 `source.type` 取回正文：SkillHub 下载 zip 并解压，GitHub 逐文件 raw → API → jsDelivr；唯一 vendored 的 `official-source-qa`（正文在 `skills/official-source-qa/`）同样走 GitHub 坐标。来源记录 `.financial-skills.json` 增加 `sourceType` 与来源坐标字段；引用不可达时明确报错并清理暂存目录，不产生半装技能。旧 `format: 2` 清单/缓存/快照/`plugins/<id>/` fixture 仍兼容。
- 6 条 Host 路由：`GET /api/financial-skills/{catalog,installed,detail,health}`、`POST /api/financial-skills/{install,uninstall}`，统一 `{ok,value}` / `{ok,error}` 信封。
- 安全围栏：loopback-only（否则 403）、客户端只传 id（文法校验）、路径逃逸防护、staging + rename 安装、文件数/单文件/总量上限（200 / 2 MB / 16 MB）、卸载移入 `.trash` 而非删除。
- 安装后调用 `skills.invalidateCache()`（可选，失败只 warn），新技能立刻出现在会话技能目录。
- 零 npm 依赖，只用 `node:` 内置模块；浏览器半区只使用宿主暴露的 `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`。
- 测试：
  - `npm test`（`node --test`）：Host 单元测试 + 浏览器半契约测试，全部离线可过；
  - `test/e2e-remote.mjs` + `scripts/run-e2e.sh`：隔离 `DSH_HOME` 真机 E2E，覆盖插件挂载、目录/已安装/详情/健康路由、`client.js` 产物、fixture 安装与卸载；`DSH_FINANCIAL_SKILLS_FIXTURE` 指向本地 fixture，安装链路无需联网。
- 文档与发布：`README.md` / `README.en.md`、`docs/E2E.md`、`docs/DESIGN.md`、`LICENSE`（MIT）、`CHANGELOG.md`、GitHub Actions CI（Node 20，语法检查 + `npm test` + 脚本 `sh -n`）。

### 已知边界

- 上游目前有 5 个分类 0 条：UI 仍显示分类（数量 0），空结果给出「该分类暂无工具」而不是隐藏。
- 部分技能 `license: proprietary`：列表行不展示 license，详情里如实显示；安装只是在本地下载使用，不代表获得再分发授权。
- 安装/详情依赖网络（SkillHub / GitHub / jsDelivr）；断网或引用失效时页面给出可操作错误，不出现空白，也不会留下半装目录。SkillHub 条目的 `namespace` 仅用于展示与去重，zip 下载只需要 `slug`。
- 只做索引与本地安装，不内置或搬运任何技能正文（唯一例外是上游自己 vendored 的 `official-source-qa`）；清单只存引用，正文版权与许可证归各自作者。
