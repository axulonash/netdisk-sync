# 0.1.32：上传超时诊断

本轮新增诊断，不更改超时策略、不自动重传 PUT、不宣称修复外部链路。

诊断失败项增加 networkCode 白名单及 transfer：phase（connecting/sending_body/awaiting_response/receiving_response）、bodyBytes、bodyFlushed、elapsedMs、timeout（idle/total）。不记录 URL、密码、请求头或原始错误正文。bodyFlushed 只表示请求已交给本机底层传输，不代表群晖已接收或保存文件。

使用本地现有配置，通过用户同一 Cloudflare 域名操作唯一随机命名的 `.bin` 临时文件，不覆盖真实文件。成功测试读回校验后删除；失败测试也发出删除请求，404 表示清理查询当时不存在该目标，不能证明原请求永远不会延迟落盘。

实测：
- 4 B 单独上传 HTTP 201、读回正确、DELETE 204。
- 2 MiB 单独上传约 26 秒 HTTP 201、读回正确、DELETE 204。
- 8 MiB 默认空闲超时约 32 秒 ETIMEDOUT、DELETE 404；将空闲等待改为120秒，约122秒仍 ETIMEDOUT、DELETE 404。
- 4 MiB 原生上传约33秒 ETIMEDOUT，phase=awaiting_response、bodyFlushed=true；设置浏览器 User-Agent 后仍约35秒超时。
- Python 独立客户端同大小4 MiB测试也超时（约48秒），随后 DELETE 404；不是插件特有的失败现象。
- 同时上传两份2 MiB，均约31秒 ETIMEDOUT，phase=awaiting_response、bodyFlushed=true、DELETE 404。与此前单份成功对比，存在并发/链路负载影响，但尚不能断定唯一根因。

下一实验：检查 Cloudflare Tunnel 对该主机路由的 Disable Chunked Encoding。若关闭则开启并保存，只变更一项后复测。这是兼容性假设，不是已确认根因。官方文档说明关闭 disableChunkedEncoding 时，cloudflared 会对 HTTP/1.1 使用 chunked 传输编码。客户端固定 Content-Length 不能单凭代码证明隧道到源站一定保持同样的请求分帧。

官方设置：https://developers.cloudflare.com/tunnel/reference/origin-parameters/#disablechunkedencoding

用户当前无法直连 NAS，不要求局域网对照，不改群晖内部配置、不放宽 TLS 校验。

## 用户开启 Disable Chunked Encoding 后对照

通过相同域名、相同上传实现复测，未改客户端超时：

- 单份4 MiB：32,733 ms，ETIMEDOUT，awaiting_response，bodyFlushed=true；DELETE 404。
- 两份2 MiB并发：一份30,402 ms同阶段超时，DELETE 404；另一份32,762 ms HTTP 201，读回HTTP 200，2,097,152字节逐字节与测试正文一致，DELETE 204。

设置变更后仍可复现故障，不能把分块编码认定为已确认或已解决的根因。用户确认已保存设置，但本机不能独立读取cloudflared运行配置以确认connector已应用。下一步需要查看cloudflared连接器的配置更新日志及失败请求附近日志，区分隧道到群晖的连接、转发中断与客户端到边缘的问题。日志中的token/认证信息应打码。

## cloudflared.html 日志检查

读取用户提供HTML并在内存解析文本，输出前遮蔽token等敏感字段。日志按时间倒序，范围覆盖2026-03-31至2026-10-12，历史错误不能直接当作今天的根因。

- 2026-10-12T08:15:53Z Updated to new configuration，version=23；webdav.axulo.us.kg 路由包含 originRequest.disableChunkedEncoding=true，service=http://localhost:5005。配置已经应用，不需要再次怀疑用户未保存。
- 此后08:20–08:22 UTC多份同步文件请求报告 Incoming request ended abruptly: context canceled。此前随机测试文件也出现同类日志。该消息只说明入站请求被取消，可能是客户端超时关闭导致；日志未包含HTTP方法，不能仅凭dest把每条都断言为PUT。
- 最近注册连接为2026-10-11T21:38:27Z，protocol=quic，Cloudflare边缘地址为IPv6；启动设置edge-ip-version:6。
- 10月11日有QUIC no recent network activity与重连；10月12日这份导出中的上传时段没有对应QUIC超时。历史不稳定支持把传输协议作为下一个对照变量，但不足以证明今天上传超时由QUIC引起。
- 旧日志中localhost:5006证书不匹配是3月的配置，当前源站HTTP5005，不能用于解释今天的问题。ICMP权限提示也不是WebDAV上传故障证据。

下一项单变量实验：仅把连接器的传输协议切换为http2（环境变量TUNNEL_TRANSPORT_PROTOCOL=http2），保留edge-ip-version=6和其他配置。重启后需在新日志确认protocol=http2，再复测同样4MiB单文件与2MiB并发。此设置控制cloudflared到Cloudflare边缘，不是面板中的http2Origin。不可因单位电脑仅IPv4就把NAS的edge-ip-version改4。
