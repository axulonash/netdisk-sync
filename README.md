# remotely-save-next

An independently maintained Obsidian sync plugin focused on domestic Chinese environments: WebDAV, Baidu Netdisk, Quark Drive and Aliyun Drive, with simpler settings and synchronization fixes.

Based on [Remotely Save](https://github.com/remotely-save/remotely-save), originally developed by fyears and contributors. Original attribution and licenses are retained; see [UPSTREAM.md](UPSTREAM.md).

Version `0.1.26` is experimental. Real-account and Obsidian GUI acceptance testing is pending. This project has not been published to the community plugin directory.

See the [Chinese README](README.zh-cn.md), [current implementation status](docs/diagnostics/current-status.zh-cn.md), and [local installation and debugging](docs/how_to_debug/local-development.zh-cn.md).

Build with `npm run package:plugin`. Install the three files from `dist/remotely-save-next/` into a test vault at `.obsidian/plugins/remotely-save-next/`. The plugin has its own ID, configuration URI and local database; upstream configuration/history is not imported automatically.

First verify loading, displayed name and settings only. Disable any upstream sync plugin in the test vault before testing this one.

Original licenses remain in [LICENSE](LICENSE), [src/LICENSE](src/LICENSE), and [pro/LICENSE](pro/LICENSE).
