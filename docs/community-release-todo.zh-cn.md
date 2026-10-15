# remotely-save-next 发布 TODO

本文记录从现有 Remotely Save fork 建立独立 GitHub 项目，并申请加入 Obsidian 社区插件目录所需的工作。状态按 2026-10-15 整理。

## 已确认

- [x] 项目产品名和插件 ID 使用 `remotely-save-next`，版本进入 `0.2.x`。
- [x] 保留手机端 WebDAV：`src/fsWebdav.ts` 在桌面端调用专用 WebDAV transport，在手机端走 Obsidian `requestUrl`。
- [x] 百度、夸克、阿里云的设置页会提示用户改用电脑端；这些网盘目前不支持移动端操作。
- [x] 保留原项目来源与授权文件，并通过 `UPSTREAM.md` 说明来源。

## 发布阻塞项

- [ ] **确定移动端与目录审核的兼容方案。** 当前桌面传输会在运行时加载 `node:http`、`node:https`、`node:zlib`；Obsidian 社区目录规则要求使用 Node/Electron API 的插件在 `manifest.json` 设置 `isDesktopOnly: true`。直接设为 `true` 会失去手机端 WebDAV 安装能力；保持 `false` 则存在审核不通过风险。先评估是否能将传输重构为符合多端政策的 API，并验证大文件、隧道、超时、取消和压缩响应行为，再决定是否提交。不要在方案验证前改成仅桌面插件。
- [ ] 核对 fork 发布资格：按 Obsidian 开发政策联系原作者，保留联系记录，并确认等待期及作者署名要求。原作者已经停止更新的事实本身不应替代政策要求的证据流程。
- [ ] 修订英文 `README.md`：更新至当前版本和真实功能状态，说明手机端/桌面端支持范围、保存凭据方式、报告问题的方法，以及百度/夸克/阿里云和 WebDAV 所访问的服务与用途。
- [ ] 确认 `manifest.json` 描述不超过 250 个字符并以 ASCII `.` 结尾；根据最终多端方案设置 `isDesktopOnly` 与合理的 `minAppVersion`。
- [ ] 检查图标、许可证、项目主页、隐私说明和所有继承的文档、工作流；移除旧项目名称造成的误导，但保留必要的上游署名和许可证。
- [ ] 将 `cloudflared.html` 等本地测试/诊断资料排除在公开仓库和发布包之外；发布内容只包括源代码和必要项目文件。
- [ ] 重新验证所有测试、类型检查和生产构建；在干净的桌面与 Android/iOS 测试库中验收 WebDAV，再验收桌面端各网盘。

## GitHub 独立项目

- [ ] 重新登录或修复本机 GitHub CLI 凭据；当前 `gh auth status` 报告凭据无效。
- [ ] 决定从现有 fork 脱离 fork network，还是新建空仓库后推送现有历史；操作前检查 GitHub 是否允许脱离（公开仓库、仓库大小、子 fork 等条件）。
- [ ] 建立以 `remotely-save-next` 为名的公开 GitHub 仓库，确认默认分支、Issues、Actions 和仓库描述。
- [ ] 清理/更新 GitHub Actions：确认 release 工作流可生成社区所需的单文件插件包，移除失效的旧上游密钥/签署流程，并确认 secrets 未被写入公开日志。
- [ ] 推送前检查 staged 文件与历史中是否含令牌、Cookie、个人路径、真实用户数据或 `cloudflared.html`；首个独立发行版本定为 `0.2.0`。
- [ ] 发布 GitHub Release：tag 与 `manifest.json` 版本完全一致，并附加单独的 `main.js`、`manifest.json`，以及存在时的 `styles.css`。

## Obsidian 社区目录申请

- [ ] 登录 Obsidian 社区目录并关联 GitHub 账号。
- [ ] 确认社区目录关于 fork、Node API、多端支持及 README 网络披露的最新审核要求。
- [ ] 满足 fork 发布政策和移动端/API 架构阻塞项后，提交 GitHub 仓库并跟进自动化审核与人工反馈。
- [ ] 获批后检查目录条目、安装流程、更新通知及首批用户反馈。

## 需要作者/维护者本人完成或确认

- [ ] 确认是否愿意在解决 Node API 与手机支持冲突前，暂缓社区目录申请。
- [ ] 处理 GitHub 账号授权，并最终决定仓库脱离 fork network 或新建仓库。
- [ ] 按项目发布政策完成与原作者的联系和署名流程。

## 官方参考

- [Obsidian 插件发布](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [开发者政策](https://docs.obsidian.md/community-directory/developer-policies)
- [设置与认领社区目录账号](https://docs.obsidian.md/community-directory/set-up-and-claim)
- [GitHub：将 fork 脱离 fork network](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/detaching-a-fork)
- [GitHub：重命名仓库](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
