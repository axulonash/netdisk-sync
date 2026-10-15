# 0.1.35 百度扫码网盘会话修复

用户确认：扫码并在手机确认后，登录弹窗报 api_errno_-6，尚未进入读写测试。这对应 gettemplatevariable 网盘会话检查失败，不能当作文件权限问题处理。

检查发现：0.1.34 仅接受父域 .baidu.com Cookie，丢弃 pan 自身作用域 Cookie，也未在网盘检查失败后完成官方页面落地初始化；此外，有 BDUSS 时跳过扫码交换响应错误检查。模拟回归复现三个缺口后修复。

首次只读 gettemplatevariable 返回 -6 时，GET 官方 /disk/main，限制跳转在 HTTPS pan/passport 内，正确保留并隔离 Cookie，然后只读重查一次。仍失败报告 drive_session_api_errno_-6。不自动重放写入，不把 pan-only Cookie 发给 PCS 或 CDN。恢复保存的会话仍保留 Cookie 作用域。扫码交换返回失败时，即使有 BDUSS 也不认定登录成功。

验证：Mocha 615 项 + WebDAV 118 项，共 733 项通过；TypeScript（skipLibCheck）和生产构建通过（既有 5 项 webpack 警告）。独立只读复核未发现剩余阻断问题。ZIP 内容和 CRC 已验证。

真实账号仍需更新、完全重启后重新扫码验证，不能据模拟测试宣称实际 -6 已彻底解决。本版本继续为扫码及独立读写测试版，全量百度同步尚未开放。
