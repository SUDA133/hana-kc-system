# 工具使用

工具按任务需要调用，不要求每轮先查库。只读检索、统计和诊断不写正式卡片；写入和删除走宿主审阅与工具内部校验。

| 工具 | 用途 |
| --- | --- |
| kc_check | 关键词摘要检索，kc_query 的快捷入口 |
| kc_query | 关键词检索或按 agent::id 精确读取，可选全文 |
| kc_stats | 检索使用统计 |
| kc_status | 版本、工具与 Hook、库、候选、生命周期、索引和锁诊断 |
| kc_store | 显式写入正式卡，或标注生命周期元数据 |
| kc_archive | 从显式文本或 proposals 提交待审候选，不发布 |
| kc_verify | 列表、读取、发布或拒绝候选，处理发布收敛和旧待核验队列 |
| kc_delete | 删除前预览、备份并确认删除 |
| kc_reindex | 重建可派生索引 |
| kc_acknowledge / kc_scope | 旧调用的 no-op 兼容入口 |

## 搜索和精确读取

```json
{"keywords":"项目约定,调试","agent":"all","limit":8,"mode":"summary"}
```

上述参数可用于 kc_query。`mode: "detail"` 取全文；`id: "cross::example-note"` 按复合身份精确读取。默认过滤停用、替代、归档和过期卡；`includeInactive: true` 可用于审计。精确 ID 可读旧记录并显示警告。

项目 scope 不匹配时会过滤；未传 project 时，记录自己的适用范围仍需调用者核对。versionRange 仅做文本提示，不自动按 semver 判断有效性。

## 写入

```json
{"agent":"cross","id":"example-note","keywords":["约定"],"summary":"示例摘要","content":"示例正文","expectedDigest":"absent"}
```

这是合成调用示例，安装包不预置此卡。正文最多500字、摘要100字，关键词最多20项、单项50字。新建可用 expectedDigest=absent；覆盖已有不同内容必须先读取 currentDigest，再带 expectedDigest 与 reason，冲突时重读后人工核对，不自动盲目重试。

`action: "annotate"` 只改独立生命周期侧车。需 agent、id、metadata、expectedLifecycleRevision、expectedDigest 与 reason。metadata 可记录 active/deprecated/superseded/archived、sourceRefs、scope、verifiedAt、validUntil、supersededBy。记录核验日期属于调用者声明，不是系统事实认证。

## 候选

kc_archive 支持显式 `[KNOWLEDGE_STORE]` 文本或结构化 proposals。自动捕获也只建候选。kc_verify 的 list/get 供审阅；publish 要求 candidateId、expectedRevision、expectedTargetDigest 与至少10字 reviewSummary。新卡目标 digest 为 absent；已存在时使用审阅时读取的摘要。reject 需要 revision 和 reason。

若发布返回 committed=true、statusPending=true，表示正式卡已经提交但候选状态尚待收敛；按收据 reconcile，不要重复发布。发布成功附带 indexError 时重建索引，不重新写卡。

## 删除与生命周期

页面为常用人工操作提供内联确认。kc_delete 工具支持 ids、agent、reason、confirm=true 与 dryRun；跨 Agent 同名有歧义时拒绝。先保存整卡恢复点并核验，再移除。页面的单卡删除额外校验审阅时的内容摘要和生命周期版本，并阻止删除被其他卡替代关系引用的目标。

生命周期版本是全局侧车 revision，其他卡被管理后旧页面也可能收到冲突；刷新后重新核对。归档可恢复；清除有效期不改变归档状态；页面恢复可用会解除停用、替代和有效期设置。

## 诊断与恢复

kc_status 只读，不清锁、不迁移数据。锁 busy 时等待持锁操作完成；不要按超时直接抢锁。recover-lock 仅在 owner 已死或 ownerless 且摘要匹配等条件下执行，需显式确认与理由。

旧 rejected/published-superseded/already-present 候选可通过 discard-candidate 备份清理；pending、publishing、published 不走该清理通道。具体参数以当前工具 schema 为准。
