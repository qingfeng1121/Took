package store

import (
	"errors"
	"path/filepath"
	"testing"
)

// 老库升级：已有的 took.db 里没有 reminder 表，Open 必须补建而不是报错。
// （schema.sql 每次打开都整段执行、且全是 CREATE ... IF NOT EXISTS，这条锁住该性质不被改坏。）
func TestOpenAddsReminderTableToOldDB(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "old.db")

	s, err := Open(dsn)
	if err != nil {
		t.Fatalf("首次打开失败：%v", err)
	}
	if _, err := s.db.Exec(`DROP TABLE reminder`); err != nil {
		t.Fatalf("模拟老库（删掉 reminder 表）失败：%v", err)
	}
	s.Close()

	s2, err := Open(dsn)
	if err != nil {
		t.Fatalf("老库重新打开应补建 reminder 表，实际 %v", err)
	}
	t.Cleanup(func() { s2.Close() })

	if res := pushReq(t, s2, PushRequest{Reminders: []SyncReminder{mkReminder("rm_old", 0, "r1", 1000)}}); res.Accepted.Reminders != 1 {
		t.Fatalf("补建表后应能写入提醒，实际 accepted=%d", res.Accepted.Reminders)
	}
	if got := findReminder(t, s2, "rm_old"); got == nil {
		t.Error("补建的表应能读回提醒")
	}
}

// ---- 提醒测试辅助（契约 §11）----

// mkReminder 造一条「通知 21:00」的提醒（§11.4 R1 的形状）。
func mkReminder(id string, ownerKind int, ownerID string, updatedAt int64) SyncReminder {
	return SyncReminder{
		ID: id, OwnerKind: ownerKind, OwnerID: ownerID,
		NotifyOn: 1, AlarmOn: 0, TimeOfDay: "21:00",
		Enabled: 1, UpdatedAt: updatedAt,
	}
}

func findReminder(t *testing.T, s *Store, id string) *SyncReminder {
	t.Helper()
	for _, r := range pullFrom(t, s, 0).Reminders {
		if r.ID == id {
			hit := r
			return &hit
		}
	}
	return nil
}

// §11.4 R1/R5：存一条提醒 → pull 拿得到；rev 与 rule/task/memo 共用同一个全局计数器。
func TestReminderPushThenPull(t *testing.T) {
	s := openSync(t)
	res := pushReq(t, s, PushRequest{
		Rules:     []SyncRule{mkRule("r1", "工作日常规", "2026-10-01", 1000, 0)},
		Reminders: []SyncReminder{mkReminder("rm1", 0, "r1", 1000)},
	})
	if res.Accepted != (Accepted{Rules: 1, Reminders: 1}) {
		t.Fatalf("accepted 应为 rules=1/reminders=1，实际 %+v", res.Accepted)
	}
	if res.MaxRev != 2 {
		t.Fatalf("提醒与规则必须共用同一个 rev 计数器，maxRev 应为 2，实际 %d", res.MaxRev)
	}

	got := findReminder(t, s, "rm1")
	if got == nil {
		t.Fatal("push 之后 pull 应拿到 rm1")
	}
	if got.OwnerKind != 0 || got.OwnerID != "r1" {
		t.Errorf("owner 应为 kind=0/id=r1，实际 %d/%s", got.OwnerKind, got.OwnerID)
	}
	if got.NotifyOn != 1 || got.AlarmOn != 0 {
		t.Errorf("R1「只发通知」应为 notify_on=1/alarm_on=0，实际 %d/%d", got.NotifyOn, got.AlarmOn)
	}
	if got.TimeOfDay != "21:00" {
		t.Errorf("time_of_day 应为 21:00，实际 %q", got.TimeOfDay)
	}
	if got.Rev != 2 || got.Deleted != 0 || got.Enabled != 1 {
		t.Errorf("期望 rev=2/deleted=0/enabled=1，实际 %d/%d/%d", got.Rev, got.Deleted, got.Enabled)
	}

	// 挂在记事上（owner_kind=1）与倒数日（2）同样是合法 owner
	pushReq(t, s, PushRequest{
		Memos:     []SyncMemo{{ID: "m1", Kind: 0, Title: "记事", UpdatedAt: 1000}},
		Reminders: []SyncReminder{mkReminder("rm2", 1, "m1", 1000)},
	})
	if got := findReminder(t, s, "rm2"); got == nil || got.OwnerKind != 1 || got.OwnerID != "m1" {
		t.Errorf("记事上的提醒应能落库，实际 %+v", got)
	}
}

// §11.4 R4：两个开关都关必须被写入层拒绝，且整单不落库、不消耗 rev。
func TestReminderRejectsBothSwitchesOff(t *testing.T) {
	s := openSync(t)
	off := mkReminder("rm1", 0, "r1", 1000)
	off.NotifyOn, off.AlarmOn = 0, 0

	cases := []struct {
		name string
		req  PushRequest
	}{
		{"两个开关都关", PushRequest{Reminders: []SyncReminder{off}}},
		{"enabled=0 也救不了两个都关", PushRequest{Reminders: []SyncReminder{func() SyncReminder {
			r := off
			r.Enabled = 0
			return r
		}()}}},
		{"合法提醒与非法提醒混在一单，整单拒绝", PushRequest{Reminders: []SyncReminder{
			mkReminder("rm_ok", 0, "r1", 1000), off,
		}}},
	}
	for _, c := range cases {
		if _, err := s.Push(c.req); !errors.Is(err, ErrInvalidRecord) {
			t.Errorf("%s：期望 ErrInvalidRecord，实际 %v", c.name, err)
		}
	}

	res := pullFrom(t, s, 0)
	if len(res.Reminders) != 0 || totalRecords(res) != 0 {
		t.Errorf("两开关全关的提醒不该落库，实际拉到 %d 条", len(res.Reminders))
	}
	if res.MaxRev != 0 {
		t.Errorf("被拒绝的请求不该消耗 rev，maxRev 应为 0，实际 %d", res.MaxRev)
	}

	// 只开闹钟是合法状态（§11.1 第二行），别把校验写成「必须 notify_on=1」
	alarmOnly := mkReminder("rm_alarm", 0, "r1", 1000)
	alarmOnly.NotifyOn, alarmOnly.AlarmOn = 0, 1
	if res := pushReq(t, s, PushRequest{Reminders: []SyncReminder{alarmOnly}}); res.Accepted.Reminders != 1 {
		t.Errorf("只开闹钟应被接受，实际 accepted=%d", res.Accepted.Reminders)
	}
	// 两个都开是合法状态（§11.1 第三行）
	both := mkReminder("rm_both", 0, "r1", 1000)
	both.AlarmOn = 1
	if res := pushReq(t, s, PushRequest{Reminders: []SyncReminder{both}}); res.Accepted.Reminders != 1 {
		t.Errorf("两个开关都开应被接受，实际 accepted=%d", res.Accepted.Reminders)
	}
}

// §11.2：time_of_day 必须是零填充的 HH:mm，24 小时制。
func TestReminderRejectsBadTimeOfDay(t *testing.T) {
	s := openSync(t)
	for _, bad := range []string{"", "9:00", "21:0", "2100", "24:00", "21:60", "21:00:00", "21：00", "7:5"} {
		r := mkReminder("rm_bad", 0, "r1", 1000)
		r.TimeOfDay = bad
		_, err := s.Push(PushRequest{Reminders: []SyncReminder{r}})
		if !errors.Is(err, ErrInvalidRecord) {
			t.Errorf("time_of_day=%q 应被拒绝（ErrInvalidRecord），实际 %v", bad, err)
		}
	}
	if res := pullFrom(t, s, 0); len(res.Reminders) != 0 || res.MaxRev != 0 {
		t.Errorf("被拒绝的提醒不该落库/占 rev，实际 %d 条、maxRev=%d", len(res.Reminders), res.MaxRev)
	}

	// 边界值必须放行：00:00 / 23:59
	for _, ok := range []string{"00:00", "23:59"} {
		r := mkReminder("rm_"+ok[:2], 0, "r1", 1000)
		r.TimeOfDay = ok
		if _, err := s.Push(PushRequest{Reminders: []SyncReminder{r}}); err != nil {
			t.Errorf("time_of_day=%q 应被接受，实际 %v", ok, err)
		}
	}
}

// §11：owner_kind 只能是 0（规则）/1（记事）/2（倒数日）；owner_id 不能为空。
func TestReminderRejectsBadOwner(t *testing.T) {
	s := openSync(t)
	for _, bad := range []int{-1, 3, 99} {
		r := mkReminder("rm_bad", bad, "r1", 1000)
		if _, err := s.Push(PushRequest{Reminders: []SyncReminder{r}}); !errors.Is(err, ErrInvalidRecord) {
			t.Errorf("owner_kind=%d 应被拒绝，实际 %v", bad, err)
		}
	}
	noOwner := mkReminder("rm_nobody", 0, "", 1000)
	if _, err := s.Push(PushRequest{Reminders: []SyncReminder{noOwner}}); !errors.Is(err, ErrInvalidRecord) {
		t.Errorf("owner_id 为空应被拒绝，实际 %v", err)
	}
	if res := pullFrom(t, s, 0); len(res.Reminders) != 0 || res.MaxRev != 0 {
		t.Errorf("非法 owner 的提醒不该落库，实际 %d 条、maxRev=%d", len(res.Reminders), res.MaxRev)
	}
}

// §11.4 R3/R5 + §7.3：软删的提醒墓碑照样下发，且能拿到新 rev。
func TestReminderTombstoneDelivered(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Reminders: []SyncReminder{mkReminder("rm1", 0, "r1", 1000)}}) // rev=1

	tomb := mkReminder("rm1", 0, "r1", 2000)
	tomb.Deleted = 1
	if res := pushReq(t, s, PushRequest{Reminders: []SyncReminder{tomb}}); res.Accepted.Reminders != 1 {
		t.Fatalf("墓碑应被接受，实际 accepted=%d", res.Accepted.Reminders)
	}

	full := pullFrom(t, s, 0)
	if len(full.Reminders) != 1 || full.Reminders[0].Deleted != 1 {
		t.Fatalf("墓碑也是记录，pull 应下发 deleted=1 的那行，实际 %+v", full.Reminders)
	}
	if full.Reminders[0].Rev != 2 {
		t.Errorf("墓碑应拿新 rev=2，实际 %d", full.Reminders[0].Rev)
	}
	// 从 rev=1 之后拉，只有那条墓碑（这就是「改提醒后只拿差量」的服务端口径）
	delta := pullFrom(t, s, 1)
	if len(delta.Reminders) != 1 || delta.Reminders[0].ID != "rm1" || delta.Reminders[0].Deleted != 1 {
		t.Errorf("since=1 应只拉到 rm1 的墓碑，实际 %+v", delta.Reminders)
	}
}

// 墓碑可以带「两个开关都关」：R3 的客户端常先清零再打删除标记，
// 若按存活行口径拒绝，删除就永远同步不过去。这条锁住 validateReminder 的墓碑豁免。
func TestReminderTombstoneAllowsClearedSwitches(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Reminders: []SyncReminder{mkReminder("rm1", 0, "r1", 1000)}})

	tomb := mkReminder("rm1", 0, "r1", 2000)
	tomb.NotifyOn, tomb.AlarmOn, tomb.Deleted = 0, 0, 1
	if _, err := s.Push(PushRequest{Reminders: []SyncReminder{tomb}}); err != nil {
		t.Fatalf("墓碑（开关已清零）应被接受，实际 %v", err)
	}
	if got := findReminder(t, s, "rm1"); got == nil || got.Deleted != 1 {
		t.Errorf("墓碑应落库且 deleted=1，实际 %+v", got)
	}
}

// 契约 §7.2：reminder 与 rule/task/memo 同样按 updated_at 做 LWW，过期记录不占 rev。
func TestReminderArbitratesByUpdatedAt(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Reminders: []SyncReminder{mkReminder("rm1", 0, "r1", 1000)}}) // rev=1

	// §11.4 R2：再开闹钟 → 两个都开，updated_at 更大
	upd := mkReminder("rm1", 0, "r1", 2000)
	upd.NotifyOn, upd.AlarmOn = 1, 1
	if res := pushReq(t, s, PushRequest{Reminders: []SyncReminder{upd}}); res.Accepted.Reminders != 1 {
		t.Fatalf("updated_at 更大的提醒应被接受，实际 accepted=%d", res.Accepted.Reminders)
	}
	if got := findReminder(t, s, "rm1"); got.AlarmOn != 1 || got.Rev != 2 {
		t.Errorf("期望 alarm_on=1/rev=2，实际 %d/rev=%d", got.AlarmOn, got.Rev)
	}

	// 更旧的写入必须被丢弃，且不消耗 rev
	older := mkReminder("rm1", 0, "r1", 1500)
	older.AlarmOn = 0
	res := pushReq(t, s, PushRequest{Reminders: []SyncReminder{older}})
	if res.Accepted.Reminders != 0 {
		t.Errorf("过期的提醒不该被接受，实际 accepted=%d", res.Accepted.Reminders)
	}
	if res.MaxRev != 2 {
		t.Errorf("被丢弃的记录不该消耗 rev，maxRev 应为 2，实际 %d", res.MaxRev)
	}
	if got := findReminder(t, s, "rm1"); got.AlarmOn != 1 {
		t.Errorf("服务端应保留 alarm_on=1，实际 %d", got.AlarmOn)
	}

	// 提醒参与统一分页：把页大小压到 2，提醒必须和 rule/task 一样被算进全局序号
	old := pullPageSize
	pullPageSize = 2
	t.Cleanup(func() { pullPageSize = old })
	first := pullFrom(t, s, 0)
	if totalRecords(first) > pullPageSize {
		t.Errorf("单页不应超过 pullPageSize=%d，实际 %d", pullPageSize, totalRecords(first))
	}
}
