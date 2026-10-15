# 百度直连第一批：授权协议基础（2026-10-06）

## 实现

新增 `src/native/baiduAuth.ts`，完成：

- 构建百度官方 authorize 地址，携带应用 ID、redirect_uri、basic/netdisk scope 和 state。
- 校验回调地址、state、重复参数和授权拒绝，仅返回唯一有效授权码。
- 构建授权码交换、refresh token 请求，使用用户自身的应用凭据，不调用中转服务。
- 校验令牌完整性和整数有效期，计算 expiresAt；处理 refresh token 轮转。
- 如果响应显式提供 scope 而不包含 netdisk，则拒绝将该响应当作网盘授权。
- 错误保留白名单内的平台码或 HTTP 状态；平台描述、未知错误字符串和底层传输异常
  不进入返回消息，避免其中回显授权码、secret 或 token。模块不输出日志。

授权请求和令牌协议依据：[百度 OAuth 接入指南](https://openauth.baidu.com/doc/doc.html)。
网盘 scope 参考 [百度开发者中心网盘接入说明](https://developer.baidu.com/question/detail.html?id=177)。
前者是账号 OAuth 文档，不能证明用户的应用已获得网盘权限；后者较早，实际权限仍需后台验收。

## 明确的集成边界

这是独立协议模块，尚未接入 Obsidian requestUrl、设置页、URI handler、配置持久化或 FakeFs。
传输通过 BaiduTokenTransport 注入；当前按 POST 表单构建，公开账号文档展示 GET 示例，
真实百度服务器对本请求的支持尚未验证。测试不替代 HTTP 实测，未宣称用户已经能登录或同步。

模块接收调用方提供的 state；长度校验不代表随机性。集成时必须使用密码学随机 state，
保存待授权会话、设置有效期，并在成功或拒绝后一次性消费会话，防止重复回调。
测试中的 obsidian:// 回调仅是校验夹具，并未证明百度后台接受该协议作为授权回调。
实际回调需按应用后台许可配置；oob 授权地址可构建，但它走手动取码，不走 URL 回调解析。

模块返回令牌，不直接保存；集成层应在完整验证后更新设置并处理刷新并发。
如果平台响应省略 scope，当前保留该未知状态，后续通过网盘账号／读取接口确认权限。
没有自动重试，没有隐式失效旧令牌，也未内置发布者或其他项目的 secret。

## 测试与结果

新增 `tests/native/baiduAuth.test.ts` 共 28 项：
首批 22 项修复前全部失败，修复后通过；追加 6 项边界测试时 3 项预期失败，补齐实现后全部通过。
覆盖授权参数、回调目标、state 和重复 code、POST 表单编码、刷新轮转、缺失轮转字段、
错误与异常响应、显式网盘权限、HTTP 状态、oob 及凭据回显保护。

这些测试使用注入的传输响应，运行实际协议代码；未连接真实百度账号。
完整结果：Mocha 116 项通过（新增 28 项），WebDAV 96 项通过，主构建通过，
保留 5 条既有 Dropbox 动态依赖及体积警告；git diff --check 通过；静态复核无具体问题。
日志 `/tmp/remotely-save-baidu-auth-*.log`。

## 夸克新增核实

[参考会话驱动](https://raw.githubusercontent.com/OpenListTeam/OpenList/main/drivers/quark_uc/util.go)
使用 Cookie 与 Referer 发出请求，并更新服务端返回的会话 Cookie；列表逐页获取，上传涉及
预上传、分块签名、对象存储提交和最终完成步骤。它是开源实现证据，并非官方稳定接口承诺。
后续实现应处理会话续期，不把 Cookie 原样转发到返回的对象存储地址，并验证最后一页和最终提交。
不安装或调用 OpenList 服务，本项目仍按插件直连实施。

## 下一批

确定用户已有应用及登录入口偏好后，接入百度登录会话管理和只读网盘接口；
夸克按可用开发者授权或用户自身会话实现独立认证。用户尚未回答的登录偏好不视为默认许可。

后续目录读取与扫描见 [百度只读目录记录](baidu-read-foundation.zh-cn.md)。
