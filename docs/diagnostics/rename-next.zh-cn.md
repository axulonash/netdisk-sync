# remotely-save-next 更名与第一步验收（2026-10-08）

新项目名称、插件 ID 和 npm 包名均为 `remotely-save-next`，独立版本从 `0.1.0` 开始。
配置链接为 `obsidian://remotely-save-next?...`，数据库为 `remotely-save-next-db`。
产品首页和界面使用新名称；原项目只作为来源说明，见 [UPSTREAM.md](../../UPSTREAM.md)。
原始许可证保留，历史兼容协议名和源码引用未机械替换。
上游 CLA 自动化已停用，国内三个默认服务不展示原项目商业账号入口。

本次针对性验证：19 项测试通过，类型检查与正式构建通过，构建保留 5 条既有警告。
本次未重复完整同步回归，也未进行真实网盘和 Obsidian GUI 验收。

## 第一步：只验证安装和界面

1. 新建专用空测试仓库；如已安装原插件，先停用它。
2. 解压 `remotely-save-next-desktop-experimental.zip`，将其中 `remotely-save-next` 文件夹
   放入测试仓库的 `.obsidian/plugins/`。文件夹内应有 `main.js`、`manifest.json`、`styles.css`。
3. 重启 Obsidian，打开社区插件列表，确认显示 `remotely-save-next`，启用它。
4. 若显示初次使用确认窗口，按说明操作；打开设置页，确认标题是新名称，WebDAV 为默认，
   桌面端下拉选项包括 WebDAV、百度网盘、夸克网盘。
5. 本步不登录网盘、不填写真实凭据、不执行同步。若启用失败，记录报错和 Obsidian/系统版本。

确认插件加载和设置页正常后，再进行 WebDAV 专用测试目录的连接和预览测试。
工作区源码仍位于 `/home/axulo/todo/remotely-save`，安装路径与产品身份已经独立更名。
