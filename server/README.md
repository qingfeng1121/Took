# took/server

Go 后端：**重复规则引擎**（无外部依赖，纯标准库）+ 只读查询 + 同步中介（契约 §7）。

## 本机环境（2026-10-23 实测）

| 项 | 值 |
|---|---|
| Go | 1.27.3 windows/amd64，`GOROOT=D:\work\GO\go` |
| 模块缓存 | `GOPATH=D:\work\GO\gopath`，`GOCACHE=D:\work\GO\gocache` |

> Go 的 zip 曾解压不完整（`pkg/tool` 整个缺失，导致 `no such tool "vet"`），
> 已用 `tar -xf D:\work\GO\go1.27.3.windows-amd64.zip -C D:\work\GO` 补全。

## 跑测试

```powershell
$env:GOROOT  = "D:\work\GO\go"
$env:GOPATH  = "D:\work\GO\gopath"
$env:GOCACHE = "D:\work\GO\gocache"
$env:Path    = "$env:GOROOT\bin;$env:Path"
cd D:\work\Project\Took\server
go vet ./...
go test ./... -count=1
```

当前基线（2026-10-26）：`gofmt -l .` 空、`go vet ./...` 干净、`go test ./...` **43 PASS**
（原 28 条全绿未回退，新增 15 条：conflicts 9 条〔含服务端赢的 4 条〕、export 3 条、auth 3 条）。

## 已覆盖的规则

`internal/engine` 实现「周期打卡」的命中判定与周期归属，对应定稿 §3.2 / §3.3：

- 每周固定几天（bit0=周一 … bit6=周日，周一为一周之始）
- 每 N 天（1~3660，从 start_date 起算）
- 每月某日（含 `month_day=-1` 表示每月最后一天；小月钳制到月末，**不改写用户填的值**）
- 每年某月某日（2/29 在平年落 2/28，且**不溢出到 3/1**）
- 不重复
- 起始日之前的日期一律不命中；repeat_until / end_date 之后不命中

打卡键：`taskID + ":" + PeriodStartOf(rule, date)` —— 同一周期内所有命中日共享状态。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 存活探测 |
| GET | /api/rules | 规则列表，含其下任务 |
| GET | /api/month?y=2026&m=10 | 该月每天命中的任务与打卡状态；参数非法返回 400 |
| POST | /api/sync/push | 同步推：`{rules,tasks,memos,completions}` 逐条 upsert；响应带 `conflicts` |
| GET | /api/sync/pull?since=N | 同步拉：`rev > N` 的全部记录（含墓碑） |
| GET | /api/v1/export | 全量导出（备份）；`?format=sqlite` 回 SQLite 文件本体 |

### 同步（契约 §7）

- **rev 由单行计数器表 `sync_counter` 产生**，不是每次写都 `SELECT MAX(rev)`：计数器 O(1)，
  且不依赖「四张表里谁的 rev 最大」；`Open` 时会把计数器抬到四表现有 rev 的最大值，老库能单调续上。
- 仲裁（§7.2）：`updated_at` 大者赢 → 相等比 `rev` 大者赢 → 再相等保留服务端原值（幂等）。
  completion 同样按 `updated_at` LWW，**不用** `max(status)`（打卡可撤销）。
- `push` 响应里的 `accepted` 是**真正写进库的条数**：仲裁输掉的记录不写、不占 rev、不计数。
- `pull` 单次最多 500 条；`hasMore=true` 时 `maxRev` 是本页最后一条的 rev（下次 `since` 传它），
  `hasMore=false` 时 `maxRev` 是服务端全局 maxRev。`deleted=1` 的墓碑照常下发（§7.3）。
- 写入层日期校验：`engine.ValidateDate` 严格拒绝 `2026-1-5` / `2026/10/01` / `2026-02-30`，
  整单回滚并回 400（§3.4 第一层）；读取层仍按第二层静默兜底。

### 冲突上报（契约 §7.2 第 4 条）

`repeat_mode` / `weekdays_mask` / `month_day` / `year_month` / `year_day` / `start_date` / `end_date`
这 7 个字段两端都改过时，LWW 会静默丢掉一边，所以 `push` 响应多一个 `conflicts` 数组：

```json
{
  "accepted": {"rules": 1, "tasks": 0, "memos": 0, "reminders": 0, "completions": 0},
  "maxRev": 3,
  "conflicts": [{
    "id": "r_e2e", "table": "rule", "reason": "rule_fields_both_modified",
    "winner": "client",
    "clientUpdatedAt": 3000, "serverUpdatedAt": 2000,
    "fields": ["repeat_mode", "month_day"]
  }]
}
```

- 判定条件三个都要满足：**同一 id**、**`updated_at` 与 `rev` 都不相等**（简单覆盖不算）、
  **7 个字段里确有差异**。**判据与谁赢无关**——服务端赢时被丢掉的是本次 push 的改动，
  那恰恰是最该提示用户的一种。
- `winner` 标明这次 LWW 把哪边保下来了：
  - `"client"`：本次 push 赢了，**另一端**的改动被覆盖（`accepted` 计数 +1）；
  - `"server"`：服务端原值赢了，**本次 push 的改动被丢弃**（`accepted` 不计数、库内不变）。
    前端必须据此提示「你的改动被另一端覆盖」，否则用户只会看到界面闪回旧值而毫无解释。
- 只上报、不拦截：同步不会被卡住。 `accepted` 仍是**真正写进库的条数**，`winner=server` 不计数。
- `title` / `enabled` / `repeat_every` / `repeat_until` / `deleted` 不在清单里，冲突不报。
- 无冲突时 `conflicts` 是 `[]`（不是 `null`），客户端可以直接遍历。

### 全量导出（`GET /api/v1/export`）

备份用，也是「后端挂了数据还在」的保险。默认回 JSON：

```json
{ "rules": [], "tasks": [], "memos": [], "reminders": [], "completions": [],
  "maxRev": 16, "exportedAt": "2026-10-26T01:42:49Z" }
```

- 五张表**全量**，含 `deleted=1` 的墓碑——备份要能完整还原，缺了墓碑，还原后对端的删除会「复活」。
- 视图与 `/api/sync/push` 的请求体**同构**：导出的 JSON 原样 POST 回 `/api/sync/push`
  就是一个合法的还原请求（多出来的 `maxRev` / `exportedAt` 会被解码器忽略）。
- `?format=sqlite` 回 SQLite 文件本体（`Content-Type: application/octet-stream`），
  由 `VACUUM INTO` 生成整库快照，拿到的是同一个事务视图。

还原实测（导出 → 清空五张表 → push 回去 → 逐字段比对，忽略 rev）：

```
IDENTICAL rules (5 rows, rev 已忽略)
IDENTICAL tasks (7 rows, rev 已忽略)
IDENTICAL memos (1 rows, rev 已忽略)
IDENTICAL reminders (1 rows, rev 已忽略)
IDENTICAL completions (2 rows, rev 已忽略)
==> 往返一致：导出 -> 清库 -> push 回去 -> 数据逐字段还原
```

### 鉴权（Bearer token）

默认**不校验**——局域网自部署的单用户场景，少一步配置就少一次「打不开」。

开启方式（二选一，启动参数优先于环境变量）：

```powershell
# 1) 启动参数
.\took-server.exe -addr :8420 -db took.db -token <你的 token>

# 2) 环境变量
$env:TOOK_TOKEN = "<你的 token>"
.\took-server.exe -addr :8420 -db took.db
```

保护面只有会写库或吐全量数据的两条：`/api/sync/*` 与 `/api/v1/export`。
只读接口（`/api/health`、`/api/rules`、`/api/month`）**永远公开**，否则客户端连「后端在不在」都探测不了。

客户端请求头：

```
Authorization: Bearer <你的 token>
```

校验失败回 401 + `{"ok":false,"error":"unauthorized","message":"需要 Authorization: Bearer <token>"}`，
并带 `WWW-Authenticate: Bearer realm="took"`。方案名大小写不敏感（`Bearer` / `bearer` 都收），
token 用 `subtle.ConstantTimeCompare` 比对。

### 已验证的业务语义（8/8）

- 10 月返回 31 格
- 周日不出现「每周一~周五」的规则
- 打卡按 (task_id, period_start) 共享：10-19 那一周任意一天的「健身」都显示已完成
- 下一周（10-26 起）不共享上一周的完成状态
- 房租只出现在每月 20 日
- 每年 3/15 的规则不出现在 10 月

## 数据库

SQLite，驱动 `modernc.org/sqlite`（纯 Go，不需要 cgo / gcc）。
建表脚本在 `internal/store/schema.sql`，用 `//go:embed` 嵌进二进制，启动时自动建表。
