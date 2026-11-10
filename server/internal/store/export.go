// 全量导出（契约 §7.1）：备份用，也是「后端挂了数据还在」的保险。
//
// 导出视图与 pull 完全同构——同一批 SyncXxx 结构、同样的字段名与 0/1 口径——
// 所以导出的 JSON 可以直接喂回 POST /api/sync/push 还原，不需要中间转换层。
// 墓碑（deleted=1）一定要导出：备份要能完整还原，缺了墓碑，对端拉回去的删除就「复活」了。
package store

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// ExportResult 是 GET /api/v1/export 的响应体。
//
// 字段名刻意与 PushRequest 一致（rules/tasks/memos/reminders/completions）：
// 导出的 JSON 原样 POST 回去就是一个合法的还原请求；多出来的 maxRev / exportedAt
// 是给人和工具看的信息，push 的解码器会忽略它们。
type ExportResult struct {
	Rules       []SyncRule       `json:"rules"`
	Tasks       []SyncTask       `json:"tasks"`
	Memos       []SyncMemo       `json:"memos"`
	Reminders   []SyncReminder   `json:"reminders"`
	Completions []SyncCompletion `json:"completions"`
	MaxRev      int64            `json:"maxRev"`
	ExportedAt  string           `json:"exportedAt"` // RFC3339，UTC
}

// Export 返回五张表的全量数据（含 deleted=1 的墓碑）与当前 maxRev。
//
// 复用 pull 的 SQL：since=-1 时 `rev > -1` 命中所有行（rev 的取值从 0 起），
// cut 取 int64 上界即不分页。这样「导出」与「拉取」永远只有一套取值口径，
// 不会出现导出漏字段、拉取多字段的漂移。
func (s *Store) Export() (ExportResult, error) {
	const since int64 = -1
	const cut int64 = math.MaxInt64

	out := ExportResult{
		Rules:       []SyncRule{},
		Tasks:       []SyncTask{},
		Memos:       []SyncMemo{},
		Reminders:   []SyncReminder{},
		Completions: []SyncCompletion{},
		ExportedAt:  time.Now().UTC().Format(time.RFC3339),
	}

	var err error
	if out.Rules, err = s.pullRules(since, cut); err != nil {
		return ExportResult{}, err
	}
	if out.Tasks, err = s.pullTasks(since, cut); err != nil {
		return ExportResult{}, err
	}
	if out.Memos, err = s.pullMemos(since, cut); err != nil {
		return ExportResult{}, err
	}
	if out.Reminders, err = s.pullReminders(since, cut); err != nil {
		return ExportResult{}, err
	}
	if out.Completions, err = s.pullCompletions(since, cut); err != nil {
		return ExportResult{}, err
	}
	if out.MaxRev, err = s.maxRev(); err != nil {
		return ExportResult{}, err
	}
	return out, nil
}

// SnapshotTo 用 SQLite 的 VACUUM INTO 把当前库整份拷成一个独立文件，
// 供 /api/v1/export?format=sqlite 直接下发（比逐表导出再重组便宜得多，
// 且拿到的是同一个事务视图，不会导出到「一半旧一半新」的库）。
// 目标文件必须不存在：VACUUM INTO 不覆盖已有文件。
func (s *Store) SnapshotTo(path string) error {
	// VACUUM INTO 的文件名不能走占位符（SQLite 把它当语句的一部分解析），
	// 单引号转义后拼进语句。
	lit := "'" + strings.ReplaceAll(path, "'", "''") + "'"
	if _, err := s.db.Exec(`VACUUM INTO ` + lit); err != nil {
		return fmt.Errorf("导出 SQLite 快照失败：%w", err)
	}
	return nil
}
