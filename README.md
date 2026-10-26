# KC System

HanaAgent 的本地知识卡片库。把经验保存在独立卡片中，按关键词检索，在页面审阅候选，并管理知识的适用范围和有效期——构建独属于每个agent的本地知识库

**公开版 1.0.0 · Hana v2 App · Apache-2.0**

## 功能

- 搜索、分页、Agent 筛选、卡片详情和关联导航。
- 候选与目标卡片对比，确认后发布或拒绝；候选不会自动成为正式知识。
- 常用状态筛选：可用、已停用、已归档、全部。
- 归档、恢复、停用、设置和清除有效期、立即过期。
- 删除前预览目标并确认，写前校验卡片摘要和生命周期版本，保存恢复点。
- 跟随 Hana、浅色和深色主题。
- 索引、生命周期、锁、候选和运行健康诊断。
- 11 个 Agent 工具，以及可选的 Hana Superpowers 只读集成。

检索结果表示库中存在这条记录，内容是否正确、是否适用仍需核对来源。应用不会把已发布自动解释成已验证，也不会拦截普通工具来强制执行工作流。

## 安装与开始使用

1. 从 [Releases](https://github.com/SUDA133/hana-kc-system/releases) 下载 `app-kc-system-1.0.0.zip`。
2. 在 Hana 的扩展管理中从 ZIP 安装，审阅并批准声明的能力。
3. 打开导航里的「KC 知识库」。首次安装是空库，可让 Agent 使用 `kc_store` 写入你的第一张卡片。
4. 按需在应用设置中关闭「自动收集知识候选」。开启时，仅从可识别的代理结果提取待审候选，不会自动发布。

安装包已包含运行代码和 SDK，无需 npm install，也不需要 API Key。应用清单要求 Hana ≥ 1.0.11-beta；实际自测宿主版本和操作系统见 [自测报告](docs/TESTING.md)。没有在所有满足最低版本的宿主上实测。

本发布包不包含任何用户知识记录、候选、会话、凭据、个人配置或旧开发历史。应用运行后会在 Hana 分配的私有 `sdk.dataDir` 中保存自己的数据。安装到已有同 ID 应用的环境时，宿主保留的数据仍然可见；安装包不会清空或携带这些数据。公开版从 1.0.0 独立起版，已有更高内部版本的用户请勿当作正常升级安装。

## 数据与使用边界

正式卡片是 `data/*.notes.jsonl`，生命周期元数据、检索统计和可重建索引分别保存。候选、发布收据、锁和恢复点位于应用私有目录下。更新应用代码与这些数据分离。

Agent ID 使用受限的小写 kebab-case；可为自己的 Agent 创建分片，不需要采用作者的团队名称。跨 Agent 的同名卡片由 `agent::id` 区分。`cross` 可用作共享知识归属。模型工具调用形状见 [工具说明](docs/TOOLS.md)。

删除先保存恢复点再移除，页面暂不提供一键还原。应用本身不访问外部服务，不上传知识数据；其工具返回内容仍可能进入 Hana 配置的模型上下文，自动捕获的候选也可能含原结果中的敏感文字。请自行审阅后发布、分享或导出。

Hana Superpowers 未安装或其投影不可用时，集成诊断会显示不可用；知识库和候选审阅仍可独立使用。候选捕获不保证覆盖所有异步或延迟结果，可用 `kc_archive` 显式提交候选。

## 开发与验证

源码入口在 `app/index.js`，页面在 `app/ui/`，业务模块在 `app/lib/`，工具在 `app/tools/`。本应用为直接运行的 ES Module，无编译步骤。随附 SDK 已限制为所需运行依赖；许可证及原始第三方声明保留。

```sh
node --test tests/*.test.mjs
node scripts/audit-release.mjs
```

测试只创建合成数据。运行后会留下被 Git 忽略的 `.fixture-*` 临时目录；源码打包器按明确清单生成归档，不会把这些目录带入。

在已安装官方 `hana-app-creator` 作者工具的环境中，用随附脚本把 `app/` 复制到全新的 `build/kc-system/` 并调用官方打包器，再验证最终安装 ZIP：

```sh
python scripts/package-app.py --creator <hana-app-creator> --publisher SUDA133
node <hana-app-creator>/scripts/validate_app.mjs --archive dist/app-kc-system-1.0.0.zip --smoke --json
python scripts/source-zip.py
```

UI smoke 需要可用的独立 Electron。市场发布须保留官方打包器生成的 ZIP 与匹配 `.entry.json`，并将两者上传到同一个正式 Release。不要用源码 ZIP 代替安装包。

## 许可

本项目代码及原创 SVG 图形使用 [Apache-2.0](LICENSE)。Hana App SDK 版权属于 liliMozi 及其贡献者，保留原许可和第三方声明，见 [NOTICE](NOTICE)。这是社区应用，不代表 HanaAgent 官方产品或审核认证。
