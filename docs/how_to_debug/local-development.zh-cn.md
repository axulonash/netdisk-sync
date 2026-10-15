# 本地部署与调试（当前分支）

本指南以 Linux 桌面 Obsidian 为主。使用一个单独的测试仓库和远端测试目录。
当前重点验收 WebDAV。百度、夸克已有实验性桌面端适配器，真实账号验收另行进行。

## 1. 构建环境

安装 Git、Node.js 和 npm。项目 .nvmrc 固定为 26.10.0；如已安装 nvm，在项目目录执行：

```sh
cd /home/axulo/todo/remotely-save
nvm install
nvm use
node --version
npm ci --ignore-scripts
npm run test:baseline
npm run build
```

没有 nvm 时，安装 .nvmrc 指定版本的 Node，再运行后面的 npm 命令。
仓库声明最低 Node 22.13，本分支此前验证使用 26.10.0。
不要用 npm update 代替 npm ci，以免改变依赖锁定结果。
当前采用 webpack 的 build；备用 build2 存在已记录的 BigInt／ES2016 兼容性问题。
测试会启动短暂的 127.0.0.1 HTTP 夹具，不需要网盘账号，也不是持续运行的调试服务器。

## 2. 装到 Obsidian 测试仓库

先在 Obsidian 中新建或打开一个专用测试仓库，例如 `/home/axulo/ObsidianSyncTest`。
以下命令里的路径必须改成该仓库的真实路径，默认使用 `.obsidian` 配置目录：

```sh
cd /home/axulo/todo/remotely-save
sync_test_vault="/home/axulo/ObsidianSyncTest"
mkdir -p "$sync_test_vault/.obsidian/plugins/remotely-save-next"
cp main.js manifest.json styles.css "$sync_test_vault/.obsidian/plugins/remotely-save-next/"
```

插件目录名来自 manifest.json 的 id：remotely-save-next。通常只需复制以上三个文件。
在 Obsidian 的第三方插件设置中允许第三方插件，重新启动应用后启用 remotely-save-next。
这是独立插件，不自动读取原插件配置或历史。第一步只检查加载、名称和设置页，不执行同步。
若使用自定义配置目录，应将命令中的 `.obsidian` 替换成实际目录名。

这里是安装本地构建，不必发布插件，也不必从社区插件商店下载。
同一 id 的社区版本会使用同一个目录；测试仓库不要再通过社区更新覆盖本地构建。
不要复制正式仓库的 data.json。它包含插件配置和认证信息。

## 3. 第一次测试配置

- 新配置默认选择 WebDAV。
- 设置服务器地址、账号、密码和专用远端目录，例如 `remotely-save-dev`。
- 自动同步、启动后同步、保存后同步先关闭，仅手动触发。
- 第一轮不启用内容加密；在独立的新测试目录验证加密，不直接切换已有远端数据的加密模式。
- 点击“测试连接”：该操作会创建、写入、读取和删除测试对象，并非只测登录。

准备 `hello.md`、中文与空格名称、较深目录，以及超过 10 MiB 的测试附件。
先上传，再修改、重命名、删除一个测试文件，检查本地与远端结果。
Nextcloud 超过 10 MiB 才进入分块分支；普通 WebDAV 使用整文件 PUT。

## 4. 查看错误与同步计划

展开插件设置的“高级设置”，再展开末尾“调试”，把控制台日志级别设为 debug。
Linux／Windows 按 Ctrl+Shift+I，macOS 按 Cmd+Option+I 打开开发者工具。
如果快捷键不可用，使用 Obsidian 的开发者工具菜单入口。

打开 Console，启用 Preserve log，手动同步一次，保存首次错误及完整堆栈。
上传错误中的 `WebDAV path metrics` 包含实际远端目标的长度统计；403 本身不证明文件名过长。
其中 encodedPathBytes 不包含 WebDAV 端点前缀，不等于完整请求 URI 长度。

Network 面板能看到的请求取决于传输方式：插件使用 Obsidian requestUrl 时，
请求不一定出现在渲染器 Network 中。此时结合 Console 和 WebDAV 服务器／代理访问日志定位。

也可在“调试”里导出最近一次同步计划，定位文件对应的决策及错误阶段。
日志、同步计划和请求详情可能包含路径或认证信息；分享前去除 Cookie、Authorization、
access_token、refresh_token 和不希望公开的文件名。不要发送整个 data.json。

## 5. 修改代码后的循环

一个终端持续构建：

```sh
cd /home/axulo/todo/remotely-save
npm run dev
```

每次保存代码，等待 webpack 构建完成。另一个终端复制产物：

```sh
cd /home/axulo/todo/remotely-save
sync_test_vault="/home/axulo/ObsidianSyncTest"
cp main.js manifest.json styles.css "$sync_test_vault/.obsidian/plugins/remotely-save-next/"
```

然后在 Obsidian 中禁用再启用插件。若仍使用旧代码，完整退出并重启 Obsidian。
构建监听只更新项目根目录的 main.js，不会自动复制到仓库，也不会自动重载插件。

本项目 webpack 配置显式启用了压缩；需要源码断点时可用临时调试命令：

```sh
npm run dev -- --no-optimization-minimize --devtool source-map
```

该命令生成 main.js.map。使用这一命令时，额外复制 source map：

```sh
cp main.js.map "$sync_test_vault/.obsidian/plugins/remotely-save-next/"
```

在开发者工具 Sources 中查找 src/fsWebdav.ts 的 writeFile、_init、_checkPartialSupport，
以及 src/settings.ts 的 display。源码映射可用时设置断点；Pause on exceptions 可帮助定位，
其中“捕获的异常”也可能包含 SDK 正常处理的探测失败，需要结合最终错误判断。
停止监听后，运行 npm run build 生成正式构建，再按三个文件的方式安装。

## 6. 单独运行某类回归

```sh
npm test
npm run test:webdav
node --test tests/webdav/path-diagnostics.test.cjs
node --test tests/webdav/nextcloud.test.cjs
node docs/diagnostics/webdav-audit.cjs
```

独立诊断使用边界模拟，正常 WebDAV 套件使用实际 SDK 和本地 HTTP 夹具；
二者通过均不能代替真实 Obsidian 与真实网盘验收。
记录 Obsidian 版本、系统、服务端类型与版本、是否加密、首次失败阶段及可重复步骤。

## 本轮命令核验

百度官方授权与目录检查的测试操作参见
[百度连接入口说明](../diagnostics/baidu-connection-entry.zh-cn.md)。
入口在选中百度后的折叠区域，可授权和读取目录，桌面端还可
[检查下载文件](../diagnostics/baidu-desktop-download.zh-cn.md)，并执行预览和手动同步。
完整回归的新 HTTPS 夹具需要可调用的系统 OpenSSL 和本机临时端口。
桌面上传模块的开发接口与专用测试目录验收见
[百度上传说明](../diagnostics/baidu-upload.zh-cn.md)。它尚未接入自动同步。
目录创建和单项删除的开发验收见
[百度目录与删除说明](../diagnostics/baidu-directory-delete.zh-cn.md)。仅使用专用测试目录。

2026-10-06 已实际启动源码映射监听构建，首轮成功生成 main.js 和 main.js.map，
保留 2 条既有 Dropbox 动态依赖警告；随后停止监听，正式 build 通过，保留 5 条既有警告。
代码变更后的持续重建、复制到外部测试仓库及 Obsidian 实际加载尚未验收。

百度桌面实验同步安装后的配置与验收见[专用说明](../diagnostics/baidu-desktop-sync.zh-cn.md)。

夸克直接扫码登录、同步目录和同名覆盖探测见
[夸克桌面实验同步](../diagnostics/quark-desktop-sync.zh-cn.md)。

## 7. 集中验证与安装包

主要开发完成后统一执行：

```sh
npm run test:baseline
npx tsc --noEmit --skipLibCheck
npm run package:plugin
```

最后一条重新正式构建，并将三个安装文件放到 `dist/remotely-save-next/`。
把这三个文件复制到测试仓库 `.obsidian/plugins/remotely-save-next/`，再重启插件。
正式 webpack 将动态依赖合并为一个 `main.js`，无需从旧构建中复制额外 JS 分块。
不要把仓库 `data.json`、真实账号配置或令牌复制到安装包或提交到 Git。

0.1.1 的精简页面和同步记录验收见 [分步测试清单](../ui/webdav-acceptance.zh-cn.md)。
