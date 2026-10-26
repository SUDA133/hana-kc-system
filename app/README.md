# KC System 1.0.0

HanaAgent 本地知识卡片库。提供检索、候选审阅、归档与有效期管理、确认删除、主题切换和运行诊断。

从 Hana 扩展管理导入此应用 ZIP，审阅并批准能力后，打开「KC 知识库」。首次安装为空库。应用代码不包含用户卡片、会话、凭据、候选或个人配置；运行数据由宿主分配的 sdk.dataDir 保存，安装到已有同 ID 应用时不会清空原数据。

使用说明和源码：https://github.com/SUDA133/hana-kc-system
许可：Apache-2.0。详见 LICENSE、NOTICE 和 sdk/THIRD_PARTY_NOTICES.txt。

知识检索不构成事实认证；候选需审阅后发布。删除会保存恢复点，页面暂无一键恢复。应用自身不调用外部服务，但工具结果可能进入宿主配置的模型上下文。

Hana Superpowers 集成为可选；未安装时相关诊断显示不可用，不影响知识库独立使用。
