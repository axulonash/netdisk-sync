# 原生极简设置界面重设计 P1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把插件设置页改为方案4「原生极简」单页 UI：服务下拉（仅 4 原生服务）、四折叠区、常驻进度行、右上角浮动同步提示、零设置类模态。

**Architecture:** 新建 frame（头部+进度行+四折叠区）与 single-page 装配器，逐服务把现有简化页重构为「连接区片段」并渐进接入 `display()`；legacy `renderLegacy` 先抽取共用字段块（基本/高级/导入导出/调试）并委托，最终整体删除；浮动通知通过 `plugin.onSyncUiUpdate` 与设置内进度行同源。

**Tech Stack:** TypeScript + Obsidian API（Setting/Modal/PluginSettingTab），原生 DOM，mocha + tsx + JSDOM 测试，biome。

**Spec:** `docs/ui/native-minimal-redesign.zh-cn.md`（本计划论据均出自该规格；执行者需同时阅读）

## Global Constraints

- UI 文案：新简化页/片段硬编码简体中文；从 renderLegacy 抽取的字段块保留其现有 `t(...)` i18n 调用不动。
- 样式仅用 Obsidian 主题变量，不新增色板；状态色仅 `--color-green/red/yellow`。
- 服务下拉选项：desktop = ["webdav","baidu","quark","aliyun"]，mobile = ["webdav"]。
- 不修改 `SUPPORTED_SERVICES_TYPE` 联合类型（P2 计划处理）。
- 不动：ribbon 图标视觉、状态栏、start-sync 等命令、`SyncProtectionModal`/`SyncAlgoV3Modal` 运行期模态、`syncRun` 引擎。
- 提交纪律：工作树含大量与本任务无关的未提交更改；每个任务只 `git add` 本任务列出的文件，禁止 `git add -A` / `git commit -a`。
- 测试命令：单文件 `npx mocha --import=tsx 'tests/<file>.test.ts'`；全量 `npm test`。
- 不引入任何新 npm 依赖；原型 `demo/` 目录不改动。

## Review Focus

以下 5 类输入/状态最可能出错，各归属任务的测试必须覆盖：

1. 旧配置 `serviceType` 为 s3/dropbox 等已移除服务 → 设置页显示「服务不再支持」警告且不崩溃 → 测试归 Task 12。
2. 同步进行中重开设置页或经下拉切换服务 → 无重复订阅、进度行/浮动通知不重复不泄漏 → 测试归 Task 3（cleanup 反订阅）与 Task 12（重入）。
3. 浮动通知仅手动触发（manual/dry）出现，auto/auto_sync_on_save 不出现；终态 success/failed/paused/cancelled 显示摘要后自动消失 → 测试归 Task 2。
4. 行内展开互斥（密码/加密/远程目录/扫码一次只开一个）；密码/加密确认必须先 `saveSettings` 再触发依赖操作 → 测试归 Task 5。
5. 同步中设置字段锁定、运行按钮变暂停/停止的既有行为在重构后保持 → 现有断言移植到 Task 8（webdav 为样本）。

---

### Task 1: 设置页骨架 Frame

**Files:**
- Create: `src/settingsFrame.ts`
- Test: `tests/settingsFrame.test.ts`

**Interfaces:**
- Consumes: `createSettingsSection(parent, title): HTMLDivElement`（src/settingsLayout.ts:21，已有，不改）；`.rsnext-connection-light[data-state]` 现有 CSS 类（styles.css:287-290）。
- Produces（后续任务依赖，签名固定）:
```ts
export type ConnectionState = "idle" | "testing" | "success" | "failure";
export interface SettingsFrame {
  sections: Record<"connection" | "basic" | "advanced" | "records", HTMLDivElement>;
  progressHost: HTMLElement;          // 头部下方空 div，Task 3 填充
  setStatus(state: ConnectionState, text: string): void;
  setTester(t: (() => Promise<{ ok: boolean; message: string }>) | null): void;
  onServiceChange(cb: (s: SUPPORTED_SERVICES_TYPE) => void): void;
  cleanup(): void;                    // 清空 containerEl 并解除全部监听
}
export function createSettingsFrame(
  containerEl: HTMLElement,
  plugin: RemotelySavePlugin,
  opts: { desktop: boolean; unsupported: boolean; onServiceChange: (s: SUPPORTED_SERVICES_TYPE) => void },
): SettingsFrame;
```
Frame 行为：头部 = 服务 `<select>`（unsupported 时首项 `value=""` 选中并渲染警告条「当前配置的服务已不再支持，请重新选择服务」）+ 状态点（`.rsnext-connection-light`，data-state 映射四态）+ 文字 + 「测试连接」按钮（`setTester(null)` 时 `hidden`）+ `progressHost` 空 div；随后四个 `createSettingsSection`，标题依次「连接 / 基本 / 高级 / 同步记录」。select 的 change 触发 `onServiceChange`；测试按钮点击 → `setStatus("testing", …)` → await tester() → 按 `{ok,message}` 置 success/failure。测试文件用与 `tests/settingsWebdavSimple.test.ts:5-64` 相同的 JSDOM + plugin-mock fixture 模式。

- [ ] **Step 1: 写失败测试** `tests/settingsFrame.test.ts`：① desktop=true 渲染 4 个 option，desktop=false 渲染 1 个；② 四个 `<details>` 存在且 summary 文本为 连接/基本/高级/同步记录；③ unsupported=true 时警告条可见、select value 为空；④ `onServiceChange` 在 change 时收到新值；⑤ `setTester(null)` 按钮 hidden、`setTester(fn)` 可见，点击后状态点经历 testing → success（tester 返回 ok）与 testing → failure（tester 返回 !ok）；⑥ `cleanup()` 后 containerEl 为空且再触发 change 无异常。
- [ ] **Step 2: 跑测试确认失败** `npx mocha --import=tsx 'tests/settingsFrame.test.ts'` → FAIL（模块不存在）。
- [ ] **Step 3: 实现 `src/settingsFrame.ts`** 按 Produces 签名；用 `el()` 风格内联 DOM 构建（参照 settingsWebdavSimple.ts 的本地 helper 模式）。
- [ ] **Step 4: 跑测试通过** 同 Step 2 命令 → PASS。
- [ ] **Step 5: 提交** `git add src/settingsFrame.ts tests/settingsFrame.test.ts && git commit -m "feat(settings): add single-page frame skeleton"`。

### Task 2: 右上角浮动同步提示

**Files:**
- Create: `src/syncNoticeUi.ts`
- Modify: `src/main.ts`（onload 中 status bar 创建之后接线，约 :1368 后）
- Test: `tests/syncNoticeUi.test.ts`

**Interfaces:**
- Consumes: `plugin.onSyncUiUpdate(cb)` 订阅（main.ts:264，返回退订函数——以现有 `syncUiListeners` 实现为准）；`plugin.syncUiActivity`（SyncActivity，含 `trigger`、`progress: SyncProgressSnapshot`、`status`）；`progressStatus(p): string`（src/syncProgressUi.ts:7）。
- Produces:
```ts
export function createSyncNotice(
  plugin: RemotelySavePlugin,
  opts?: { dismissMs?: number },   // 默认 4000
): { destroy(): void };
```
行为：订阅回调中读 `plugin.syncUiActivity`；`trigger` 非 "manual"/"dry" 或无 activity → 不创建；创建时向 `document.body` 追加 `div.rsnext-sync-notice`（`position:fixed; top/right`，仅用主题变量），内容 = 提示文字（`progressStatus(progress)`）+ `<progress>`（completed/plan 总数）；`phase==="finished"` 或 activity 终态（status ∈ success/failed/paused/cancelled）→ 内容换为一行结果摘要，`dismissMs` 后移除元素；`destroy()` 移除元素并退订。main.ts 接线：`this.register(() => notice.destroy())`。

- [ ] **Step 1: 写失败测试** `tests/syncNoticeUi.test.ts`（JSDOM fixture，fake plugin 手持监听器数组）：① activity={trigger:"manual", progress:{phase:"syncing",…}} 触发 → body 出现 `.rsnext-sync-notice`，含 `<progress>` 且文本含 `progressStatus` 输出；② trigger:"auto" → 不出现；③ progress.phase="finished" 且 status:"success" → 出现摘要文本，等待 `dismissMs=5` 后元素移除；status:"paused" 同样移除；④ `destroy()` → 元素移除且再触发回调不重建。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 `src/syncNoticeUi.ts` + main.ts 接线** 按 Produces；结果摘要文案硬编码中文（如「同步完成」「同步已暂停」）。
- [ ] **Step 4: 跑测试通过** → PASS。
- [ ] **Step 5: 提交** `git add src/syncNoticeUi.ts src/main.ts tests/syncNoticeUi.test.ts && git commit -m "feat(sync): floating top-right sync progress notice"`。

### Task 3: Frame 常驻进度行

**Files:**
- Modify: `src/settingsFrame.ts`
- Test: `tests/settingsFrame.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `createSyncProgress(status: HTMLElement, getActivity: () => SyncActivity | undefined): { update(): void }`（src/syncProgressUi.ts:18）；`createSyncControls(run: HTMLButtonElement, plugin): () => void`（src/syncControlsUi.ts:3）；`plugin.onSyncUiUpdate`；`plugin.syncUiActivity`。
- Produces: `SettingsFrame` 不变（`progressHost` 被填充：状态文字 span + `createSyncProgress` + 「立即同步」按钮 `plugin.syncRun("manual")` + `createSyncControls`）；frame 内部订阅 `onSyncUiUpdate → update()`，`cleanup()` 退订。

- [ ] **Step 1: 追加失败测试**（同一测试文件新 describe「进度行」）：① 渲染后 progressHost 内存在 `<progress>` 与立即同步按钮；② 触发监听回调（fake `syncUiActivity`）→ status 文本与 progress 值反映快照；③ `cleanup()` 后再触发回调不抛错、监听器数组为空（无泄漏）。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现** 在 `createSettingsFrame` 内创建进度行并保存退订函数。
- [ ] **Step 4: 跑测试通过（含 Task 1 全部）** → PASS。
- [ ] **Step 5: 提交** `git add src/settingsFrame.ts tests/settingsFrame.test.ts && git commit -m "feat(settings): persistent inline progress row in frame"`。

### Task 4: 同步记录折叠区模块

**Files:**
- Create: `src/settingsRecords.ts`
- Test: `tests/settingsRecords.test.ts`

**Interfaces:**
- Consumes: 现有记录行渲染逻辑（settingsWebdavSimple.ts:311 `renderHistory`、settingsQuarkSimple.ts:580、settingsAliyunSimple.ts:614、settingsBaiduQr.ts:51 —— 四份近似重复，以 webdav 版为基准抽取）；`plugin.getSyncActivities()`；`.rsnext-record` / `.rsnext-path-tree` 现有 CSS。
- Produces:
```ts
export interface RecordsHandle { refresh(): void; cleanup(): void; }
export function createRecordsSection(
  sectionEl: HTMLElement,
  plugin: RemotelySavePlugin,
): RecordsHandle;
```
行为：挂载记录列表（时间/方向/文件数/结果 + 行展开路径明细），`refresh()` 重读 `getSyncActivities()` 重渲染；内部订阅 `onSyncUiUpdate`（终态时 refresh），cleanup 退订。展开态/诊断摘要沿用 `appendProgressResult`（syncProgressUi.ts:58）的呈现（该函数由 single-page 在同步结束时调用，或 refresh 时对最新记录补渲染——实现取与现有 webdav 行为一致者）。

- [ ] **Step 1: 写失败测试** `tests/settingsRecords.test.ts`（fixture 给 `getSyncActivities` 返回 2 条成功 + 1 条 partial 记录）：① 渲染 3 行，结果文字分别为 已完成/部分完成；② 点击行展开显示文件路径；③ mock 新记录后触发回调 → 行数变 4；④ `cleanup()` 后监听器数组为空。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 `src/settingsRecords.ts`** 抽取自 webdav 版 renderHistory，硬编码中文沿用。
- [ ] **Step 4: 跑测试通过** → PASS。
- [ ] **Step 5: 提交** `git add src/settingsRecords.ts tests/settingsRecords.test.ts && git commit -m "feat(settings): shared sync records section"`。

### Task 5: 行内展开助手 + 「基本」区抽取

**Files:**
- Create: `src/settingsSections.ts`
- Modify: `src/settings.ts`（renderLegacy 基本块 :2091-2233 改为调用新函数）
- Test: `tests/settingsSections.test.ts`

**Interfaces:**
- Consumes: `PasswordModal`(settings.ts:86) / `EncryptionMethodModal`(settings.ts:173) 的字段与文案逻辑（改为行内实现后这两个类在 Task 13 删除）；`getEyesElements`/`wrapTextWithPasswordHide`(settings.ts:812/821)；`t(...)` i18n 惯用法。
- Produces:
```ts
export function openInlineExclusive(host: HTMLElement, render: (el: HTMLElement) => (() => void) | void): void;
export function renderBasicSection(
  el: HTMLElement,
  plugin: RemotelySavePlugin,
  opts: { advancedOnly: boolean; showAutomation: boolean; redisplay: () => void },
): void;
```
行为：`openInlineExclusive` 维护模块级"当前打开"记录，打开新的先关闭旧的（互斥）。`renderBasicSection` 迁移密码行（按钮 → 行内密码输入+确认块，确认时 `saveSettings` **先于**任何后续触发）、加密方式行（下拉/按钮 → 行内单选块）、`automationDiv`（autorun/runonce/synconsave，`opts.showAutomation=false` 或 `advancedOnly=true` 时隐藏——保持 renderLegacy 现有条件语义 :2144）。renderLegacy 原位置改为调用 `renderBasicSection`（single source，行为不变）。

- [ ] **Step 1: 写失败测试** `tests/settingsSections.test.ts`：① `renderBasicSection` 渲染 `settings_password`/`settings_encryptionmethod` 对应标签（通过 i18n mock 或现有 t 键断言文本存在）；② 打开密码行内块 → 出现输入框，再打开加密行内块 → 密码块关闭（互斥）；③ 密码确认点击 → `saveSettings` 被调用（断言调用顺序在前）；④ `showAutomation:false` → autorun 行不存在，`true` 且 `advancedOnly:false` → 存在；⑤ renderLegacy 委托后 `npx mocha --import=tsx 'tests/settingsLayout.test.ts'` 及涉及 legacy 渲染的现有测试仍绿。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 `src/settingsSections.ts`（openInlineExclusive + renderBasicSection）并改 settings.ts 基本块为委托调用。**
- [ ] **Step 4: 跑新测试 + 相关旧测试通过** → PASS。
- [ ] **Step 5: 提交** `git add src/settingsSections.ts src/settings.ts tests/settingsSections.test.ts && git commit -m "feat(settings): extract basic section with inline password/encryption"`。

### Task 6: 「高级」区抽取 — 排除规则 + 同步配置目录

**Files:**
- Modify: `src/settingsSections.ts`（追加导出）
- Modify: `src/settings.ts`（renderLegacy adv 块 :2234-2625 中排除规则 :2293 与同步配置目录 :2392 部分改为委托）
- Test: `tests/settingsSections.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `SyncConfigDirModal`(settings.ts:695) 字段逻辑（改行内）；`createSettingsSection`；ignore-paths 现有字段（含增删行交互）。
- Produces:
```ts
export function renderAdvancedSection(
  el: HTMLElement,
  plugin: RemotelySavePlugin,
  opts: { desktop: boolean; redisplay: () => void },
): void;   // 排除规则（忽略路径列表编辑）+ 同步配置目录（行内编辑块）
```

- [ ] **Step 1: 追加失败测试**：① 渲染忽略路径添加/删除控件，添加一条 → `saveSettings` 收到新数组；② 同步配置目录行内块可打开编辑并保存，与密码行内互斥（复用 openInlineExclusive 断言）；③ renderLegacy 委托后旧 adv 相关测试仍绿。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 + settings.ts 委托改造。**
- [ ] **Step 4: 跑测试通过** → PASS。
- [ ] **Step 5: 提交** `git add src/settingsSections.ts src/settings.ts tests/settingsSections.test.ts && git commit -m "feat(settings): extract advanced section (ignore paths, config dir inline)"`。

### Task 7: 导入导出 + 调试区抽取

**Files:**
- Modify: `src/settingsSections.ts`（追加导出）
- Modify: `src/settings.ts`（renderLegacy :2630-2799 importExport、:2836-end debug 改为委托；`ExportSettingsQrCodeModal`(settings.ts:748) 改为行内二维码块）
- Test: `tests/settingsSections.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `messyConfigToNormal`/导出导入 API（importExport.ts）；`ExportSettingsQrCodeModal` 内部二维码渲染（改行内复用）。
- Produces:
```ts
export function renderImportExportSection(el: HTMLElement, plugin: RemotelySavePlugin): void; // 导入/导出设置 + 4 服务二维码导出行内
export function renderDebugSection(el: HTMLElement, plugin: RemotelySavePlugin): void;         // 现有 debug 块原样迁移
```
（两函数由 single-page 合入「高级」区；renderLegacy 过渡期委托调用。）

- [ ] **Step 1: 追加失败测试**：① 导出按钮（导入设置/导出设置/导出二维码）渲染且点击导出触发既有回调 mock；② 二维码行内块打开出现 QR 占位且与其它行内互斥；③ debug 块关键行存在（如 `reset` 相关按钮文案）。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 + settings.ts 委托改造**（导出二维码仅保留 4 原生服务按钮，dropbox/onedrive/s3 等按钮随迁移删除——渲染处不再生成即可，main.ts 协议处理不动）。
- [ ] **Step 4: 跑测试通过 + `npm test` 全绿** → PASS。
- [ ] **Step 5: 提交** `git add src/settingsSections.ts src/settings.ts tests/settingsSections.test.ts && git commit -m "feat(settings): extract import/export and debug sections"`。

### Task 8: Single-page 装配 + WebDAV 迁移

**Files:**
- Create: `src/settingsSinglePage.ts`
- Modify: `src/settings.ts`（`display()` :847 前插入 webdav 分支；删除 webdav 相关 modal 引用由 Task 13 收尾，本任务仅加分支）
- Modify: `src/settingsWebdavSimple.ts`（重构为连接区片段，删除 tabs/自带记录）
- Test: `tests/settingsSinglePage.test.ts`（新建）；`tests/settingsWebdavSimple.test.ts`（改写）

**Interfaces:**
- Consumes: `createSettingsFrame`（T1/T3）、`createRecordsSection`（T4）、`renderBasicSection`（T5）、`renderAdvancedSection`（T6）、`renderImportExportSection`/`renderDebugSection`（T7）。
- Produces:
```ts
// src/settingsSinglePage.ts
export function renderSettingsSinglePage(
  containerEl: HTMLElement,
  plugin: RemotelySavePlugin,
  desktop: boolean,
): () => void;   // cleanup：调用各子块 cleanup 之和
```
内部顺序：`createSettingsFrame`（unsupported = 当前 serviceType 不在 4 项内）→ 连接区按 `serviceType` switch（webdav → `renderWebdavConnection`；default → 警告条「当前配置的服务已不再支持，请重新选择服务」——unknown 服务仍渲染基本/高级/记录区）→ 基本区 `renderBasicSection`（`showAutomation = serviceType === "webdav"`）→ 高级区（T6+T7 两函数）→ 记录区 `createRecordsSection` → `onServiceChange` 触发 `plugin.settings.serviceType = s; saveSettings; redisplay()`。
```ts
// src/settingsWebdavSimple.ts — 新导出（旧 renderSimpleWebdav 删除）
export function renderWebdavConnection(
  parent: HTMLElement,
  plugin: RemotelySavePlugin,
  ctx: { desktop: boolean; redisplay: () => void;
         setStatus(s: ConnectionState, text: string): void;
         setTester(t: (() => Promise<{ ok: boolean; message: string }>) | null): void; },
): () => void;   // 地址/账号/密码/目标目录/测试连接(注册到头部) + 远程目录行内编辑
```
远程目录：替代 `ChangeRemoteBaseDirModal`(settings.ts:212) 的行内编辑块，实现为 `settingsWebdavSimple.ts` 内私有函数或 `settingsSections.ts` 导出 `createRemoteBaseDirRow`（若 Task 9-11 的 steps 复用则导出）。

`display()` 分支形状（插在现有 switch 最前）:
```ts
if (this.plugin.settings.serviceType === "webdav") {
  this.simpleCleanup = renderSettingsSinglePage(this.containerEl, this.plugin, Platform.isDesktopApp);
  return;
}
```

- [ ] **Step 1: 写失败测试** `tests/settingsSinglePage.test.ts`：① serviceType="webdav" → 渲染 frame 四折叠区 + 连接区字段（address/serverUrl 等 4 字段断言，移植自 settingsWebdavSimple.test.ts:66-86）；② serviceType="s3"（cast as any）→ 警告条可见且无异常、基本/记录区仍渲染；③ 下拉切到 "baidu" → `saveSettings` 调用且 serviceType 更新；④ cleanup 后 container 空、监听器数组空。改写 `tests/settingsWebdavSimple.test.ts`：删除 tabs/records 相关旧断言，保留字段、persist-before-test、锁定行为、测试连接断言（改走 ctx.setTester/头部按钮路径），懒加载高级改为断言 frame 高级区 toggle 渲染 ignore-paths。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现三个文件的改动**（重构 settingsWebdavSimple 时把记录渲染职责交给 T4 模块、tabs 删除、`advanced` 回调参数删除）。
- [ ] **Step 4: 新旧测试通过** `npx mocha --import=tsx 'tests/settingsSinglePage.test.ts' 'tests/settingsWebdavSimple.test.ts' 'tests/settingsFrame.test.ts'` → PASS；`npm test` 全绿（renderLegacy 路径未动）。
- [ ] **Step 5: 提交** `git add src/settingsSinglePage.ts src/settingsWebdavSimple.ts src/settings.ts tests/settingsSinglePage.test.ts tests/settingsWebdavSimple.test.ts && git commit -m "feat(settings): single-page assembly with webdav migration"`。

### Task 9: 百度扫码登录行内化 + 迁移

**Files:**
- Modify: `src/native/settingsBaiduQr.ts`（从 `BaiduQrLoginModal` 抽出可复用行内渲染）
- Modify: `src/settingsBaiduQr.ts`（重构为连接区片段，删 tabs）
- Modify: `src/settingsSinglePage.ts`（连接 switch 增加 baidu 分支）
- Modify: `src/settings.ts`（display() 增加 baidu 分支，形状同 Task 8；原 openLogin modal 回调移除）
- Test: `tests/settingsBaiduQr.test.ts`（改写）

**Interfaces:**
- Consumes: T8 的 `renderSettingsSinglePage` 装配与 `ConnectionState`；`verifyBaiduQrSession`。
- Produces:
```ts
// native/settingsBaiduQr.ts
export function renderBaiduQrLoginBlock(host: HTMLElement, plugin: RemotelySavePlugin, done: () => void): () => void;
// 现有 BaiduQrLoginModal 类保留（main.ts 协议回调仍用），内部改为委托 renderBaiduQrLoginBlock
// settingsBaiduQr.ts 新导出
export function renderBaiduQrConnection(parent, plugin, ctx): () => void;  // ctx 形状同 T8
```
百度 prepare/verify 逻辑（现 display() :856-862 附近）移入 `settingsBaiduQr.ts`。二维码倒计时/刷新/轮询逻辑从模态类原样搬入 `renderBaiduQrLoginBlock`。

- [ ] **Step 1: 改写失败测试** `tests/settingsBaiduQr.test.ts`：① QR 登录改为行内块（打开连接区登录行 → 出现 QR 区块，无 Modal 实例化——通过断言 `document.querySelector(".modal")` 不存在）；② verify 门禁同步（现有断言保留）；③ 服务切换/目录回滚断言保留（改走 frame 下拉路径）；④ 原生 `native/settingsBaiduQr.test.ts` 模态测试仍绿（模态类保留委托后行为不变）。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现四处改动。**
- [ ] **Step 4: 测试通过** `npx mocha --import=tsx 'tests/settingsBaiduQr.test.ts' 'tests/native/settingsBaiduQr.test.ts' 'tests/settingsSinglePage.test.ts'` → PASS。
- [ ] **Step 5: 提交** `git add src/native/settingsBaiduQr.ts src/settingsBaiduQr.ts src/settingsSinglePage.ts src/settings.ts tests/settingsBaiduQr.test.ts && git commit -m "feat(settings): baidu qr login inline + single-page migration"`。

### Task 10: 夸克迁移

**Files:**
- Modify: `src/native/settingsQuark.ts`（`QuarkLoginModal` 抽出 `renderQuarkLoginBlock`，模态保留委托）
- Modify: `src/settingsQuarkSimple.ts`（重构为 `renderQuarkConnection`，删 tabs）
- Modify: `src/settingsSinglePage.ts`（quark 分支）；`src/settings.ts`（display quark 分支，prepare 逻辑移入片段文件）
- Test: `tests/settingsQuarkSimple.test.ts`（改写）

**Interfaces:**
- Consumes: T8 装配；`QuarkSetupActions.prepare`（settings.ts:867-873 现逻辑迁入片段）。
- Produces: `renderQuarkLoginBlock(host, plugin, done): () => void`；`renderQuarkConnection(parent, plugin, ctx): () => void`（ctx 形状同 T8）。

- [ ] **Step 1: 改写失败测试**（对照 T9 同型断言：行内登录无 Modal、三步顺序保留、prepare/verify 门禁、in-flight 拒绝、持久化回滚、安全诊断——现有断言全部移植）。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现改动。**
- [ ] **Step 4: 测试通过** `npx mocha --import=tsx 'tests/settingsQuarkSimple.test.ts' 'tests/native/settingsQuark.test.ts' 'tests/settingsSinglePage.test.ts'` → PASS。
- [ ] **Step 5: 提交** 同型 commit `feat(settings): quark inline login + single-page migration`。

### Task 11: 阿里云盘迁移

**Files:**
- Modify: `src/native/settingsAliyun.ts`（`AliyunLoginModal` → `renderAliyunLoginBlock`）
- Modify: `src/settingsAliyunSimple.ts`（→ `renderAliyunConnection`）
- Modify: `src/settingsSinglePage.ts`（aliyun 分支）；`src/settings.ts`（display aliyun 分支，prepare/verify 迁入片段）
- Test: `tests/settingsAliyunSimple.test.ts`（改写）

**Interfaces:** 同 T10 形状（`renderAliyunLoginBlock` / `renderAliyunConnection`）；prepare 逻辑现 display() :863-869 迁入。

- [ ] **Step 1: 改写失败测试**（同 T10 断言集）。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现改动。**
- [ ] **Step 4: 测试通过** `npx mocha --import=tsx 'tests/settingsAliyunSimple.test.ts' 'tests/settingsSinglePage.test.ts'` → PASS。
- [ ] **Step 5: 提交** `feat(settings): aliyun inline login + single-page migration`。

### Task 12: display() 完全切换 + 未支持服务处理

**Files:**
- Modify: `src/settings.ts`（`display()` :847-877 整体替换为单行装配；`renderLegacy` 标记不可达但不删——Task 13 删）
- Test: `tests/settingsSinglePage.test.ts`（追加）

**Interfaces:**
- Consumes: T8-T11 全部分支与 `renderSettingsSinglePage`。
- Produces: `display()` 终态：
```ts
display(): void {
  this.simpleCleanup?.();
  this.containerEl.empty();
  this.simpleCleanup = renderSettingsSinglePage(this.containerEl, this.plugin, Platform.isDesktopApp);
}
```

- [ ] **Step 1: 追加失败测试**：① 四种 serviceType 均路由 single-page（断言 frame 存在、无 legacy 容器类）；② `serviceType="dropbox"`（as any）→ 警告条 + 基本/高级/记录可用，不抛错；③ 同步中（fake isSyncing）调用 display() 两次 → 进度行唯一、监听器数组长度为 1（Review Focus #2 重入断言）。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 替换 display() 实现。**
- [ ] **Step 4: `npm test` 全绿**（此时 renderLegacy 无调用方，仅死代码）。
- [ ] **Step 5: 提交** `git add src/settings.ts tests/settingsSinglePage.test.ts && git commit -m "feat(settings): cut over display() to single page"`。

### Task 13: 删除遗留服务 UI 与死代码

**Files:**
- Modify: `src/settings.ts`（删 :310-693 四个 legacy 模态、`renderLegacy` :878-3095、imports :38-63 中 dropbox/onedrive/s3/pro 项、`renderLegacy` 残留的 service div/generate* 引用）
- Modify: `src/main.ts`（删 dropbox/onedrive/onedrivefull/pro/box/pcloud/yandexdisk/koofr 协议处理与命令回调 :768-1295 相应段落、imports :36-108 裁剪；保留 baidu/quark/aliyun/webdav 协议处理）
- Modify: `src/importExport.ts`（删 :48-73 中 legacy 服务导出分支与 imports :4,11）
- Modify: `src/settingsLayout.ts`（删 `getServiceChoices`，保留 `DEFAULT_SERVICE_TYPE`、`createSettingsSection`）
- Delete: `src/settingsBaiduSimple.ts`、`src/settingsServicePicker.ts`、`tests/settingsBaiduSimple.test.ts`、`tests/settingsServicePicker.test.ts`
- Modify: `tests/settingsLayout.test.ts`（删 choices 相关断言，保留 details 可访问性断言）、`tests/native/baiduService.test.ts`（:54-66 legacy choices 断言删除或改写）
- Test: 全量 `npm test`

**Interfaces:** 无新产出；编译驱动清理——以 `npx tsc --noEmit`（或项目既有 typecheck/build 命令）报错清单为准绳，逐项删除引用。`SUPPORTED_SERVICES_TYPE` 联合、`fsGetter`、`baseTypes` 配置类型**不动**（P2）。

- [ ] **Step 1: 删除前基线** `npm test` 记录绿基线（Task 12 Step 4 结果复用即可）。
- [ ] **Step 2: 执行删除**（按 Files 清单；settings.ts 单文件删除量大，分小批提交前先跑 typecheck）。
- [ ] **Step 3: typecheck + 全量测试** `npx tsc --noEmit` 无错（若项目无 typecheck 脚本则以 `npm run build` 替代）→ `npm test` PASS。
- [ ] **Step 4: 提交** `git add -u src/settings.ts src/main.ts src/importExport.ts src/settingsLayout.ts tests/ && git rm src/settingsBaiduSimple.ts src/settingsServicePicker.ts tests/settingsBaiduSimple.test.ts tests/settingsServicePicker.test.ts && git commit -m "feat(settings): remove legacy service settings UI and dead code"`（注意 `git add -u` 仅限列出的已跟踪文件，勿混入无关改动；若 -u 范围过大改为逐文件 add）。

### Task 14: styles.css 精简

**Files:**
- Modify: `styles.css`（删 :20-242 legacy hide 类、`.rsnext-tabs`、`.rsnext-service-picker`、`.rsnext-setup-*`、`.rsnext-step-*`、`.rsnext-mobile-guide` 等已无引用类；新增 `.rsnext-sync-notice`（fixed top-right，主题变量）、行内展开块、警告条、头部 flex 布局的最小样式）
- Test: 无独立测试（Task 15 全量验证）

- [ ] **Step 1: 引用核查** `grep -ro "rsnext-[a-z-]*" src/ | sort -u` 对照 styles.css 选择器，列出无引用类与缺失类（人工核对后执行）。
- [ ] **Step 2: 删除与新增** 按核查结果；新增样式全部走 Obsidian 变量（`--background-primary`、`--background-modifier-border`、`--text-muted`、`--interactive-accent`、`--color-green/red/yellow`）。
- [ ] **Step 3: 全量测试 + 构建** `npm test` + `npm run build` PASS。
- [ ] **Step 4: 提交** `git add styles.css && git commit -m "feat(styles): slim rsnext styles for single-page settings"`。

### Task 15: 终验

- [ ] **Step 1: 全量验证** `npm test` → 全绿；`npx biome check src tests` → 无错（或项目既有 lint 命令）；`npm run build` → 产物生成。
- [ ] **Step 2: 手工冒烟清单（对照 spec §8）** 在 Obsidian 中：① 设置页仅 4 服务下拉、恰好四折叠区；② 选服务→地址/授权→测试连接→同步→记录，全程零模态；③ ribbon/命令启动同步 → 右上角浮动提示带进度条与文字、终态摘要消失；设置内进度行同步可见、可暂停/停止；④ 明暗主题与第三方主题下无自造色；⑤ 旧配置（s3）打开设置显示警告不崩溃。
- [ ] **Step 3: 修复冒烟发现的问题并回归** `npm test`。
- [ ] **Step 4: 提交**（如有修复）逐文件 add。

---

## 计划外事项（移交）

- **P2 后端清退计划**（fsDropbox/fsOnedrive/fsS3/fsWebdis 删除、fsGetter 裁剪、pro 传输删除、`SUPPORTED_SERVICES_TYPE` 收窄、i18n 键清理、docs/remote_services 清理）：待本计划落地后按新行号单独编写，避免行号失效。
- 本计划未覆盖移动端专属布局（spec §5 非目标），480px 单列降级沿用现有 `@container` 规则。
