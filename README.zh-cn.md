# netdisk-sync

面向国内使用环境的 Obsidian 同步插件，重点支持 WebDAV、百度网盘、夸克网盘和阿里云盘，简化设置并改进同步稳定性。

这是独立维护的改进项目，基于 fyears 等贡献者的 [Remotely Save](https://github.com/remotely-save/remotely-save) 开发。原项目与本项目的关系及许可证见 [来源说明](UPSTREAM.md)。

原作者 fyears 及 Remotely Save 贡献者在本项目中列为贡献者。

## 当前状态

当前版本 `0.2.0` 为实验版本，尚未完成真实账号和 Obsidian 内完整验收，尚未发布到社区插件目录。

- WebDAV：已有长路径诊断、上传、初始化、删除与 Nextcloud 兼容性修复；0.1.1 提供精简设置、同步记录、保留双方副本和本次大量变更确认。
- 百度：插件直连官方 OAuth，需要自有开放平台应用；支持桌面手动同步和预览。
- 夸克：插件直接生成二维码，用官方 App 扫码，不依赖中转服务；覆盖现有文件前必须通过内置验证。
- 阿里云盘：直接扫码，无需申请应用或中转服务；登录后自动检查，准备目录通过上传、覆盖、下载与清理验证后启用同步。真实账号待验收，见[阿里云盘说明](docs/diagnostics/aliyun-desktop-sync.zh-cn.md)。
- 三种原生网盘暂限单文件 64 MiB、明文或 OpenSSL；空明文文件和自动同步尚不支持。

完整功能状态及边界见 [当前进度](docs/diagnostics/current-status.zh-cn.md)。

## 本地安装与第一步测试

```sh
npm ci --ignore-scripts
npm run package:plugin
```

将 `dist/netdisk-sync/` 中的 `main.js`、`manifest.json`、`styles.css` 放到专用测试仓库的
`.obsidian/plugins/netdisk-sync/`，重启 Obsidian，在社区插件列表启用 **netdisk-sync**。

第一步只验证插件能否加载、名称是否正确、设置页能否打开，不登录网盘、不执行同步。
新插件使用独立的插件 ID、配置 URI 和本地数据库，不会自动读取原插件的配置或同步历史。
测试仓库若已有原插件，先停用它，避免两个插件对同一仓库同时执行同步。

后续按 [本地调试说明](docs/how_to_debug/local-development.zh-cn.md)、[百度说明](docs/diagnostics/baidu-desktop-sync.zh-cn.md)、[夸克说明](docs/diagnostics/quark-desktop-sync.zh-cn.md) 分步进行。

## 开发验证

```sh
npm run test:baseline
npx tsc --noEmit --skipLibCheck
```

Node 版本以 `.nvmrc` 为准。主构建产物为单个 `main.js`。仅名称变更时做针对性检查，功能验收分步执行。

## 来源与许可证

保留原作者和贡献者的署名及原始许可证；新增及修改内容详见 [UPSTREAM.md](UPSTREAM.md)。
`src` 等目录与 `pro` 目录采用不同许可证，具体以仓库保留的 [LICENSE](LICENSE)、[src/LICENSE](src/LICENSE)、[pro/LICENSE](pro/LICENSE) 为准。

新版页面验收步骤见 [WebDAV 简化界面测试](docs/ui/webdav-acceptance.zh-cn.md)。

百度网盘 0.1.4 简化页面与验收见 [百度页面说明](docs/ui/baidu-redesign.zh-cn.md)。
