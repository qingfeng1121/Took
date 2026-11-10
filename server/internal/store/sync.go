// 同步协议落地（契约 §7）：push 逐条 upsert + LWW 仲裁，pull 按全局 rev 增量下发。
//
// rev 由单行计数器表 sync_counter 产生，不用每次写都 SELECT MAX(rev)：计数器是 O(1)，
// 也不受「四张表之一被清空/被物理删」的影响；Open 时会把计数器抬到四表现有 rev 的最大值，
// 所以老库（含 rev=0 的历史行）也能单调续上，不会撞号。
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"math"
	"unicode/utf8"

	"took/server/internal/engine"
)

// ErrInvalidRecord 表示请求体里有写不进库的记录（目前是非法日期）。HTTP 层据此回 400。
var ErrInvalidRecord = errors.New("同步记录不合法")

// pullPageSize 是单次 pull 最多下发多少条记录，hasMore 靠它触发。
// 用固定常量而不是查询参数：契约 §7.1 没有 limit，不要自造协议。
// 声明成变量只为让分页测试把它调小，业务代码不得改写。
var pullPageSize = 500

// ---- 传输视图 ----
//
// 五张同步视图 = 表内字段 + 同步四件套里的 rev / updated_at / deleted。
// dirty 是客户端字段，服务端不回传（契约 §7.1）；deleted 按 §7.3 用 0/1。
// 所有开关列（enabled / notify_on / alarm_on / deleted / dirty）在同步 JSON 里一律是 0/1 整数，
// 不用 JSON 布尔：三端本地库这几列都是 SQLite INTEGER，走布尔要多一层转换，正是三语言里最容易漂的地方——
// SyncRule.Enabled 以前是 bool，PC 与 Android 发的 0/1 直接 400，整条同步链就是这么断的（契约 §7.1 已定口径）。

// SyncRule 是 rule 表的同步视图（不含 tasks 嵌套，父子关系由 task.rule_id 表达）。
type SyncRule struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Enabled      int    `json:"enabled"` // 0/1 整数，不是 JSON 布尔（契约 §7.1）
	RepeatMode   int    `json:"repeat_mode"`
	WeekdaysMask int    `json:"weekdays_mask"`
	RepeatEvery  int    `json:"repeat_every"`
	MonthDay     int    `json:"month_day"`
	YearMonth    int    `json:"year_month"`
	YearDay      int    `json:"year_day"`
	StartDate    string `json:"start_date"`
	EndDate      string `json:"end_date"`
	RepeatUntil  string `json:"repeat_until"`
	Rev          int64  `json:"rev"`
	UpdatedAt    int64  `json:"updated_at"`
	Deleted      int    `json:"deleted"`
}

// SyncTask 是 task 表的同步视图。
type SyncTask struct {
	ID        string `json:"id"`
	RuleID    string `json:"rule_id"`
	Title     string `json:"title"`
	Enabled   int    `json:"enabled"` // 0/1 整数，不是 JSON 布尔（契约 §7.1）
	SortOrder int    `json:"sort_order"`
	Rev       int64  `json:"rev"`
	UpdatedAt int64  `json:"updated_at"`
	Deleted   int    `json:"deleted"`
}

// SyncMemo 是 memo 表的同步视图。
type SyncMemo struct {
	ID        string `json:"id"`
	Kind      int    `json:"kind"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
	Category  string `json:"category"`
	Rev       int64  `json:"rev"`
	UpdatedAt int64  `json:"updated_at"`
	Deleted   int    `json:"deleted"`
}

// SyncCompletion 是 completion 表的同步视图，主键是 (task_id, period_start)。
type SyncCompletion struct {
	TaskID      string `json:"task_id"`
	PeriodStart string `json:"period_start"`
	Status      int    `json:"status"`
	Rev         int64  `json:"rev"`
	UpdatedAt   int64  `json:"updated_at"`
	Deleted     int    `json:"deleted"`
}

// SyncReminder 是 reminder 表的同步视图（契约 §11）。notify_on / alarm_on 用 0/1 而不是 bool，
// 因为「两个都关」是非法状态，写入层要能区分「没开」和「字段没传」——后者会被当成 0 拒掉，不会静默变成合法值。
type SyncReminder struct {
	ID         string `json:"id"`
	OwnerKind  int    `json:"owner_kind"`
	OwnerID    string `json:"owner_id"`
	NotifyOn   int    `json:"notify_on"`
	AlarmOn    int    `json:"alarm_on"`
	TimeOfDay  string `json:"time_of_day"`
	NotifyText string `json:"notify_text"`
	OffsetDays int    `json:"offset_days"`
	RepeatRule int    `json:"repeat_rule"`
	SnoozeMin  int    `json:"snooze_min"`
	Enabled    int    `json:"enabled"`
	Rev        int64  `json:"rev"`
	UpdatedAt  int64  `json:"updated_at"`
	Deleted    int    `json:"deleted"`
}

// PushRequest 是 POST /api/sync/push 的请求体（契约 §7.1）。
type PushRequest struct {
	Rules       []SyncRule       `json:"rules"`
	Tasks       []SyncTask       `json:"tasks"`
	Memos       []SyncMemo       `json:"memos"`
	Reminders   []SyncReminder   `json:"reminders"`
	Completions []SyncCompletion `json:"completions"`
}

// Accepted 是本次真正写进库的条数（服务端原值胜出的记录不算，见 wins）。
type Accepted struct {
	Rules       int `json:"rules"`
	Tasks       int `json:"tasks"`
	Memos       int `json:"memos"`
	Reminders   int `json:"reminders"`
	Completions int `json:"completions"`
}

// PushResult 是 push 的响应体。Conflicts 是契约 §7.2 第 4 条要求的「两端同改」告警：
// 记录照常按 LWW 落库，只是把会被静默丢掉的那一边告诉客户端。
type PushResult struct {
	Accepted  Accepted   `json:"accepted"`
	MaxRev    int64      `json:"maxRev"`
	Conflicts []Conflict `json:"conflicts"`
}

// ConflictRuleFieldsBothModified 是 Conflict.Reason 的唯一取值：同一规则的 7 个规则字段两端都改过。
const ConflictRuleFieldsBothModified = "rule_fields_both_modified"

// Conflict.Winner 的两个取值：这次 LWW 把哪一边保下来了。
//
// 为什么要有它：冲突发生在**两个方向**——可能是客户端覆盖了服务端，也可能是客户端被服务端
// 覆盖。两者的处理方式完全不同：
//   - winner=client：服务端的改动被丢了，但客户端本来就是发起方，前端通常只需静默重拉；
//   - winner=server：**这次 push 的改动被丢了**，必须明确提示「你的改动被另一端覆盖」，
//     否则用户改完看到界面闪回旧值，只会以为应用坏了。
//
// 没有这个字段，前端就得自己猜方向，而猜错的代价正好是定稿要防的那种「数据静默丢失」。
const (
	ConflictWinnerClient = "client"
	ConflictWinnerServer = "server"
)

// Conflict 是契约 §7.2 第 4 条的上报结构：LWW 总会静默丢掉一边，
// 「数据静默丢失比多一次点击糟糕得多」，所以把冲突字段交回前端让用户裁决。
// 只有 rule 表带这 7 个规则字段，其余表没有「规则字段」语义，不会出现在这里。
type Conflict struct {
	ID              string   `json:"id"`
	Table           string   `json:"table"`
	Reason          string   `json:"reason"`
	Winner          string   `json:"winner"` // client=本次推的赢、server=服务端原值赢（本次改动被丢）
	ClientUpdatedAt int64    `json:"clientUpdatedAt"`
	ServerUpdatedAt int64    `json:"serverUpdatedAt"`
	Fields          []string `json:"fields"`
}

// PullResult 是 pull 的响应体。deleted=1 的墓碑照样下发（契约 §7.3）。
type PullResult struct {
	Rules       []SyncRule       `json:"rules"`
	Tasks       []SyncTask       `json:"tasks"`
	Memos       []SyncMemo       `json:"memos"`
	Reminders   []SyncReminder   `json:"reminders"`
	Completions []SyncCompletion `json:"completions"`
	MaxRev      int64            `json:"maxRev"`
	HasMore     bool             `json:"hasMore"`
}

// ---- push ----

// Push 按契约 §7.1 逐条 upsert：先仲裁，赢的一方写入并拿 rev = 服务端全局 maxRev + 1。
//
// 日期非法则整单拒绝（事务里一条都不落），对应契约 §3.4 的写入层要求。
func (s *Store) Push(req PushRequest) (PushResult, error) {
	if err := validatePush(req); err != nil {
		return PushResult{}, err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return PushResult{}, fmt.Errorf("开启事务失败：%w", err)
	}
	defer tx.Rollback()

	var acc Accepted
	conflicts := []Conflict{}
	// 顺序 rule → task → memo → completion：让被引用的行先落地。
	for _, r := range req.Rules {
		written, cf, err := upsertRule(tx, r)
		if err != nil {
			return PushResult{}, err
		}
		if written {
			acc.Rules++
		}
		if cf != nil {
			conflicts = append(conflicts, *cf)
		}
	}
	for _, t := range req.Tasks {
		written, _, err := upsertTask(tx, t)
		if err != nil {
			return PushResult{}, err
		}
		if written {
			acc.Tasks++
		}
	}
	for _, m := range req.Memos {
		written, _, err := upsertMemo(tx, m)
		if err != nil {
			return PushResult{}, err
		}
		if written {
			acc.Memos++
		}
	}
	for _, rm := range req.Reminders {
		written, _, err := upsertReminder(tx, rm)
		if err != nil {
			return PushResult{}, err
		}
		if written {
			acc.Reminders++
		}
	}
	for _, c := range req.Completions {
		written, _, err := upsertCompletion(tx, c)
		if err != nil {
			return PushResult{}, err
		}
		if written {
			acc.Completions++
		}
	}

	maxRev, err := currentRev(tx)
	if err != nil {
		return PushResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return PushResult{}, fmt.Errorf("提交事务失败：%w", err)
	}
	return PushResult{Accepted: acc, MaxRev: maxRev, Conflicts: conflicts}, nil
}

// wins 实现契约 §7.2 的仲裁：updated_at 大者赢；相等比 rev，大者赢；再相等保留服务端（幂等）。
func wins(clientUpdatedAt, clientRev, serverUpdatedAt, serverRev int64) bool {
	if clientUpdatedAt != serverUpdatedAt {
		return clientUpdatedAt > serverUpdatedAt
	}
	return clientRev > serverRev
}

// nextRev 在事务内把全局计数器 +1 并返回新值，即契约 §7.1 的「服务端当前 maxRev + 1」。
func nextRev(tx *sql.Tx) (int64, error) {
	if _, err := tx.Exec(`UPDATE sync_counter SET rev = rev + 1 WHERE id = 1`); err != nil {
		return 0, fmt.Errorf("递增 rev 计数器失败：%w", err)
	}
	return currentRev(tx)
}

func currentRev(tx *sql.Tx) (int64, error) {
	var rev int64
	if err := tx.QueryRow(`SELECT rev FROM sync_counter WHERE id = 1`).Scan(&rev); err != nil {
		return 0, fmt.Errorf("读取 rev 计数器失败：%w", err)
	}
	return rev, nil
}

// upsertRule 写一条规则，并按契约 §7.2 第 4 条返回 conflict（nil 表示不冲突）。
//
// 判据只看「两端都改过」，**与谁赢无关**：同一 id、updated_at 与 rev 都不相等、且 7 个规则
// 字段之一确实被改成了不同值。这是关键——定稿要防的是「改动被静默丢掉」，而丢掉可能是
// 服务端那边，也可能是**本次 push 的这一边**：
//
//	手机 10:05 改 repeat_mode 先 push → 服务端存 2000
//	PC   10:00 改 repeat_mode 后 push → 服务端赢 → PC 的改动被静默丢弃
//
// 只在上报「客户端赢」那一侧，上面这种 PC 用户白改的情况就完全没有提示。
// 所以两侧都要报，用 Conflict.Winner 区分方向。
//
// 写库仍走 LWW（客户端赢才写、才占 rev、才计进 accepted），conflict 只是附带告知。
func upsertRule(tx *sql.Tx, r SyncRule) (bool, *Conflict, error) {
	var serverUpdatedAt, serverRev int64
	// hasServer：服务端已有同一 id 的行。新记录不算冲突（没有「两端」）。
	var hasServer bool
	err := tx.QueryRow(`SELECT updated_at, rev FROM rule WHERE id = ?`, r.ID).Scan(&serverUpdatedAt, &serverRev)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// 新记录，直接写
	case err != nil:
		return false, nil, fmt.Errorf("查询规则 %s 失败：%w", r.ID, err)
	default:
		hasServer = true
	}

	clientWins := !hasServer || wins(r.UpdatedAt, r.Rev, serverUpdatedAt, serverRev)

	// 真冲突：两端仲裁键都不相等（不是「一端新一端旧」的简单覆盖）。
	// 注意它和胜负无关——服务端赢、客户端赢都会走到这里比对字段。
	var cf *Conflict
	if hasServer && r.UpdatedAt != serverUpdatedAt && r.Rev != serverRev {
		winner := ConflictWinnerServer
		if clientWins {
			winner = ConflictWinnerClient
		}
		cf, err = ruleConflict(tx, r, serverUpdatedAt, winner)
		if err != nil {
			return false, nil, err
		}
	}

	if !clientWins {
		// 服务端原值胜出：不写库、不占 rev、accepted 不计数。冲突（若有）照样上报——
		// 本次 push 的改动就是在这里被丢掉的，正是定稿要防的「静默丢失」。
		return false, cf, nil
	}

	rev, err := nextRev(tx)
	if err != nil {
		return false, nil, err
	}
	_, err = tx.Exec(`INSERT INTO rule
		  (id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,year_month,year_day,
		   start_date,end_date,repeat_until,rev,updated_at,deleted,dirty)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
		ON CONFLICT(id) DO UPDATE SET
		  title=excluded.title, enabled=excluded.enabled, repeat_mode=excluded.repeat_mode,
		  weekdays_mask=excluded.weekdays_mask, repeat_every=excluded.repeat_every,
		  month_day=excluded.month_day, year_month=excluded.year_month, year_day=excluded.year_day,
		  start_date=excluded.start_date, end_date=excluded.end_date, repeat_until=excluded.repeat_until,
		  rev=excluded.rev, updated_at=excluded.updated_at, deleted=excluded.deleted, dirty=0`,
		r.ID, r.Title, r.Enabled, r.RepeatMode, r.WeekdaysMask, r.RepeatEvery, r.MonthDay,
		r.YearMonth, r.YearDay, r.StartDate, nullIfEmpty(r.EndDate), nullIfEmpty(r.RepeatUntil),
		rev, r.UpdatedAt, r.Deleted)
	if err != nil {
		return false, nil, fmt.Errorf("写入规则 %s 失败：%w", r.ID, err)
	}
	return true, cf, nil
}

// ruleConflictFields 是契约 §7.2 第 4 条点名的「规则字段」。
// 其余字段（title / enabled / repeat_every / repeat_until / x / deleted）不在清单里：
// 它们要么是普通属性，要么改起来本来就没有「一边被静默丢掉」的语义。
var ruleConflictFields = []string{
	"repeat_mode", "weekdays_mask", "month_day", "year_month",
	"year_day", "start_date", "end_date",
}

// ruleConflict 把服务端行与 push 上来的行逐字段比对，返回落在 ruleConflictFields 里的差异。
// 日子类字段服务端存的是 NULL（空串写入时经 nullIfEmpty 落成 NULL），这里用 COALESCE 取回空串再比。
// 调用点已确认客户端此时确实改过（updated_at 与 rev 都不相等），所以差异字段非空即「两端都改」。
func ruleConflict(tx *sql.Tx, r SyncRule, serverUpdatedAt int64, winner string) (*Conflict, error) {
	var s SyncRule
	err := tx.QueryRow(`SELECT COALESCE(repeat_mode,0), COALESCE(weekdays_mask,0),
		  COALESCE(month_day,0), COALESCE(year_month,0), COALESCE(year_day,0),
		  start_date, COALESCE(end_date,'')
		FROM rule WHERE id = ?`, r.ID).Scan(&s.RepeatMode, &s.WeekdaysMask, &s.MonthDay,
		&s.YearMonth, &s.YearDay, &s.StartDate, &s.EndDate)
	if err != nil {
		return nil, fmt.Errorf("比对规则 %s 的冲突字段失败：%w", r.ID, err)
	}

	fields := []string{}
	for _, f := range ruleConflictFields {
		if ruleFieldChanged(f, r, s) {
			fields = append(fields, f)
		}
	}
	if len(fields) == 0 {
		return nil, nil
	}
	return &Conflict{
		ID:              r.ID,
		Table:           "rule",
		Reason:          ConflictRuleFieldsBothModified,
		Winner:          winner,
		ClientUpdatedAt: r.UpdatedAt,
		ServerUpdatedAt: serverUpdatedAt,
		Fields:          fields,
	}, nil
}

// ruleFieldChanged 按字段名取值比对，字段集合由 ruleConflictFields 定义，不在清单里的取不到值。
func ruleFieldChanged(field string, client, server SyncRule) bool {
	switch field {
	case "repeat_mode":
		return client.RepeatMode != server.RepeatMode
	case "weekdays_mask":
		return client.WeekdaysMask != server.WeekdaysMask
	case "month_day":
		return client.MonthDay != server.MonthDay
	case "year_month":
		return client.YearMonth != server.YearMonth
	case "year_day":
		return client.YearDay != server.YearDay
	case "start_date":
		return client.StartDate != server.StartDate
	case "end_date":
		return client.EndDate != server.EndDate
	}
	return false
}

func upsertTask(tx *sql.Tx, t SyncTask) (bool, *Conflict, error) {
	var serverUpdatedAt, serverRev int64
	err := tx.QueryRow(`SELECT updated_at, rev FROM task WHERE id = ?`, t.ID).Scan(&serverUpdatedAt, &serverRev)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return false, nil, fmt.Errorf("查询任务 %s 失败：%w", t.ID, err)
	case !wins(t.UpdatedAt, t.Rev, serverUpdatedAt, serverRev):
		return false, nil, nil
	}

	rev, err := nextRev(tx)
	if err != nil {
		return false, nil, err
	}
	_, err = tx.Exec(`INSERT INTO task (id,rule_id,title,enabled,sort_order,rev,updated_at,deleted,dirty)
		VALUES (?,?,?,?,?,?,?,?,0)
		ON CONFLICT(id) DO UPDATE SET
		  rule_id=excluded.rule_id, title=excluded.title, enabled=excluded.enabled,
		  sort_order=excluded.sort_order, rev=excluded.rev, updated_at=excluded.updated_at,
		  deleted=excluded.deleted, dirty=0`,
		t.ID, t.RuleID, t.Title, t.Enabled, t.SortOrder, rev, t.UpdatedAt, t.Deleted)
	if err != nil {
		return false, nil, fmt.Errorf("写入任务 %s 失败：%w", t.ID, err)
	}
	return true, nil, nil
}

func upsertMemo(tx *sql.Tx, m SyncMemo) (bool, *Conflict, error) {
	var serverUpdatedAt, serverRev int64
	err := tx.QueryRow(`SELECT updated_at, rev FROM memo WHERE id = ?`, m.ID).Scan(&serverUpdatedAt, &serverRev)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return false, nil, fmt.Errorf("查询记事 %s 失败：%w", m.ID, err)
	case !wins(m.UpdatedAt, m.Rev, serverUpdatedAt, serverRev):
		return false, nil, nil
	}

	rev, err := nextRev(tx)
	if err != nil {
		return false, nil, err
	}
	_, err = tx.Exec(`INSERT INTO memo (id,kind,title,content,start_date,end_date,category,rev,updated_at,deleted,dirty)
		VALUES (?,?,?,?,?,?,?,?,?,?,0)
		ON CONFLICT(id) DO UPDATE SET
		  kind=excluded.kind, title=excluded.title, content=excluded.content,
		  start_date=excluded.start_date, end_date=excluded.end_date, category=excluded.category,
		  rev=excluded.rev, updated_at=excluded.updated_at, deleted=excluded.deleted, dirty=0`,
		m.ID, m.Kind, m.Title, nullIfEmpty(m.Content), nullIfEmpty(m.StartDate), nullIfEmpty(m.EndDate),
		nullIfEmpty(m.Category), rev, m.UpdatedAt, m.Deleted)
	if err != nil {
		return false, nil, fmt.Errorf("写入记事 %s 失败：%w", m.ID, err)
	}
	return true, nil, nil
}

func upsertReminder(tx *sql.Tx, r SyncReminder) (bool, *Conflict, error) {
	var serverUpdatedAt, serverRev int64
	err := tx.QueryRow(`SELECT updated_at, rev FROM reminder WHERE id = ?`, r.ID).Scan(&serverUpdatedAt, &serverRev)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return false, nil, fmt.Errorf("查询提醒 %s 失败：%w", r.ID, err)
	case !wins(r.UpdatedAt, r.Rev, serverUpdatedAt, serverRev):
		return false, nil, nil
	}

	rev, err := nextRev(tx)
	if err != nil {
		return false, nil, err
	}
	_, err = tx.Exec(`INSERT INTO reminder
		  (id,owner_kind,owner_id,notify_on,alarm_on,time_of_day,notify_text,
		   offset_days,repeat_rule,snooze_min,enabled,rev,updated_at,deleted,dirty)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
		ON CONFLICT(id) DO UPDATE SET
		  owner_kind=excluded.owner_kind, owner_id=excluded.owner_id,
		  notify_on=excluded.notify_on, alarm_on=excluded.alarm_on,
		  time_of_day=excluded.time_of_day, notify_text=excluded.notify_text,
		  offset_days=excluded.offset_days, repeat_rule=excluded.repeat_rule,
		  snooze_min=excluded.snooze_min, enabled=excluded.enabled,
		  rev=excluded.rev, updated_at=excluded.updated_at,
		  deleted=excluded.deleted, dirty=0`,
		r.ID, r.OwnerKind, r.OwnerID, r.NotifyOn, r.AlarmOn, r.TimeOfDay,
		nullIfEmpty(r.NotifyText), r.OffsetDays, r.RepeatRule, r.SnoozeMin, r.Enabled,
		rev, r.UpdatedAt, r.Deleted)
	if err != nil {
		return false, nil, fmt.Errorf("写入提醒 %s 失败：%w", r.ID, err)
	}
	return true, nil, nil
}

// upsertCompletion 按契约 §7.2 用 updated_at 做 LWW，**不用** max(status)：
// 打卡可撤销，取 max(status) 会让「取消打卡」永远同步不过去。
func upsertCompletion(tx *sql.Tx, c SyncCompletion) (bool, *Conflict, error) {
	var serverUpdatedAt, serverRev int64
	err := tx.QueryRow(`SELECT updated_at, rev FROM completion WHERE task_id = ? AND period_start = ?`,
		c.TaskID, c.PeriodStart).Scan(&serverUpdatedAt, &serverRev)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return false, nil, fmt.Errorf("查询打卡 %s@%s 失败：%w", c.TaskID, c.PeriodStart, err)
	case !wins(c.UpdatedAt, c.Rev, serverUpdatedAt, serverRev):
		return false, nil, nil
	}

	rev, err := nextRev(tx)
	if err != nil {
		return false, nil, err
	}
	_, err = tx.Exec(`INSERT INTO completion (task_id,period_start,status,rev,updated_at,deleted,dirty)
		VALUES (?,?,?,?,?,?,0)
		ON CONFLICT(task_id,period_start) DO UPDATE SET
		  status=excluded.status, rev=excluded.rev, updated_at=excluded.updated_at,
		  deleted=excluded.deleted, dirty=0`,
		c.TaskID, c.PeriodStart, c.Status, rev, c.UpdatedAt, c.Deleted)
	if err != nil {
		return false, nil, fmt.Errorf("写入打卡 %s@%s 失败：%w", c.TaskID, c.PeriodStart, err)
	}
	return true, nil, nil
}

// validatePush 是写入层校验（契约 §3.4 第一层）：非法日期必须拒绝并报错，不能落库。
func validatePush(req PushRequest) error {
	for _, r := range req.Rules {
		if r.ID == "" {
			return fmt.Errorf("%w：rule 的 id 为空", ErrInvalidRecord)
		}
		if err := checkFlag("rule", r.ID, "enabled", r.Enabled); err != nil {
			return err
		}
		if err := engine.ValidateDate(r.StartDate); err != nil {
			return fmt.Errorf("%w：rule %s 的 start_date %v", ErrInvalidRecord, r.ID, err)
		}
		// end_date / repeat_until 为空表示不限，非空才校验
		for _, f := range []struct{ name, value string }{
			{"end_date", r.EndDate},
			{"repeat_until", r.RepeatUntil},
		} {
			if f.value == "" {
				continue
			}
			if err := engine.ValidateDate(f.value); err != nil {
				return fmt.Errorf("%w：rule %s 的 %s %v", ErrInvalidRecord, r.ID, f.name, err)
			}
		}
	}
	for _, t := range req.Tasks {
		if t.ID == "" || t.RuleID == "" {
			return fmt.Errorf("%w：task %q 的 id 或 rule_id 为空", ErrInvalidRecord, t.ID)
		}
		if err := checkFlag("task", t.ID, "enabled", t.Enabled); err != nil {
			return err
		}
	}
	for _, m := range req.Memos {
		if m.ID == "" {
			return fmt.Errorf("%w：memo 的 id 为空", ErrInvalidRecord)
		}
		for _, f := range []struct{ name, value string }{
			{"start_date", m.StartDate},
			{"end_date", m.EndDate},
		} {
			if f.value == "" {
				continue
			}
			if err := engine.ValidateDate(f.value); err != nil {
				return fmt.Errorf("%w：memo %s 的 %s %v", ErrInvalidRecord, m.ID, f.name, err)
			}
		}
	}
	for _, rm := range req.Reminders {
		if err := validateReminder(rm); err != nil {
			return err
		}
	}
	for _, c := range req.Completions {
		if c.TaskID == "" {
			return fmt.Errorf("%w：completion 的 task_id 为空", ErrInvalidRecord)
		}
		if err := engine.ValidateDate(c.PeriodStart); err != nil {
			return fmt.Errorf("%w：completion %s 的 period_start %v", ErrInvalidRecord, c.TaskID, err)
		}
	}
	return nil
}

// checkFlag 校验同步 JSON 里的 0/1 开关列（rule/task 的 enabled 等）。
// 契约 §7.1 定的是**整数 0/1 而不是 JSON 布尔**：三端本地库这些列都是 SQLite INTEGER，用布尔要多一层转换，
// 也正是三语言里最容易漂的一层（SyncRule.Enabled 曾经是 bool，PC/Android 发 0/1 直接 400）。
// 所以「只接受 0/1」是硬校验，不是宽容转换：2、-1、true 都拒绝，别悄悄归一成 1。
func checkFlag(kind, id, field string, v int) error {
	if v == 0 || v == 1 {
		return nil
	}
	return fmt.Errorf("%w：%s %s 的 %s=%d 只能是 0 或 1", ErrInvalidRecord, kind, id, field, v)
}

// validateReminder 是契约 §11 的写入层校验，三条硬约束照 reminder.schema.json：
//  1. owner_kind ∈ {0=规则, 1=记事, 2=倒数日}；
//  2. time_of_day 必须是 HH:mm；
//  3. notify_on / alarm_on 至少开一个——「两个都关」不是合法提醒状态（§11.1），
//     想不提醒就软删这行或 enabled=0。
//
// 墓碑（deleted=1）只过结构校验（id / owner_kind / owner_id / time_of_day / 各枚举值）：
// 墓碑是删除标记而不是「提醒状态」，§11.4 R3 的客户端可能先把两个开关清零再打删除标记，
// 按存活行的口径拒绝它会让删除同步不过去，墓碑留在对端永远消不掉。
func validateReminder(r SyncReminder) error {
	if r.ID == "" || r.OwnerID == "" {
		return fmt.Errorf("%w：reminder %q 的 id 或 owner_id 为空", ErrInvalidRecord, r.ID)
	}
	if r.OwnerKind != 0 && r.OwnerKind != 1 && r.OwnerKind != 2 {
		return fmt.Errorf("%w：reminder %s 的 owner_kind=%d 越界（只允许 0=规则 1=记事 2=倒数日）",
			ErrInvalidRecord, r.ID, r.OwnerKind)
	}
	if err := engine.ValidateTimeOfDay(r.TimeOfDay); err != nil {
		return fmt.Errorf("%w：reminder %s 的 time_of_day %v", ErrInvalidRecord, r.ID, err)
	}
	for _, f := range []struct {
		name string
		val  int
	}{{"notify_on", r.NotifyOn}, {"alarm_on", r.AlarmOn}, {"enabled", r.Enabled},
		{"repeat_rule", r.RepeatRule}, {"deleted", r.Deleted}} {
		if err := checkFlag("reminder", r.ID, f.name, f.val); err != nil {
			return err
		}
	}
	if r.Deleted == 0 && r.NotifyOn == 0 && r.AlarmOn == 0 {
		return fmt.Errorf("%w：reminder %s 的 notify_on 与 alarm_on 不能都为 0（想不提醒请软删该行或 enabled=0）",
			ErrInvalidRecord, r.ID)
	}
	if r.OffsetDays < -30 || r.OffsetDays > 30 {
		return fmt.Errorf("%w：reminder %s 的 offset_days=%d 越界（-30..30）", ErrInvalidRecord, r.ID, r.OffsetDays)
	}
	if r.SnoozeMin < 0 || r.SnoozeMin > 60 {
		return fmt.Errorf("%w：reminder %s 的 snooze_min=%d 越界（0..60）", ErrInvalidRecord, r.ID, r.SnoozeMin)
	}
	if utf8.RuneCountInString(r.NotifyText) > 60 {
		return fmt.Errorf("%w：reminder %s 的 notify_text 超过 60 字", ErrInvalidRecord, r.ID)
	}
	return nil
}

// ---- pull ----

// Pull 返回 rev > since 的全部记录（含 deleted=1 的墓碑），最多 pullPageSize 条。
//
// 分页游标语义：hasMore=true 时 maxRev 是本页最后一条的 rev（不是全局最大值），
// 客户端下次传 since=maxRev 就能既不漏也不重；hasMore=false 时 maxRev 是服务端全局 maxRev。
func (s *Store) Pull(since int64) (PullResult, error) {
	if since < 0 {
		since = 0
	}
	globalMax, err := s.maxRev()
	if err != nil {
		return PullResult{}, err
	}

	// cut 为本页上界；不截断时取 int64 上界，让四条 SELECT 只有一套 SQL。
	cut, hasMore, err := s.pageCut(since)
	if err != nil {
		return PullResult{}, err
	}
	if !hasMore {
		cut = math.MaxInt64
	}

	out := PullResult{
		Rules:       []SyncRule{},
		Tasks:       []SyncTask{},
		Memos:       []SyncMemo{},
		Reminders:   []SyncReminder{},
		Completions: []SyncCompletion{},
		HasMore:     hasMore,
		MaxRev:      globalMax,
	}
	if hasMore {
		out.MaxRev = cut
	}
	if out.Rules, err = s.pullRules(since, cut); err != nil {
		return PullResult{}, err
	}
	if out.Tasks, err = s.pullTasks(since, cut); err != nil {
		return PullResult{}, err
	}
	if out.Memos, err = s.pullMemos(since, cut); err != nil {
		return PullResult{}, err
	}
	if out.Reminders, err = s.pullReminders(since, cut); err != nil {
		return PullResult{}, err
	}
	if out.Completions, err = s.pullCompletions(since, cut); err != nil {
		return PullResult{}, err
	}
	return out, nil
}

func (s *Store) maxRev() (int64, error) {
	var rev int64
	if err := s.db.QueryRow(`SELECT rev FROM sync_counter WHERE id = 1`).Scan(&rev); err != nil {
		return 0, fmt.Errorf("读取 rev 计数器失败：%w", err)
	}
	return rev, nil
}

// pageCut 用一条 UNION 查询取「第 pullPageSize 小」与「第 pullPageSize+1 小」的 rev：
// 四张表共用一套全局序号，才能在 Go 侧不合并行的情况下判出本页上界与是否还有下一页。
func (s *Store) pageCut(since int64) (int64, bool, error) {
	rows, err := s.db.Query(`SELECT rev FROM (
		  SELECT rev FROM rule       WHERE rev > ?
		  UNION ALL SELECT rev FROM task       WHERE rev > ?
		  UNION ALL SELECT rev FROM memo       WHERE rev > ?
		  UNION ALL SELECT rev FROM reminder   WHERE rev > ?
		  UNION ALL SELECT rev FROM completion WHERE rev > ?
		) ORDER BY rev LIMIT 2 OFFSET ?`, since, since, since, since, since, pullPageSize-1)
	if err != nil {
		return 0, false, fmt.Errorf("计算分页上界失败：%w", err)
	}
	defer rows.Close()

	var revs []int64
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			return 0, false, err
		}
		revs = append(revs, v)
	}
	if err := rows.Err(); err != nil {
		return 0, false, err
	}
	if len(revs) < 2 {
		return 0, false, nil // 剩下的记录装得下一页，不截断
	}
	return revs[0], true, nil
}

func (s *Store) pullRules(since, cut int64) ([]SyncRule, error) {
	rows, err := s.db.Query(`SELECT id,title,enabled,repeat_mode,weekdays_mask,
		  COALESCE(repeat_every,0),COALESCE(month_day,0),COALESCE(year_month,0),COALESCE(year_day,0),
		  start_date,COALESCE(end_date,''),COALESCE(repeat_until,''),rev,updated_at,deleted
		FROM rule WHERE rev > ? AND rev <= ? ORDER BY rev`, since, cut)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SyncRule{}
	for rows.Next() {
		var r SyncRule
		if err := rows.Scan(&r.ID, &r.Title, &r.Enabled, &r.RepeatMode, &r.WeekdaysMask,
			&r.RepeatEvery, &r.MonthDay, &r.YearMonth, &r.YearDay,
			&r.StartDate, &r.EndDate, &r.RepeatUntil, &r.Rev, &r.UpdatedAt, &r.Deleted); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) pullTasks(since, cut int64) ([]SyncTask, error) {
	rows, err := s.db.Query(`SELECT id,rule_id,title,enabled,sort_order,rev,updated_at,deleted
		FROM task WHERE rev > ? AND rev <= ? ORDER BY rev`, since, cut)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SyncTask{}
	for rows.Next() {
		var t SyncTask
		if err := rows.Scan(&t.ID, &t.RuleID, &t.Title, &t.Enabled, &t.SortOrder, &t.Rev, &t.UpdatedAt, &t.Deleted); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) pullMemos(since, cut int64) ([]SyncMemo, error) {
	rows, err := s.db.Query(`SELECT id,kind,title,COALESCE(content,''),COALESCE(start_date,''),
		  COALESCE(end_date,''),COALESCE(category,''),rev,updated_at,deleted
		FROM memo WHERE rev > ? AND rev <= ? ORDER BY rev`, since, cut)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SyncMemo{}
	for rows.Next() {
		var m SyncMemo
		if err := rows.Scan(&m.ID, &m.Kind, &m.Title, &m.Content, &m.StartDate, &m.EndDate,
			&m.Category, &m.Rev, &m.UpdatedAt, &m.Deleted); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) pullReminders(since, cut int64) ([]SyncReminder, error) {
	rows, err := s.db.Query(`SELECT id,owner_kind,owner_id,notify_on,alarm_on,time_of_day,
		  COALESCE(notify_text,''),offset_days,repeat_rule,snooze_min,enabled,rev,updated_at,deleted
		FROM reminder WHERE rev > ? AND rev <= ? ORDER BY rev`, since, cut)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SyncReminder{}
	for rows.Next() {
		var r SyncReminder
		if err := rows.Scan(&r.ID, &r.OwnerKind, &r.OwnerID, &r.NotifyOn, &r.AlarmOn, &r.TimeOfDay,
			&r.NotifyText, &r.OffsetDays, &r.RepeatRule, &r.SnoozeMin, &r.Enabled,
			&r.Rev, &r.UpdatedAt, &r.Deleted); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) pullCompletions(since, cut int64) ([]SyncCompletion, error) {
	rows, err := s.db.Query(`SELECT task_id,period_start,status,rev,updated_at,deleted
		FROM completion WHERE rev > ? AND rev <= ? ORDER BY rev`, since, cut)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SyncCompletion{}
	for rows.Next() {
		var c SyncCompletion
		if err := rows.Scan(&c.TaskID, &c.PeriodStart, &c.Status, &c.Rev, &c.UpdatedAt, &c.Deleted); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
