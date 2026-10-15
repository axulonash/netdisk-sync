# 百度目录创建和删除

本阶段完成目录创建、单项删除及桌面传输接入，复用登录会话并检查账号变化。
尚未接入同步引擎，也未在设置页增加修改远端内容的按钮。
验证使用本地协议及 HTTPS 夹具，没有访问真实百度账号。

## 接口与范围

连接实例提供两个开发接口：

```js
await connection.mkdir(remoteRoot, relativeKey);
await connection.remove(remoteRoot, relativeKey);
```

`remoteRoot` 必须是明确的远端目录，不能是账号根 `/`。
`relativeKey` 必须非空且相对该目录，不接受绝对路径、点路径、重复斜线、控制字符或孤立 Unicode 代理项。
可以使用目录键的单个结尾 `/`，请求时移除该斜线。不允许对作用域根本身执行创建或删除。
中文、表情、空格及百分号按原路径编码，不做改名或截断；服务端实际路径限制仍需验收。

## 目录创建

使用 `create`，指定 `isdir=1`、`size=0`、`rtype=0`，不覆盖同名文件或自动改名。
只有精确路径、目录类型、零大小和合法文件 ID 的响应才算成功。
同名路径冲突直接报错，不能仅凭“已存在”就假定它是目录。
当前不主动递归创建父目录，也不对既有目录执行覆盖；测试父目录需提前准备。

## 删除确认

使用 `filemanager` 的 `opera=delete`，指定 `async=0` 和单项 `filelist`。
只有总错误码为零、单项返回路径精确一致、单项错误码为零且没有异步受理标记，才返回成功。

HTTP 202、非零异步模式、任务编号、缺失或不匹配的目标项、单项错误都不能算作删除完成。
当前不轮询异步任务，不把仅受理的任务当成功；出现异步响应时需后续人工核对状态。
若服务端已删除但连接丢失，返回固定错误并标记 `outcomeUnknown`，不会重复发送删除请求。
本模块尚不修改同步历史；接入同步引擎后必须沿用“操作成功才更新历史”的边界。

目录删除可能包含其子项。开发验收只删除本次新建的空目录，不能用含真实笔记的目录测试。
所有失败只展示固定错误码、操作类型和数值状态，不附带凭据 URL 或服务端原始描述。

## 专用测试目录验收

先按[本地部署指南](../how_to_debug/local-development.zh-cn.md)构建并安装。
在桌面设置页完成[百度授权和只读检查](baidu-connection-entry.zh-cn.md)，确认应用专用测试目录可读。
打开过设置页后，连接实例才会初始化。将下例根目录替换为已准备的专用测试目录。

在开发者工具 Console 中创建一个唯一的新目录：

```js
const nativeConnection = app.plugins.plugins["remotely-save"].baiduConnection;
const remoteTestRoot = "/apps/你的应用目录/专用测试目录";
const newTestDirectory = `mkdir-check-${Date.now()}`;
const newRemoteDirectory = await nativeConnection.mkdir(remoteTestRoot, `${newTestDirectory}/`);
console.info({ fsId: newRemoteDirectory.fsId, remotePath: newRemoteDirectory.remotePath });
```

在百度网盘或重新扫描结果中确认它是新建的空目录，再单独执行删除：

```js
await nativeConnection.remove(remoteTestRoot, `${newTestDirectory}/`);
console.info("同步删除已确认");
```

若错误包含 `outcomeUnknown: true`，先重新核对远端状态，不要直接重发删除或创建。
不要打印整个插件配置。真实账号权限、目录冲突、异步响应和删除范围均需实际验收。

## 本地验证

```sh
npx mocha --import=tsx tests/native/baiduManagement.test.ts
npx mocha --import=tsx tests/native/baiduDesktopTransport.test.ts
npm run test:baseline
npm run build
```

HTTPS 夹具需要系统 OpenSSL 和本机临时端口。除目录及删除协议外，仍覆盖此前上传、下载和 WebDAV 回归。
夹具模拟服务端完成删除后丢失响应，并确认只发送一次请求。

本轮验证结果（2026-10-06）：常规测试 286 项、WebDAV 回归 96 项全部通过；
`npx tsc --noEmit --skipLibCheck` 通过，生产构建通过并保留 5 条既有警告。
这些结果来自本地协议夹具，真实百度账号尚未验收。

请求结构参考[OpenList 的百度文件操作实现](https://raw.githubusercontent.com/OpenListTeam/OpenList/main/drivers/baidu_netdisk/util.go)。
本轮尝试核对[百度文件管理文档](https://pan.baidu.com/union/doc/mksg0s9l4)和
[创建文档](https://pan.baidu.com/union/doc/rksg0sa17)，未能取得正文；参考实现不是平台兼容性保证。
不依赖 OpenList、网关或中转服务。

后续进度见[百度文件系统适配层](baidu-filesystem-adapter.zh-cn.md)。
