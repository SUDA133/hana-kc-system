# 能力与隐私

| 能力 | 用途 |
| --- | --- |
| app/tools.expose-to-model | 暴露知识检索、写入、候选审阅和诊断工具 |
| app/hooks.tools-pre-execute | 兼容钩子与运行健康记录，不拦截普通工具 |
| app/hooks.tools-post-execute | 从可识别的代理结果提取未发布候选 |
| app/hooks.agent-before-start | 兼容钩子与运行健康记录 |
| app/services.provide | 向授权的 Hana Superpowers 消费者提供只读正式知识服务 |
| app/public-data.publish | 发布候选和旧待核验队列的摘要投影 |
| app/public-data.read | 读取可选 Hana Superpowers 的安装待处理摘要 |

应用自身不调用外部服务，不要求网络权限，不需要 API Key。页面通过宿主认证的同应用路由读取和管理数据，页面浏览不增加 Agent 工具检索热度。

候选捕获默认开启，可在设置中关闭；它会保存识别到的代理输出片段和来源元数据。发布不代表事实认证。知识工具的返回内容可能由 Hana 发送给用户配置的模型服务；请勿把“本地存储”理解成“模型永远不会接触”。

诊断工具可能返回本机数据路径，页面投影会剥离这类内部元数据。分享诊断输出前请检查敏感字段。源码和安装包不包含作者的任何运行数据。

旧测试夹具兼容环境变量 HANA_APP_TEST_FIXTURE / HANA_HOME 和 KC_DATA_DIR 只在未调用 configureDataRoot 的显式测试路径生效。生产入口先配置 sdk.dataDir，环境变量不能覆盖生产数据位置。KC_USER_BYPASS 属旧待核验兼容函数；当前应用没有普通工具门禁，也不会以它跳过卡片写入、生命周期 CAS 或删除备份保护。
