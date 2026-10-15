# 百度桌面端下载传输与检查

本阶段将真实 HTTPS 二进制传输接入百度连接入口，仍未接入同步引擎。
下载检查只将文件读入内存，不写入 Obsidian 仓库，也不上传或删除远端内容。

## 操作

按 [本地开发环境说明](../how_to_debug/local-development.zh-cn.md) 重新构建和安装插件，
在桌面端打开“百度网盘 · 授权与只读检查（实验）”：

1. 按 [百度连接入口说明](baidu-connection-entry.zh-cn.md) 完成官方授权。
2. 填入已存在的远端测试目录，点击“只读检查”。
3. 在“检查下载文件”填入该目录下一个文件的相对路径，如 `test.md` 或 `子目录/笔记.md`。
4. 点击“下载检查”，结果显示下载字节数，并与扫描记录的大小核对。

文件必须出现在刚扫描成功的结果中。更换目录、授权、退出或替换账号后需重新检查目录。
首次验收请使用一个内容已知的小文件；当前只核对长度，未核对远端内容哈希。
单文件上限为 64 MiB，超限在获取下载元数据前报错。
移动端继续提供授权和目录检查，暂不显示下载检查。

## 传输边界

- 桌面端延迟加载 Node `node:https`，插件在移动端加载和渲染时不加载该模块。
  webpack 仅将 `node:https` 标记为外部模块，保留原有 `https` 浏览器配置。
- 每次 HTTPS 请求只返回一个响应，不自动跟随重定向。
  下载模块检查每一跳地址，只接受既定百度下载域的 HTTPS 链接，最多五次重定向；
  第一跳添加 OAuth 令牌，后续跳转移除 `access_token`。
- 固定 `User-Agent: pan.baidu.com` 和 `Accept-Encoding: identity`，不发送 Cookie 或 Authorization。
  不接受关闭 TLS 证书校验的设置；Node 连接不自动继承 Obsidian 的代理或证书例外配置。
- 每跳请求包含 DNS、TLS、响应和读取阶段的总超时，默认 60 秒。
  非 200 响应返回状态与头部后关闭连接；短读、连接中断、压缩响应和超限响应报固定错误码。
- 同时以单文件上限和扫描到的预期大小限制读取。即便没有 Content-Length，
  也按收到的字节数限制缓冲。文件最终仍全量驻留内存，合并缓冲会增加瞬时内存占用。
- 元数据请求仍使用 Obsidian `requestUrl`；二进制下载不使用其自动重定向行为。
  下载期间账号变化时不返回旧账号的成功结果。

真实百度账号、下载 CDN 与桌面 Obsidian 运行时仍待验收。
未知 CDN 会明确失败，后续需核实合法地址再扩展；不能静默接受任意跳转地址。
该阶段不包含移动端下载、写入适配器、上传和删除。

## 本地测试

完整回归包含本地 HTTPS 服务，需要系统可调用 `openssl` 来生成临时测试证书，
并允许监听本机临时端口。测试将证书加入单个夹具请求的信任配置，不关闭证书校验，
不访问真实百度服务；临时证书和私钥会在测试结束后清理。插件运行不需要 OpenSSL 命令。

```sh
npx mocha --import=tsx tests/native/baiduDesktopTransport.test.ts
npm run test:baseline
npm run build
```

夹具验证真实 TLS 请求、逐跳重定向、下一跳令牌移除、外域拒绝、精确字节、
短读、超时、体积预算、压缩拒绝、TLS 主机名校验和空文件。
页面夹具覆盖文件选择、目录变更失效与移动端渲染；真实账号验收不能由这些测试替代。

2026-10-06 验证结果：Mocha 204 项、WebDAV 96 项全部通过；类型检查通过，
主构建通过并保留 5 条既有警告。静态复核无阻塞问题。
日志位于 `/tmp/remotely-save-baidu-desktop-baseline.log` 和
`/tmp/remotely-save-baidu-desktop-build.log`。

依据：[Node HTTPS 文档](https://nodejs.org/api/https.html)、
[Obsidian 移动端开发说明](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)。
