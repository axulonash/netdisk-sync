# WebDAV PUT 响应等待调整（0.1.33）

## 用户案例

1088 项任务包含 1078 次上传、10 次删除，完成 1087 项。唯一失败文件为 `01-Projects/维修学习/W220资料/Sony_DSC-W220_Level2_中文对照版.pdf`，25,759,370 字节（约 24.57 MiB），两个本地副本 SHA-256 一致。失败阶段为 awaiting_response，bodyFlushed=true，约 34.5 秒后触发 idle 超时。bodyFlushed 仅表示本地请求正文已交给传输层，不能证明群晖已收到或保存文件。stat 404 是后续检查结果，不能据此认定 PDF 或路径有问题。

## 调整

桌面原生 WebDAV PUT 在正文 finish 后、收到响应头前，单独使用 120 秒 socket 空闲限制（并非固定响应头截止时间；零碎响应数据可延长等待，但仍受总期限约束）；连接、发送正文、接收响应正文仍为 30 秒空闲限制，总期限仍为 10 分钟。诊断新增 timeout=response，与 idle、total 区分。取消操作仍立即销毁真实请求。没有新增自动重放 PUT，也没有放宽文件完整性校验。

## 验证与限制

本地 HTTP 回归先复现旧规则提前超时，再验证新规则允许超过传输空闲限制的延迟响应，且只发送一次 PUT；响应头后正文卡顿仍受原空闲限制约束。

通过现有隧道上传唯一临时 PDF 的实网探测在 connecting 阶段发生 ECONNRESET，bodyFlushed=false，约 3.7 秒。清理请求也发生 ECONNRESET，故不能声称该探测已完成上传或确认远端不存在残留。此次探测不能验证服务端响应等待场景；仍需用户更新后重试失败文件。没有证据确认 cloudflared 已改为 HTTP/2，也不能宣称隧道的所有网络问题已经解决。

完整验证：Mocha 584 项、WebDAV 118 项通过，共 702 项；TypeScript（skipLibCheck）通过，生产构建成功（保留既有 5 项 webpack 警告）。安装包仅包含 main.js、manifest.json、styles.css，版本和 ZIP CRC 已验证。独立只读复核未发现阻塞问题。
