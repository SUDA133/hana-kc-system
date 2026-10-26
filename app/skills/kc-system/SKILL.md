---
name: kc-system
description: "知识卡片（KC）系统的使用规范（公开版 v1.0.0）：按需检索正式卡片、标注生命周期、审查并发布候选、处理错误与锁恢复。触发：调用 kc_check / kc_query / kc_store / kc_verify / kc_archive / kc_status、检索或写入知识卡片、处理候选与待核验项、查看卡片失效提示、诊断 KC 存储与锁。"
default-enabled: false
---

# kc-system — 知识卡片系统（公开版 v1.0.0）

KC 是本地知识库：正式卡片可检索、可被 HC 服务读取；候选只是待审建议。它不拦截普通工具，也不要求每个任务先打卡。检索命中表示库里有这条记录，不表示内容正确或仍然有效。

## 一、定位与使用时机

需要跨会话的事实、约定、踩坑记录时查一次；任务与知识无关就不查。值得查的场合：不确定项目约定、工具坑位或历史决策；用户提到「之前记过」「知识库」「KC」；准备写入前先确认同 id 是否已有内容。

`kc_check` 是 `kc_query` 的摘要别名，不是门禁前置动作。系统没有轮次计数、ACK、review 挂起之类的全局拦截；不会因为你没查 KC 就拦住高风险操作。旧设置里的 `observe` / `enforce` 只作兼容保留，不恢复旧门。

## 二、工具面

工具名保持 v2 应用的注册名，不带宿主前缀。10 个旧名全部保留，`kc_acknowledge` 与 `kc_scope` 只作 no-op 兼容。

| 工具 | 用途 | 权限档 |
|---|---|---|
| `kc_check` | `kc_query` 的摘要别名（默认 8 条） | 只读 |
| `kc_query` | 关键词检索 / 精确 id 读取 | 只读 |
| `kc_stats` | 热度统计 | 只读 |
| `kc_status` | 库、候选、生命周期、锁与运行诊断 | 只读 |
| `kc_store` / `kc_delete` / `kc_reindex` | 写卡 / 归档删除 / 重建索引 | review |
| `kc_verify` | 候选发布、终态清理、旧待核验项、锁恢复 | review（list/get 只读） |
| `kc_archive` | 提候选，不发布 | review |
| `kc_acknowledge` / `kc_scope` | 退役 no-op | 兼容 |

## 三、检索与有效性

```
kc_query { keywords: "词1, 词2", agent: "all", limit: 8, mode: "summary", includeInactive: false }
kc_query { id: "agent::id" }      # 精确读取，不转模糊
kc_check { keywords: "..." }      # 同一搜索，只回摘要
```

- 关键词 ≤20 项、每项 ≤100 字符、整串 ≤2000；`limit` 取 1..50，大小写与首尾空白归一后去重。
- 排序可解释：精确 keyword、词边界、summary 字面命中优先；`lastUpdated` 不抬权，基础分不当相关度。
- 默认排除 `deprecated` / `superseded` / `archived` / 已过期；`includeInactive=true` 用于审计。精确 id 始终可读，但会强提示 inactive；读到的也只是记录，不是有效性认证。
- 无标注的旧卡是 `legacy-unverified`：可检索、可读，不是错误，也不等于已核验。`project` 与卡片 `scope.project` 不同时排除；输入未给 project 但卡有 scope 时只提示核对。`versionRange` 只做文本提示，不按 semver 解析，也不据此过滤。
- 无命中不是错误；分片缺失、坏行、身份冲突进 `diagnostics` 并 `complete=false`。索引损坏自动降级扫描，`indexStatus` 标 `corrupt` / `stale`。

## 四、写入与元信息

新建卡走显式 `kc_store`，这是已授权的发布入口，不经过候选：

```
kc_store { id, agent, keywords: [...], summary, content, related: [], score }
```

- `content` ≤500 字、`summary` ≤100 字；`keywords` ≤20 项、每项 ≤50 字符、禁止换行；越界拒写。
- 同 id 内容完全相同则幂等成功；内容不同属于实质覆盖，必须带 `expectedDigest`（当前摘要）与 `reason`，否则拒绝。`expectedDigest: "absent"` 表示只允许新建。
- 冲突不改字节，返回 `currentDigest`；想继续就重读后用当前 digest 重试。

元信息放在独立侧车，只改元信息时不重写正文：

```
kc_store { action: "annotate", agent, id, metadata, expectedLifecycleRevision, expectedDigest, reason }
```

- `metadata` 可含 `status`（active / deprecated / superseded / archived）、`sourceRefs`（≤10）、`scope` / `project` / `versionRange`、`verifiedAt`、`validUntil`、`supersededBy`、`reason`。
- `metadata: null` 只清这个 key，不清整个侧车；到 5000 条上限仍允许改或清已有 key。
- 必须带 `expectedLifecycleRevision`、`expectedDigest` 与 `reason`；卡不存在、digest 不符、lifecycle 不可用（`LIFECYCLE_UNAVAILABLE`）都拒绝。
- 只有 annotate 写侧车；它记录声明与日期，不认证内容，也不自动把旧卡标成已验证。publish 或 delete 改了卡片内容后，旧条目因 digest 不符而失效，需要重新 annotate。

## 五、候选与发布

候选默认 `pending`，不进正式检索，也不进 HC 服务；下面两个入口都只建候选：

```
kc_archive { text: "[KNOWLEDGE_STORE] ..." }   # 手动恢复入口，只处理显式文本
kc_archive { proposals: [ { agent, id, keywords, summary, content, related? } ] }   # ≤20 条
```

- 自动捕获只在 post-execute 对可识别的代理结果提候选（闭合区块单块 ≤8k、总 ≤64k），只提候选、不写正式库；没有新知识跳过，畸形区块生成带 diagnostic 的候选。它不承诺覆盖所有异步结果（deferred_result 没有公开接线），漏掉的用 `kc_archive` 手动补。
- 自动捕获由 `autoCapture` 控制：未设置时按开启处理；配置读取失败只暂停本次捕获并记 health，不拦普通工具。

`kc_verify` 处置候选与旧待核验项，两类不混装：

```
kc_verify { action: "list" }      # 每项带 kind=legacy|candidate
kc_verify { action: "get", candidateId }
kc_verify { action: "publish", candidateId, expectedRevision, expectedTargetDigest: "absent"|"<sha256>", reviewSummary }
kc_verify { action: "reject", candidateId, expectedRevision, reason }
kc_verify { action: "reconcile", candidateId, expectedRevision, reason }
kc_verify { action: "recover-lock", confirm: true, reason, expectedDigest? }
kc_verify { action: "discard-candidate", candidateId, expectedRevision, confirm: true, reason }
```

- publish 只收 `candidateId`：候选要完整（500 / 100 / 关键词边界）、`reviewSummary` ≥10 字、目标当前 digest 与 `expectedTargetDigest` 一致。目标不存在时写 `"absent"`。
- `reviewSummary` 是调用者声明，不等于人工批准，也不认证内容。
- 目标原本同内容时返回 `already-present` + `committed=false`，不伪造新提交；只有真实提交或有提交证据的恢复才标 `published`。
- 卡已提交但候选状态没写成功时返回 `committed=true` + `statusPending=true`；重试按 receipt 对目标 digest 判定，不靠时间猜。
- reject 遇到已有 prepared / committed 意图会拒绝，先用 reconcile 收敛；reconcile 可能把历史候选标成 `published-superseded`，不回滚正式卡。
- 旧 pending 走显式兼容：`confirm kcName=...`（核对卡确实在库）或 `reject kcName=... reason=...`。升级不迁移、也不清空旧 pending。
- `recover-lock` 只处理 owner 已死（ESRCH）或 ownerless 且 digest 匹配的锁；owner 活着或状态未知时拒绝强夺，不用 TTL 抢锁。
- `discard-candidate` 仅处理 rejected / published-superseded / already-present，需 confirm=true、revision、≥10 字理由。原文、对应发布收据与审计先备份到 `candidate-archive/` 并读回；pending、publishing、published 不清理，正式卡不变。

## 六、删除与恢复

```
kc_delete { ids: [...], reason: "...", confirm: true, dryRun?: true }
```

- 先整卡归档到 `deleted/` 并读回核验，再移除；归档不一致就拒绝。`confirm=true` 必填，`dryRun` 先预览；跨 agent 同名歧义拒绝，不猜。
- 跨分片删除逐分片回报，部分完成如实返回已提交分片与 `indexError`。
- 归档默认全保留；`archiveRetention` 清理恢复点必须再带 `confirmPrune=true`。
- `kc_scope` 已退役，退役不影响上面的删除保护，也不会开放任意路径豁免。

## 七、只读诊断：kc_status

```
kc_status {}
```

返回版本、policyVersion 5、模式（observe / enforce 仅兼容）、工具与 Hook 注册、能力账本、存储路径、锁（path / owner / state / remedy）、候选计数、lifecycle 与索引健康、HC 快照状态、未支持项。它只读，不写库，不自动恢复，不清锁。

`loaded` 只代表模块加载，不等于 healthy。内存健康标记没有持久历史，App 重启即清零；看到 `degraded` 或 `busy` 时按 remedy 处理。

## 八、数据位置与兼容

正式库在应用私有目录 `{HANA_HOME}/app-data/kc-system/`：

| 根 | 内容 |
|---|---|
| `DATA_DIR`（默认 `APP_DATA_DIR/data`） | `*.notes.jsonl`（agent 分片）、`index.json`、`stats.json`、`lifecycle.json`（schema1 + revision）、`deleted/`（删除归档） |
| `APP_DATA_DIR`（`{HANA_HOME}/app-data/kc-system`） | `candidates/`、`publish-receipts/`、`backups/`（覆盖写分片备份，区别于 `DATA_DIR/deleted`）、`locks/` |

HC 走 `app:kc-system/query` 的 schemaVersion 1：`list` / `status` / `card` 字段保持，内部消费者 id 仍是 `hana-superpowers`，新增 `snapshotId` 分页校验。HC 只看到正式卡，看不到候选。`info.operations` 声明 search 时可用统一 relevance 与生命周期视图，未声明的旧 KC 走兼容检索。`status.active` 同时检查生命周期与 scope。

## 九、常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 覆盖被拒，返回 `currentDigest` | 没带 expectedDigest 或目标已变 | 重读卡，确认后用当前 digest 重试 |
| `LIFECYCLE_UNAVAILABLE` | 侧车损坏或不可读 | 先修 lifecycle，再 annotate 或 publish |
| `committed=true` + `indexError` | 卡已写，索引失败 | 跑 `kc_reindex`，不要重复写卡 |
| `statusPending=true` | 候选状态未落盘 | 用 receipt 重试 publish 或 reconcile |
| 锁 `busy` | 有活进程持锁 | 等它释放；确认进程已死才 `recover-lock` |
| 空结果 | 无命中或全被 inactive 过滤 | 换词，或用 `includeInactive=true` 审计 |

## 十、边界

- 检索是关键词匹配，不是事实认证；自动捕获只覆盖可识别的结果形状，不承诺覆盖所有异步或延迟结果。
- 坏行、坏 lifecycle、坏索引只报诊断，不会被 normalize 或 reindex 默认重写。
- 本版不迁移数据：旧 pending、旧分片保持原样；升级不批量改卡，也不清空队列。
- 随包 Skill 更新不覆盖用户已安装的旧版本；App 上线走正式审批，数据与进度状态的迁移不在本包授权内。
