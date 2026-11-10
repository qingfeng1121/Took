package store

import "testing"

// 契约 §7.2 第 4 条：7 个规则字段两端都改过时，LWW 会静默丢一边，必须放进 conflicts 上报。

// ① 两端都改 repeat_mode → 返回 1 条 conflict，字段列出 repeat_mode；数据仍按 LWW 落库。
func TestPushReportsConflictOnRuleFields(t *testing.T) {
	s := openSync(t)
	serverSide := mkRule("r1", "工作", "2026-10-01", 1000, 0)
	serverSide.RepeatMode = 0
	pushReq(t, s, PushRequest{Rules: []SyncRule{serverSide}})
	// 服务端自己又改了一次（模拟「另一端」先落库）：repeat_mode 变 2，updated_at=2000，rev=1
	otherEnd := mkRule("r1", "工作", "2026-10-01", 2000, 1)
	otherEnd.RepeatMode = 2
	pushReq(t, s, PushRequest{Rules: []SyncRule{otherEnd}})

	// 这一端离线时也把 repeat_mode 改成了 1，updated_at=3000、rev=1（与服务的 rev 不等 → 真冲突）
	client := mkRule("r1", "工作", "2026-10-01", 3000, 1)
	client.RepeatMode = 1
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{client}})

	if len(res.Conflicts) != 1 {
		t.Fatalf("两端都改 repeat_mode 应报 1 条冲突，实际 %d 条：%+v", len(res.Conflicts), res.Conflicts)
	}
	cf := res.Conflicts[0]
	if cf.ID != "r1" || cf.Table != "rule" || cf.Reason != ConflictRuleFieldsBothModified {
		t.Errorf("冲突标识不对：%+v", cf)
	}
	if cf.ClientUpdatedAt != 3000 || cf.ServerUpdatedAt != 2000 {
		t.Errorf("两端时间戳应回传 3000/2000，实际 %d/%d", cf.ClientUpdatedAt, cf.ServerUpdatedAt)
	}
	if len(cf.Fields) != 1 || cf.Fields[0] != "repeat_mode" {
		t.Errorf("冲突字段应只有 repeat_mode，实际 %v", cf.Fields)
	}

	// ④ 数据仍按 LWW 落库：客户端 updated_at 更大，赢，rev 照常递增。
	if res.Accepted.Rules != 1 {
		t.Errorf("冲突不该阻断写入，accepted 应为 1，实际 %d", res.Accepted.Rules)
	}
	got := findRule(t, s, "r1")
	if got.RepeatMode != 1 {
		t.Errorf("LWW 应写入客户端的 repeat_mode=1，实际 %d", got.RepeatMode)
	}
	if got.Rev != 3 {
		t.Errorf("冲突记录照常拿新 rev（3），实际 %d", got.Rev)
	}
}

// ② 只改 title（不在 7 个规则字段清单里）→ 不报冲突。
func TestPushNoConflictWhenOnlyTitleDiffers(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "旧标题", "2026-10-01", 1000, 0)}})

	client := mkRule("r1", "新标题", "2026-10-01", 3000, 5)
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{client}})

	if len(res.Conflicts) != 0 {
		t.Fatalf("title 不在清单里，不该报冲突，实际 %+v", res.Conflicts)
	}
	if res.Accepted.Rules != 1 {
		t.Errorf("title 仍应正常写入，accepted=%d", res.Accepted.Rules)
	}
	if got := findRule(t, s, "r1").Title; got != "新标题" {
		t.Errorf("标题应为 新标题，实际 %q", got)
	}
}

// ③ 只有一端改过（服务端没有同一 id 的行，或者仲裁键相等即简单覆盖）→ 不报。
func TestPushNoConflictWhenOnlyOneSideChanged(t *testing.T) {
	s := openSync(t)
	// 新记录：服务端没有对照行，谈不上「两端同改」。
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r_new", "新规则", "2026-10-01", 1000, 0)}})
	if len(res.Conflicts) != 0 {
		t.Fatalf("新记录不该报冲突，实际 %+v", res.Conflicts)
	}

	// 已有记录只有客户端改过：rev 与 updated_at 里至少有一个相等 → 简单覆盖，不报。
	pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "工作", "2026-10-01", 1000, 1)}})
	client := mkRule("r1", "工作", "2026-10-01", 1000, 1) // 两个仲裁键都相等：幂等重放
	client.RepeatMode = 2
	res = pushReq(t, s, PushRequest{Rules: []SyncRule{client}})
	if len(res.Conflicts) != 0 {
		t.Fatalf("两端仲裁键相等属于幂等重放，不该报冲突，实际 %+v", res.Conflicts)
	}

	// 只有 rev 不等（updated_at 相等）也属于简单覆盖，不报。
	client2 := mkRule("r1", "工作", "2026-10-01", 1000, 9)
	client2.RepeatMode = 3
	res = pushReq(t, s, PushRequest{Rules: []SyncRule{client2}})
	if len(res.Conflicts) != 0 {
		t.Fatalf("updated_at 相等、仅 rev 不等属于简单覆盖，不该报冲突，实际 %+v", res.Conflicts)
	}
}

// 7 个规则字段里出现多个差异时，fields 应逐个列出（前端要能告诉用户「哪几项冲突」）。
func TestPushConflictListsAllDifferingFields(t *testing.T) {
	s := openSync(t)
	base := mkRule("r1", "工作", "2026-10-01", 1000, 0)
	base.EndDate = "2026-12-31"
	pushReq(t, s, PushRequest{Rules: []SyncRule{base}})

	// 客户端离线时改的（本地 rev 还是 0），与服务端当前的 rev=1 不等 → 真冲突。
	client := mkRule("r1", "工作", "2026-11-01", 3000, 0)
	client.RepeatMode = 1
	client.WeekdaysMask = 1
	client.MonthDay = 5
	client.YearMonth = 6
	client.YearDay = 7
	client.EndDate = "2027-01-31"
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{client}})

	if len(res.Conflicts) != 1 {
		t.Fatalf("应报 1 条冲突，实际 %+v", res.Conflicts)
	}
	want := []string{"repeat_mode", "weekdays_mask", "month_day", "year_month", "year_day",
		"start_date", "end_date"}
	got := res.Conflicts[0].Fields
	if len(got) != len(want) {
		t.Fatalf("应列出全部 7 个字段，实际 %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("第 %d 个冲突字段应为 %s，实际 %s（全量 %v）", i, want[i], got[i], got)
		}
	}
}

// 定稿 §7.2 第 4 条要防的是「两端都改过」的静默丢失，**与谁赢无关**。
// 服务端赢时被丢掉的是本次 push 的改动——这正是最该提示用户的那一种。
func TestPushReportsConflictWhenServerWins(t *testing.T) {
	s := openSync(t)
	// 服务端已有行（另一端 10:05 改过：updated_at=2000, rev=1）
	serverSide := mkRule("r1", "工作", "2026-10-01", 2000, 1)
	serverSide.RepeatMode = 2
	pushReq(t, s, PushRequest{Rules: []SyncRule{serverSide}})

	// 本端 10:00 也改过（updated_at 更旧、rev 更小，两项都输）→ 服务端原值赢
	client := mkRule("r1", "工作", "2026-10-01", 1000, 0)
	client.RepeatMode = 1
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{client}})

	if res.Accepted.Rules != 0 {
		t.Fatalf("服务端赢时不该写库，accepted.rules 应为 0，实际 %d", res.Accepted.Rules)
	}
	if len(res.Conflicts) != 1 {
		t.Fatalf("服务端赢 + 客户端也改过 repeat_mode 应报 1 条冲突，实际 %d 条：%+v",
			len(res.Conflicts), res.Conflicts)
	}
	cf := res.Conflicts[0]
	if cf.Winner != ConflictWinnerServer {
		t.Errorf("winner 应为 server，实际 %q", cf.Winner)
	}
	if len(cf.Fields) != 1 || cf.Fields[0] != "repeat_mode" {
		t.Errorf("冲突字段应只有 repeat_mode，实际 %v", cf.Fields)
	}
	if cf.ClientUpdatedAt != 1000 || cf.ServerUpdatedAt != 2000 {
		t.Errorf("两端时间戳应回传 1000/2000，实际 %d/%d", cf.ClientUpdatedAt, cf.ServerUpdatedAt)
	}

	// 库内数据仍是服务端原值：冲突不改变 LWW 结论。
	got := findRule(t, s, "r1")
	if got.RepeatMode != 2 {
		t.Errorf("库内 repeat_mode 应保持服务端原值 2，实际 %d", got.RepeatMode)
	}
	if got.UpdatedAt != 2000 || got.Rev != 1 {
		t.Errorf("服务端行不该被改动，实际 updated_at=%d rev=%d", got.UpdatedAt, got.Rev)
	}
}

// 客户端赢时 winner 标 client，前端据此区分「我覆盖了另一端」与「我被另一端覆盖」。
func TestPushConflictWinnerIsClientWhenClientWins(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "工作", "2026-10-01", 2000, 1)}})

	client := mkRule("r1", "工作", "2026-10-01", 3000, 0)
	client.RepeatMode = 3
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{client}})

	if len(res.Conflicts) != 1 {
		t.Fatalf("应报 1 条冲突，实际 %+v", res.Conflicts)
	}
	if res.Conflicts[0].Winner != ConflictWinnerClient {
		t.Errorf("winner 应为 client，实际 %q", res.Conflicts[0].Winner)
	}
	if res.Accepted.Rules != 1 {
		t.Errorf("客户端赢应写库，accepted 应为 1，实际 %d", res.Accepted.Rules)
	}
}

// 服务端赢但客户端只改了 title（不在 7 个规则字段里）→ 不报。
func TestPushNoConflictWhenServerWinsAndOnlyTitleDiffers(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "服务端标题", "2026-10-01", 2000, 1)}})

	client := mkRule("r1", "客户端标题", "2026-10-01", 1000, 0)
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{client}})

	if len(res.Conflicts) != 0 {
		t.Fatalf("title 不在 7 字段内，不该报冲突，实际 %+v", res.Conflicts)
	}
	if res.Accepted.Rules != 0 {
		t.Errorf("服务端赢不该写库，accepted 应为 0，实际 %d", res.Accepted.Rules)
	}
	if got := findRule(t, s, "r1").Title; got != "服务端标题" {
		t.Errorf("标题应保持服务端原值，实际 %q", got)
	}
}

// 服务端赢且客户端没改过规则字段（只是延迟送达/重放同一份内容）→ 不报。
func TestPushNoConflictWhenServerWinsAndClientUnchanged(t *testing.T) {
	s := openSync(t)
	serverSide := mkRule("r1", "工作", "2026-10-01", 2000, 1)
	serverSide.RepeatMode = 2
	pushReq(t, s, PushRequest{Rules: []SyncRule{serverSide}})

	client := mkRule("r1", "工作", "2026-10-01", 1000, 0)
	client.RepeatMode = 2 // 与库里同值
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{client}})

	if len(res.Conflicts) != 0 {
		t.Fatalf("客户端没改规则字段，不该报冲突，实际 %+v", res.Conflicts)
	}
}

// conflicts 在无冲突时必须是 []，不是 null：客户端直接遍历，null 会让三端都得加判空。
func TestPushConflictsIsEmptyArrayWhenNone(t *testing.T) {
	s := openSync(t)
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "工作", "2026-10-01", 1000, 0)}})
	if res.Conflicts == nil {
		t.Fatal("conflicts 应为空切片而不是 nil")
	}
}
