# 设置界面重设计规格 — 方案4「原生极简」

- 状态：待评审
- 选定依据：`demo/scheme-4.html`（可交互原型）+ `demo/index.html` 对比页
- 覆盖日期：2026-10-15（含用户增补：浮动同步提示 / 单一高级区 / 移除遗留服务）

## 1. 背景与目标

当前设置 UI 由三套并存的形态组成：`renderLegacy`（`src/settings.ts:878`，约 2200 行的长表单 + show/hide 切换）、每服务简化页（`settingsWebdavSimple.ts` 等，带「同步设置 / 同步记录」tab）、以及 10+ 个模态框（密码、加密方式、远程目录、扫码登录、OAuth…）。**服务面同时混杂 dropbox/onedrive/s3/webdis/pro 等遗留与付费服务。**

用户选定方案4并增补三条约束，目标：

1. **所有设置类弹窗改为行内展开** — 扫码登录、加密密码、目录修改等在对应设置行原地展开，不遮挡笔记。
2. **取消「同步设置 / 同步记录」分页** — 同一页面的折叠区与列表区，滚动即达。
3. **进度双通道** — ① 设置页标题下方的常驻细进度行，原地展开阶段/速度/暂停·停止；② **新增：右上角浮动同步提示** — 点击 ribbon 图标或手动启动同步时，右上角出现浮动提示条，内含进度条与简短提示文字（阶段 + 百分比 + 当前文件/速度），同步结束显示结果摘要后自动消失，不开设置页也能看到进度。
4. **服务选择 = 第一行的下拉框，仅保留 4 个原生服务**（WebDAV / 百度网盘 / 夸克网盘 / 阿里云盘）；dropbox、onedrive、s3、webdis、pro 付费服务的设置入口与后端兼容全部移除。
5. **折叠区只有四个：连接 / 基本 / 高级 / 同步记录** — 只保留一个「高级」选项，排除规则（忽略路径）、同步配置目录、导入导出、调试信息全部并入「高级」，不再单设分区。
6. **几乎零自造样式** — 只用 Obsidian 主题变量（背景、分隔线、`--text-muted`、`--interactive-accent`、原生红绿黄状态色），任何主题下均为原生观感。
7. **连接状态 = 控件旁小圆点 + 文字** — 黄（测试中）/ 红 / 绿，不引入新色板。

## 2. 目标信息架构（单页布局）

```
[设置头部]  服务: [下拉框 ▾]  ● 已连接（点+文字）   [测试连接]
[常驻进度行]  未同步时空闲态；同步中显示：阶段 · 百分比 · 当前文件 · 速度 · 暂停/停止
── 以下为四个原生折叠区（<details>），同一滚动页 ──
▸ 连接            （地址/账号/授权区；扫码 / OAuth 在此行内展开）
▸ 基本            （密码、加密方式、远程目录、同步策略）
▸ 高级            （排除规则·忽略路径、同步配置目录、导入导出、调试信息）
▸ 同步记录        （历史列表：时间/方向/文件数/结果，行可展开看路径明细）
```

- 复用现有 `settingsLayout.ts` 的 `createSettingsSection()`（已是 `<details>` 助手，测试已保证闭合时控件可访问）。
- 默认展开：连接 + 基本；其余收起。同步中时进度行强制可见。
- **浮动同步提示（新增组件）**：挂载于 `document.body` 右上角，z-index 高于设置面板；与设置内进度行**同源**（均消费 `syncProgress.ts` 快照 / `progressStatus`）；手动触发路径（ribbon 点击、命令面板、设置页「立即同步」）创建并持续更新，同步终态（成功/失败/停止）显示一行结果摘要后自动淡出关闭；定时自动同步不弹此提示，状态栏继续作为常驻兜底。

## 3. 模态框改造清单

**改为行内展开：**

| 模态 | 位置 | 行内形态 |
|---|---|---|
| `PasswordModal` (settings.ts:86) | 基本 | 行内密码输入块 |
| `EncryptionMethodModal` (settings.ts:173) | 基本 | 行内单选块 |
| `ChangeRemoteBaseDirModal` (settings.ts:212) | 连接 | 行内目录编辑 + 确认/取消 |
| `SyncConfigDirModal` (settings.ts:695) | 高级 | 行内编辑块 |
| `ExportSettingsQrCodeModal` (settings.ts:748) | 高级 | 行内二维码块 |
| `BaiduQrLoginModal` / `QuarkLoginModal` / `AliyunLoginModal` (native/*) | 连接 | 行内扫码块（含倒计时/刷新），复用现有模态内部渲染逻辑 |

**随遗留服务删除（不再行内化）：** `ChangeS3RemotePrefixModal` (:310)、`DropboxAuthModal` (:388)、`OnedriveAuthModal` (:551)、`OnedriveRevokeAuthModal` (:625)，以及 `pro/src/*` 全部服务模态。

**保留模态（非设置 UI，运行期确认）：** `SyncProtectionModal`（同步时保护，main.ts:677）、`SyncAlgoV3Modal`（同步前通知）、`ClearDupFiles` 等。

## 4. 代码改造面

- **`display()` 分派（settings.ts:847）**：收敛为单一渲染器 —— 下拉列出 4 个原生服务，`serviceType` 决定连接区内容；**不再有 `renderLegacy` 回落**。
- **`renderLegacy` 整体退役**：服务选择器、S3/Dropbox/OneDrive/webdis/pro 设置块全部删除；其中与服务无关的通用字段块（加密、排除规则、导入导出、调试）迁入新单页对应折叠区。
- **遗留服务清退（UI 层）**：`settings.ts` 中 dropbox/onedrive/s3/webdis/pro 相关渲染与模态删除；pro 服务设置模块（`pro/src/settings*.ts`）从设置页移除。
- **遗留服务清退（后端层）**：dropbox/onedrive/s3/webdis/pro 的传输实现、服务分发分支与 pro 服务代码删除；旧配置键的读取保持兼容（已存配置不报错，仅提示服务不再支持）。**具体文件与测试清单在实施计划阶段盘点确定。**
- **简化页文件**（settingsWebdavSimple/BaiduQr/Quark/AliyunSimple）：拆解为「连接区内容片段 + 记录列表片段」两个可复用函数；删 tab；`renderSimpleBaidu` 已无生产调用方（仅测试），直接废弃。
- **进度 UI**：`createSyncProgress`/`createSyncControls` 移至头部下方常驻行；新增浮动提示组件（见 §2），两者同源消费同步状态。状态栏（main.ts:1367）保持不变。
- **样式**：`styles.css:264-334` 的 `.rsnext-*` 按新布局重写为极简增量（布局/间距/圆点色/浮动提示条），删除 tab、卡片选择器、setup-steps 等被替代的类。
- **i18n**：沿用现状机制 —— 通用字段走 Mustache `settings_*`/`modal_*` 键，新简化页沿用硬编码中文；清退服务的键随 P2 删除。

## 5. 非目标

- 状态栏、ribbon 图标视觉、命令面板、`obsidian://` 协议处理：不变（ribbon 点击仅新增浮动提示副作用）。
- 同步运行期的保护/通知模态：不变。
- 定时自动同步不弹浮动提示（避免打扰）。
- 移动端专属布局（仅保留现有 480px 单列降级）。
- 视觉超出 Obsidian token 的任何自定义设计（方案4 的核心约束）。

## 6. 分期

- **P1（重设计）**：单页骨架（连接/基本/高级/同步记录四折叠区）+ 服务下拉（4 服务）+ 常驻进度行 + **右上角浮动同步提示** + 连接区行内化 + 6 组模态行内化 + 通用字段迁入 + `renderLegacy` 与遗留服务设置 UI 删除 + 样式精简 + 测试改写。
- **P2（后端清退）**：dropbox/onedrive/s3/webdis/pro 传输实现与 pro 服务代码删除 + 相关测试、i18n 键、`docs/ui` 旧设计文档清理。

P1 完成后设置页仅 4 服务、零模态；P2 完成后仓库中不再有遗留服务代码。

## 7. 测试策略

现有 JSDOM 设置测试对 tab、模态、服务选择器有直接断言，P1 会使其失效，需同步改写（不删断言意图，改断言目标）：

- `tests/settingsWebdavSimple.test.ts` — 改为断言四折叠区、行内进度、无 tab。
- `tests/settingsBaiduQr.test.ts` / `native/settingsBaiduQr.test.ts` — 模态 → 行内扫码块断言。
- `tests/settingsQuarkSimple.test.ts` / `settingsAliyunSimple.test.ts` / `native/settingsQuark.test.ts` — 登录步骤行内化断言。
- `tests/settingsServicePicker.test.ts` — radio 选择器 → 下拉框断言（或文件随功能废弃）。
- `tests/settingsLayout.test.ts` — 保留（`createSettingsSection` 是新骨架地基）。
- 保留不动：`syncProgress*`、`syncControl*`、`syncActivity*`、`transferSpeed*` 等纯逻辑测试。
- P2：涉及 dropbox/onedrive/s3/webdis/pro 的测试随代码删除（清单实施时盘点）。

新增测试：

1. 单页渲染分派（serviceType → 连接区内容，下拉仅 4 项）。
2. 行内展开互斥（一次只开一个）。
3. 进度行常驻性（切折叠区不销毁进度状态）。
4. **浮动同步提示**：手动触发创建、进度更新、终态摘要与自动关闭；定时同步不创建。

## 8. 验收标准

1. 打开设置，无任何模态框路径可完成：选服务 → 授权/填地址 → 测试连接 → 同步 → 查看记录（对照 `demo/scheme-4.html`）。
2. 折叠区恰好四个：连接 / 基本 / 高级 / 同步记录；「高级」内含排除规则、同步配置目录、导入导出、调试信息。
3. 设置中服务下拉仅出现 WebDAV、百度网盘、夸克网盘、阿里云盘；全仓库设置页无 dropbox/onedrive/s3/webdis/pro 入口。
4. 点击 ribbon 或手动启动同步 → 右上角浮动提示出现，含进度条与提示文字，实时更新，终态显示结果摘要后自动消失；与设置内进度行数据一致。
5. 同步全程设置内进度行不消失、可暂停/继续/停止；同步结束后记录折叠区自动追加一条。
6. 明/暗主题（含第三方主题）下无自造颜色，仅用主题变量。
7. `npm test`（现有 + 改写后的测试）与 biome 检查通过。
8. 4 个原生服务的所有现有设置项在新单页中可达，无功能黑洞。
