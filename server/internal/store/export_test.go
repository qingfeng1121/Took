package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 契约 §7.1：全量导出要含五张表全部数据（含墓碑）与 maxRev，字段名与 sync 视图同构。
func TestExportIncludesAllTablesAndTombstones(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{
		Rules: []SyncRule{mkRule("r1", "工作", "2026-10-01", 1000, 0)},
		Tasks: []SyncTask{{ID: "t1", RuleID: "r1", Title: "健身", Enabled: 1, UpdatedAt: 1000}},
		Memos: []SyncMemo{{ID: "m1", Kind: 0, Title: "记事", UpdatedAt: 1000}},
		Reminders: []SyncReminder{{ID: "rm1", OwnerKind: 0, OwnerID: "r1", NotifyOn: 1,
			TimeOfDay: "09:00", UpdatedAt: 1000}},
		Completions: []SyncCompletion{{TaskID: "t1", PeriodStart: "2026-10-19", Status: 1, UpdatedAt: 1000}},
	})
	// 墓碑：软删的记事也要出现在备份里，否则还原后删除会「复活」（契约 §7.3）。
	pushReq(t, s, PushRequest{Memos: []SyncMemo{{ID: "m1", Kind: 0, Title: "记事",
		UpdatedAt: 2000, Deleted: 1}}})

	exp, err := s.Export()
	if err != nil {
		t.Fatalf("Export 失败：%v", err)
	}
	if len(exp.Rules) != 1 || len(exp.Tasks) != 1 || len(exp.Memos) != 1 ||
		len(exp.Reminders) != 1 || len(exp.Completions) != 1 {
		t.Fatalf("五张表应各导出 1 条，实际 %d/%d/%d/%d/%d", len(exp.Rules), len(exp.Tasks),
			len(exp.Memos), len(exp.Reminders), len(exp.Completions))
	}
	if exp.Memos[0].Deleted != 1 {
		t.Errorf("墓碑应被导出（deleted=1），实际 %d", exp.Memos[0].Deleted)
	}
	if exp.MaxRev != 6 {
		t.Errorf("maxRev 应为 6（6 次写入），实际 %d", exp.MaxRev)
	}
	if exp.ExportedAt == "" {
		t.Error("导出时间不能为空")
	}
}

// 契约 §7.1 的验收要求：导出的 JSON 原样 push 回空库能还原出同样的数据。
func TestExportRoundTripsThroughPush(t *testing.T) {
	src := openSync(t)
	pushReq(t, src, PushRequest{
		Rules: []SyncRule{
			{ID: "r1", Title: "工作", Enabled: 1, RepeatMode: 0, WeekdaysMask: 31,
				StartDate: "2026-10-01", EndDate: "2026-12-31", RepeatUntil: "2026-12-31", UpdatedAt: 1000},
			{ID: "r2", Title: "房租", Enabled: 1, RepeatMode: 2, MonthDay: 20,
				StartDate: "2026-01-01", UpdatedAt: 1000},
		},
		Tasks: []SyncTask{{ID: "t1", RuleID: "r1", Title: "健身", Enabled: 1, SortOrder: 3, UpdatedAt: 1000}},
		Memos: []SyncMemo{{ID: "m1", Kind: 1, Title: "倒数", Content: "内容", StartDate: "2026-10-01",
			EndDate: "2026-10-31", Category: "生活", UpdatedAt: 1000}},
		Reminders: []SyncReminder{{ID: "rm1", OwnerKind: 0, OwnerID: "r1", NotifyOn: 1, AlarmOn: 1,
			TimeOfDay: "09:00", NotifyText: "该打卡了", OffsetDays: -1, RepeatRule: 1,
			SnoozeMin: 5, Enabled: 1, UpdatedAt: 1000}},
		Completions: []SyncCompletion{{TaskID: "t1", PeriodStart: "2026-10-19", Status: 1, UpdatedAt: 1000}},
	})
	// 墓也要能还原：软删一条任务
	pushReq(t, src, PushRequest{Tasks: []SyncTask{{ID: "t1", RuleID: "r1", Title: "健身",
		Enabled: 1, SortOrder: 3, UpdatedAt: 2000, Deleted: 1}}})

	exp, err := src.Export()
	if err != nil {
		t.Fatalf("Export 失败：%v", err)
	}
	blob, err := json.Marshal(exp)
	if err != nil {
		t.Fatalf("导出 JSON 序列化失败：%v", err)
	}

	// 还原：把导出的 JSON 原样解码成 push 请求，喂给一个空库。
	var req PushRequest
	if err := json.Unmarshal(blob, &req); err != nil {
		t.Fatalf("导出的 JSON 不是合法的 push 请求体：%v", err)
	}
	dst := openSync(t)
	res := pushReq(t, dst, req)
	if res.Accepted.Rules != 2 || res.Accepted.Tasks != 1 || res.Accepted.Memos != 1 ||
		res.Accepted.Reminders != 1 || res.Accepted.Completions != 1 {
		t.Fatalf("还原应写入 2/1/1/1/1 条，实际 %+v", res.Accepted)
	}
	if len(res.Conflicts) != 0 {
		t.Errorf("还原到空库不该有冲突，实际 %+v", res.Conflicts)
	}

	// 逐字段比对：除 rev（服务端重新分配）以外，两边必须完全一致。
	got, err := dst.Export()
	if err != nil {
		t.Fatalf("还原后 Export 失败：%v", err)
	}
	stripRev := func(e ExportResult) ExportResult {
		e.MaxRev, e.ExportedAt = 0, ""
		for i := range e.Rules {
			e.Rules[i].Rev = 0
		}
		for i := range e.Tasks {
			e.Tasks[i].Rev = 0
		}
		for i := range e.Memos {
			e.Memos[i].Rev = 0
		}
		for i := range e.Reminders {
			e.Reminders[i].Rev = 0
		}
		for i := range e.Completions {
			e.Completions[i].Rev = 0
		}
		return e
	}
	wantJSON, _ := json.Marshal(stripRev(exp))
	gotJSON, _ := json.Marshal(stripRev(got))
	if string(wantJSON) != string(gotJSON) {
		t.Errorf("还原后的数据与导出不一致：导出 %s / 还原 %s", wantJSON, gotJSON)
	}
}

// ?format=sqlite 的落点：VACUUM INTO 出来的快照必须是一个能独立打开的完整库。
func TestSnapshotToProducesOpenableCopy(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{
		Rules: []SyncRule{mkRule("r1", "工作", "2026-10-01", 1000, 0)},
		Tasks: []SyncTask{{ID: "t1", RuleID: "r1", Title: "健身", Enabled: 1, UpdatedAt: 1000}},
	})

	path := filepath.Join(t.TempDir(), "snap.db")
	if err := s.SnapshotTo(path); err != nil {
		t.Fatalf("SnapshotTo 失败：%v", err)
	}
	if fi, err := os.Stat(path); err != nil || fi.Size() == 0 {
		t.Fatalf("快照文件应存在且非空：%v", err)
	}

	// 用同一个 Open 打开快照，数据应在（保证「后端挂了数据还在」是真的可还原）。
	copyStore, err := Open(path)
	if err != nil {
		t.Fatalf("打开快照库失败：%v", err)
	}
	defer copyStore.Close()
	rules, err := copyStore.ListRules()
	if err != nil {
		t.Fatalf("读取快照库失败：%v", err)
	}
	if len(rules) != 1 || rules[0].ID != "r1" || len(rules[0].Tasks) != 1 {
		t.Fatalf("快照库应含 r1 及其 1 个任务，实际 %+v", rules)
	}
}
