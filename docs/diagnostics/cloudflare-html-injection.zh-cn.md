# HTML 下载大小差异：Cloudflare 统计脚本注入

2026-10-12 使用现有配置对一份失败的 Ghostty HTML 进行只读 GET，与本地原文比对。未修改远端或本地文件。

- 本地：2,097,152 字节。
- 远端 GET：HTTP 200，Content-Type text/html，Server cloudflare，含 CF-Ray。
- 下载：2,097,519 字节。
- 前 2,097,152 字节与本地逐字节一致，末尾额外 367 字节。
- 额外内容为引用 `https://static.cloudflareinsights.com/beacon.min.js/…` 的脚本；原文件无该引用。

已确认此项 size_mismatch 是 Cloudflare Web Analytics 脚本注入导致。其他三项同类 HTML 大小差异符合此线索，但未逐个下载比对。独立的上传 network_error 仍未确认根因。

解决：在 Cloudflare Web Analytics 中关闭 WebDAV 主机的自动脚本注入，或设置排除规则；保留 Tunnel。源站文件响应也可设置 Cache-Control: no-transform（不要为含私密笔记的响应添加 public）。设置完成后重新比较下载字节数。插件继续保留大小与版本校验，不删除下载正文中的脚本来猜测恢复原文件。

官方说明：https://developers.cloudflare.com/web-analytics/get-started/

## 禁用 RUM 后复测

用户禁用 RUM 后，最初提供的摘要仍保留原差值；随后实时只读 GET 得到不同结果：

| 文件 | 本地字节 | GET 字节 | 逐字节比较 |
| --- | ---: | ---: | --- |
| Ghostty | 2097152 | 2097152 | 一致 |
| Gemma 4 | 4152928 | 4153159 | 多 231 字节 |
| NVMe 教程 | 6216804 | 6216804 | 一致 |
| ComfyUI API | 3127407 | 3127645 | 多 238 字节 |

四份 GET 均 HTTP 200，CF-Cache-Status DYNAMIC，均不再有 Cloudflare Analytics beacon。剩余两份下载含 `/cdn-cgi/l/email-protection` 或 `__cf_email__`，以及 `email-decode`；对应本地原文均无这些标记。证明另一项 Email Address Obfuscation 仍修改 HTML。需要仅对 WebDAV 主机关闭该功能后重新验证。没有关闭其他安全防护。

官方说明：https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/
