# 阿里云盘桌面同步（0.1.20）

无需申请 AppID、AppSecret，也不依赖中转服务。在电脑端 Obsidian 设置中选择顶部“阿里云盘”。

1. 点击“扫码登录”，用阿里云盘 App 扫描并在手机上确认。插件每秒检查一次，成功后自动保存并关闭二维码窗口，无需点击确认按钮。
2. 填写专用网盘文件夹，例如 `/remotely-save-next/测试笔记`，点击“准备同步文件夹”。不存在的目录会自动创建。绿点表示实际完成首次上传、同名覆盖、下载内容校验和测试文件清理。
3. 点击“立即同步”。先用一个有内容的文本文件测试上传，再修改内容测试覆盖；切换到“同步记录”查看时间、统计和展开后的文件目录。

手机端暂不支持阿里云盘同步，会显示到电脑操作的提示。当前仅支持桌面手动同步及预览，单文件上限 64 MiB，支持明文和 OpenSSL；未加密空文件暂不支持。

## 凭证与文件保护

二维码在插件本地生成，不发送给第三方图片服务。账号凭证只发给阿里云盘账户接口，预签名文件上传、下载不携带账号令牌。凭证刷新时保存更新后的令牌；切换账号、服务或目录会停止旧任务。

测试文件名为 `rs-overwrite-check-` 加 32 个随机字符及 `.bin`。成功时清理本次测试文件到网盘回收站；失败结果未确认时保留现场，不按文件名批量删除旧文件。这类专用测试文件不会进入笔记库，确认不再需要后可在网盘中手动删除。此名称模式为插件保留名，请勿用作普通笔记文件名。

使用的是网页端直接接口，尚未完成真实账号验收，不能视为官方开放平台应用。实现参考了 [OpenList 的阿里云盘原生驱动](https://github.com/OpenListTeam/OpenList/tree/main/drivers/aliyundrive)中的设备签名和上传流程；扫码协议参考[原生适配器实现](https://github.com/OzoO0/cloud-auto-save-x)。未复制或使用第三方中转服务。

## 更新安装

用安装包中的 `main.js`、`manifest.json`、`styles.css` 替换 `.obsidian/plugins/remotely-save-next/` 对应文件，保留已有 `data.json`。完全退出并重新打开 Obsidian，确认插件版本为 `0.1.20`。

如失败，请提供错误码、失败阶段和是否有测试残留；不要提供令牌、Cookie、私钥或完整配置。

## 本地验证结果

`npm run test:baseline`：512 项 Mocha 测试、96 项 WebDAV 测试通过。`npx tsc --noEmit --skipLibCheck` 与 `npm run package:plugin` 成功，构建有 5 条既有警告。安装 ZIP 内三个文件与构建目录逐字节核对通过。以上不替代真实账号扫码和 Obsidian 界面验收。

## 0.1.21 修复

兼容阿里云盘创建目录、文件上传任务返回 HTTP 201（Created）。此前 JSON 处理只接受 200，会在创建目录后提前报错，尚未上传测试文件。修复保留响应结构、文件列表、下载内容及清理校验，不会只凭 HTTP 状态通过准备。

## 0.1.22 下载端点兼容

补充 `aliyundrive.net` 与 `alicloudccp.com` 下载域名兼容；这两类域名只允许 GET，上传仍只允许 OSS，账号头只允许发往 API 地址。下载域名参考[下载助手作者的说明](https://www.youxiaohou.com/zh-cn/idm.html)。

上传、下载及跳转拒绝时显示固定阶段和纯域名，不显示路径、签名参数或完整链接。真实账号此次被拒绝的具体域名尚未取得，需更新后复测，不宣称已完成真实账号问题验收。

## 0.1.23 原生数据端点上传

支持 `cn-beijing-data.aliyundrive.net` 的预签名 PUT 上传，同时保留 OSS 上传支持。此前客户端只允许 OSS 上传、传输层又把全部 aliyundrive.net 主机限制为 GET，两层都会阻止此原生端点上传。两层规则均已修复；其他下载域名不因此取得上传能力。

上传不携带 Authorization、Cookie、设备签名或设备 ID。端点仍须 HTTPS、无 URL 用户密码、无非标准端口。新增完整探测及传输层测试，并拒绝相似域名、域名后缀伪装和额外子域。`cn-beijing-data-aliyundrive.net` 是另一个注册域名，未自动加入。

## 0.1.24 上传签名兼容与 403 诊断

预签名上传不再固定添加 `Content-Type: application/octet-stream`；仅在网盘的分片响应明确提供 `content_type` 时发送对应值。阿里云[预签名上传说明](https://help.aliyun.com/zh/oss/user-guide/upload-files-using-presigned-urls)指出，额外或不一致的 Content-Type 会造成 403 SignatureDoesNotMatch。此修复针对已验证的请求头缺陷，尚不能仅凭 HTTP 403 确认用户这次就是签名不一致。

传输失败同时保留上传、下载或跳转阶段和纯域名；PUT 与 GET 都识别固定白名单 XML 错误码，不输出原始响应正文、签名 URL 或令牌。页面支持显示原生 aliyundrive.net 地址的安全响应信息。

## 0.1.25 cloud 下载域名兼容

用户已进入下载校验，接口返回 `dl1.aliyundrive.cloud`。新增该主机及同服务的 `dl1-v6.aliyundrive.cloud` 下载支持（[上游真实接口反馈](https://github.com/OpenListTeam/OpenList/issues/565)、[IPv6 端点反馈](https://github.com/OpenListTeam/OpenList/issues/654)）。仅允许这两个确切主机的 HTTPS GET，不允许上传、POST 或账号凭证；其他 cloud 主机、额外子域和相似域名不自动放行。下载重定向继续逐跳校验，未关闭 TLS 验证，也未改写服务器返回的签名链接。

新增两种主机的完整覆盖探测、清理、传输层 GET 放行和凭证/上传拒绝回归。真实账号须更新后重新准备目录验收。

## 0.1.26 清理返回 204 兼容

阿里云盘将测试文件移入回收站时返回 HTTP 204、空正文，之前被统一 JSON 状态检查误判失败。只为 `/v2/recyclebin/trash` 接受空 204，随后仍列出文件夹并确认原 FID 已消失；若文件仍存在，保持红点，不保存覆盖验证标记。其他需要 JSON 的接口不放宽为接受 204。
