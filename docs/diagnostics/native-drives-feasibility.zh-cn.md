# 百度／夸克原生接入实施细则（2026-10-06）

此文记录最初研究与实施顺序。2026-10-07 的实现、验证和未完成项见
[当前交付状态](current-status.zh-cn.md)；夸克现采用官网扫码流程，不依赖此文讨论的外部刷新服务。

## 已确认范围

插件直接访问网盘，不依赖 AList／OpenList 网关或第三方令牌中转服务。
使用浏览器完成平台登录／授权后返回插件，与“直连”要求相容；不要求在插件中输入平台密码。
现有 FakeFs 接口为落点：walk、walkPartial、stat、mkdir、writeFile、readFile、rename、rm、checkConnect。

## 本轮证据

百度公开提供开放平台，官方开发者中心说明需要申请接入并创建应用，然后进行用户授权。
[百度官方接入说明](https://developer.baidu.com/question/detail.html?id=177)。
其原始网盘文档页面本次抓取失败，因此当前 OAuth 参数、权限及平台资格仍需在开发者后台核验。
该来源较早，不能作为全部现行规则的证明。

作为实现层参考，OpenList 的百度驱动支持使用自己的 ClientID／ClientSecret 在本地刷新令牌；
列表分页、下载链接与文件操作具有实际代码路径。
[百度驱动请求及刷新实现](https://raw.githubusercontent.com/OpenListTeam/OpenList/main/drivers/baidu_netdisk/util.go)，
[百度驱动文件操作](https://raw.githubusercontent.com/OpenListTeam/OpenList/main/drivers/baidu_netdisk/driver.go)。
这是开源实现证据，不是百度对本插件账号权限的保证。无需安装 OpenList，仅阅读源码理解接口。

夸克参考实现至少存在两个路径：Cookie 会话驱动，以及开放接口驱动。
[Cookie 驱动配置](https://raw.githubusercontent.com/OpenListTeam/OpenList/main/drivers/quark_uc/meta.go)。
开放接口实现使用应用 ID、签名参数和 access token，包含列表游标、分片上传及提交；
该参考版本的本地 refresh token 流程未实现，令牌刷新依赖外部 API。
[夸克开放接口请求及刷新实现](https://raw.githubusercontent.com/OpenListTeam/OpenList/main/drivers/quark_open/util.go)，
[上传及文件操作](https://raw.githubusercontent.com/OpenListTeam/OpenList/main/drivers/quark_open/driver.go)。
因此不能直接照搬该授权刷新流程来满足本项目的“无额外服务”要求。
本次未找到并核实足够完整的夸克官方第三方接入文档，不能推断不存在官方接口。

## 实施顺序与验收门槛

1. 确认用户已有的开发者应用，以及是否接受本人 Cookie／令牌导入作为首版登录方式。
   只询问是否具备，不在聊天中收取密钥。百度优先自己的应用官方授权；夸克依据可用授权确定路线。
2. 先实现各自认证模块：登录结果验证、凭据本地保存、失效提示、注销、刷新；
   刷新最多执行有界次数，不能无限递归，也不使用他人的应用身份或默认中转服务。
   若平台只提供保密客户端 secret，个人配置与公开分发须分别设计，不能把发布者 secret 写死进插件。
3. 首先落地只读适配器：验证账号、选择测试根目录、完整分页扫描和下载。
   任何分页失败都使本次扫描失败，不能把部分列表当完整列表交给同步删除逻辑。
4. 写入闭环：建目录、小文件、大文件分片、完成提交、覆盖、改名／移动、删除；
   确认提交成功再更新历史。不得为替换上传先删除原文件。
   对按文件 ID 操作的平台，建立会话内路径到 ID 映射并在改名／删除后失效缓存。
5. 接入 getClient、配置持久化、设置页和原同步流程；新增服务选择项仅在实际适配器可用后显示。
6. 本地协议夹具覆盖分页、过期、限流、上传中断、提交歧义、删除失败和重试；
   再用用户专用远端测试目录做桌面实际验收，移动端单独验证 requestUrl、登录回跳和会话机制。

每个服务均要求：完整读取测试目录、下载字节一致、覆盖失败不误报成功、删除失败不清历史、
重启后认证状态可恢复、过期后可重新登录、无第三方网关依赖。
测试账号权限、应用目录限制、零字节文件和平台大小限制在实测前保持未确认状态。

## 当前产物

本轮完成证据整理与实施顺序，尚未新增网盘适配器，也未使用真实账号验证。
调试环境搭建见 [本地部署指南](../how_to_debug/local-development.zh-cn.md)。

第一批协议模块与验证见 [百度授权基础记录](baidu-auth-foundation.zh-cn.md)。
