# 百度桌面上传模块

本阶段实现预创建、分片上传、提交和桌面 HTTPS POST 传输，并接入百度连接会话。
尚未接入同步引擎，设置页仍只提供授权、目录检查和下载检查；没有新增自动上传按钮。
没有使用真实百度账号验证。后续已实现[目录创建和删除](baidu-directory-delete.zh-cn.md)，
完整同步适配仍待实施。

## 已实现的行为

- 在任何请求前验证绝对路径、内容、时间和显式覆盖标记，拒绝重复斜线、点路径、控制字符及孤立 Unicode 代理项。
  不截断、改名或填充文件内容。合法路径通过表单和查询参数编码。
- 将输入内容复制为本次上传快照，按 4 MiB 分片计算 MD5；预创建和提交使用同一组完整分片哈希。
  只上传服务端请求的分片序号，逐片核对返回的 MD5，全部成功后才提交。
- 覆盖标记必须显式提供：`overwrite: true` 使用 `rtype=3`，`false` 使用 `rtype=0`；
  预创建、分片及提交使用同一路径。不采用自动重命名策略。
- 预创建的快速上传响应也必须提供合法的文件 ID、原路径、大小和文件类型。
  提交返回改名、错误大小、目录或丢失精度的文件 ID 时不会报告成功。
- 提交只执行一次。丢失提交响应、响应格式异常、预创建结果异常时，标记 `outcomeUnknown`，
  不能推断文件未写入，也不自动重试覆盖或删除远端文件。明确的分片失败不会继续提交。
- 每次请求前后核对账号配置；中途导入另一账号会停止后续请求。
  已经发出的写入不能撤回，因而提交期间账号改变也会标记结果不明确。

## 当前限制

单文件最多 64 MiB，内容全量驻留内存；尚未提供流式、并行、断点续传或自动重试。
零字节文件明确返回 `empty_file_unsupported`，不伪造内容，也不会把跳过上传当成功。
参考实现明确拒绝空文件；真实账号能力仍需验证。完整同步前必须处理这一限制。

桌面传输延迟加载 `node:https`，保留证书和主机名校验，不发送 Cookie 或 Authorization。
仅接受固定的百度文件 API 和分片上传端点，不跟随 POST 重定向。
每请求默认总超时 60 秒，表单最多 64 KiB，分片请求最多 4 MiB 加 4 KiB 封装，JSON 响应最多 1 MiB。
Node 连接不自动继承 Obsidian 的代理或证书例外配置。
移动端目前没有上传传输；未知上传域、会员大分片及动态服务器选择尚未开放。

应用权限及应用目录范围由百度控制，写入前需确保测试目录已存在。
本阶段传递本地时间，尚未对真实平台返回的时间行为或整文件哈希作兼容性保证。

## 专用测试目录验收

按 [部署调试指南](../how_to_debug/local-development.zh-cn.md) 重新构建和安装。
桌面端先在设置页完成[百度授权](baidu-connection-entry.zh-cn.md)，并检查自己的应用专用测试目录。
上传目前是开发接口，需在 Obsidian 开发者工具 Console 中调用；替换下例路径为你已验证可读写的测试目录。

```js
const syncPlugin = app.plugins.plugins["remotely-save"];
const uploadBytes = new TextEncoder().encode("百度上传测试\n");
const uploadTime = Date.now();
const uploaded = await syncPlugin.baiduConnection.writeFile({
  path: `/apps/你的应用目录/专用测试目录/upload-check-${uploadTime}.md`,
  data: uploadBytes.buffer,
  overwrite: false,
  mtimeMs: uploadTime,
  ctimeMs: uploadTime,
});
console.info({ fsId: uploaded.fsId, size: uploaded.size });
```

设置页需已打开过，才能初始化连接实例。验收后重新执行目录检查，并通过下载检查核对大小；
本模块也提供 `readFile({fsId, size})` 开发接口，可将小测试文件的返回字节与已知内容逐字节比较。
不要打印整个插件配置或凭据请求。使用唯一文件名，先验证创建再验证覆盖。

若捕获错误，记录固定 `code`、`stage`、数值 `status` / `errno` 和 `outcomeUnknown`。
结果不明确时先在网盘或重新扫描的目录中核对目标文件，不能直接重复覆盖。
中途失败的临时分片可能留在服务端，尚无会话取消/清理接口；不会用删除目标文件来清理分片。

## 本地验证与依据

协议夹具验证二进制与中文路径、按需分片、快速上传、无覆盖策略、输入快照、非法路径、
空文件、大小限制、分片失败、提交歧义、元数据校验、错误脱敏和账号变化。
HTTPS 夹具实际传输 multipart，模拟服务端已提交后连接中断，并验证没有重复提交。
还覆盖 POST 重定向拒绝、超时、响应限额、坏 JSON 和 TLS 主机名拒绝。

```sh
npx mocha --import=tsx tests/native/baiduUpload.test.ts
npx mocha --import=tsx tests/native/baiduDesktopTransport.test.ts
npm run test:baseline
npm run build
```

本地 HTTPS 夹具需要 OpenSSL 和本机临时端口。测试不访问真实百度账号。
2026-10-06 最终验证：238 项常规测试、96 项 WebDAV 测试通过；类型检查通过，
主构建通过，保留 5 条既有警告。静态复核无剩余阻塞问题。
日志：`/tmp/remotely-save-baidu-upload-baseline.log`、`/tmp/remotely-save-baidu-upload-build.log`。

上传参数参考 [OpenList 的百度驱动实现](https://raw.githubusercontent.com/OpenListTeam/OpenList/main/drivers/baidu_netdisk/driver.go)。
这里只阅读其接口行为，不依赖 OpenList 服务；参考代码不是百度的稳定接口承诺。
已尝试核对百度[预上传文档](https://pan.baidu.com/union/doc/3ksg0s9r7)和
[创建文件文档](https://pan.baidu.com/union/doc/rksg0sa17)，本轮未能成功获取正文，实际账号验收仍不可省略。
