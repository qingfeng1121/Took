package store

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// ---- 测试辅助 ----

func openSync(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败：%v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func mkRule(id, title, startDate string, updatedAt, rev int64) SyncRule {
	return SyncRule{
		ID: id, Title: title, Enabled: 1, RepeatMode: 0, WeekdaysMask: 127,
		StartDate: startDate, UpdatedAt: updatedAt, Rev: rev,
	}
}

func pushReq(t *testing.T, s *Store, req PushRequest) PushResult {
	t.Helper()
	res, err := s.Push(req)
	if err != nil {
		t.Fatalf("Push 失败：%v", err)
	}
	return res
}

func pullFrom(t *testing.T, s *Store, since int64) PullResult {
	t.Helper()
	res, err := s.Pull(since)
	if err != nil {
		t.Fatalf("Pull 失败：%v", err)
	}
	return res
}

func totalRecords(r PullResult) int {
	return len(r.Rules) + len(r.Tasks) + len(r.Memos) + len(r.Reminders) + len(r.Completions)
}

func findRule(t *testing.T, s *Store, id string) *SyncRule {
	t.Helper()
	for _, r := range pullFrom(t, s, 0).Rules {
		if r.ID == id {
			hit := r
			return &hit
		}
	}
	return nil
}

// 每条写入都拿到「服务端全局 maxRev + 1」，响应里的 maxRev 就是计数器当前值。
func TestPushAssignsMonotonicRev(t *testing.T) {
	s := openSync(t)
	res := pushReq(t, s, PushRequest{
		Rules: []SyncRule{mkRule("r1", "工作", "2026-10-01", 1000, 0)},
		Tasks: []SyncTask{{ID: "t1", RuleID: "r1", Title: "健身", Enabled: 1, UpdatedAt: 1000}},
		Memos: []SyncMemo{{ID: "m1", Kind: 0, Title: "记事", UpdatedAt: 1000}},
	})

	if res.Accepted != (Accepted{Rules: 1, Tasks: 1, Memos: 1}) {
		t.Fatalf("accepted 应为 1/1/1，实际 %+v", res.Accepted)
	}
	if res.MaxRev != 3 {
		t.Fatalf("三条记录应把 maxRev 推到 3，实际 %d", res.MaxRev)
	}

	pulled := pullFrom(t, s, 0)
	if got := pulled.Rules[0].Rev; got != 1 {
		t.Errorf("r1 的 rev 应为 1，实际 %d", got)
	}
	if got := pulled.Tasks[0].Rev; got != 2 {
		t.Errorf("t1 的 rev 应为 2，实际 %d", got)
	}
	if got := pulled.Memos[0].Rev; got != 3 {
		t.Errorf("m1 的 rev 应为 3，实际 %d", got)
	}
	if pulled.MaxRev != 3 || pulled.HasMore {
		t.Errorf("pull 应返回 maxRev=3/hasMore=false，实际 %d/%v", pulled.MaxRev, pulled.HasMore)
	}
}

// 契约 §7.2 第 1 条：updated_at 大者赢。
func TestPushLaterUpdatedAtWins(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "旧标题", "2026-10-01", 1000, 0)}})

	res := pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "新标题", "2026-10-01", 2000, 0)}})
	if res.Accepted.Rules != 1 {
		t.Fatalf("updated_at 更大的记录应被接受，实际 accepted=%d", res.Accepted.Rules)
	}
	if got := findRule(t, s, "r1").Title; got != "新标题" {
		t.Errorf("标题应被新值覆盖为 新标题，实际 %q", got)
	}

	// 更旧的 updated_at 必须被丢弃，且不占 rev
	res = pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "更旧标题", "2026-10-01", 1500, 0)}})
	if res.Accepted.Rules != 0 {
		t.Errorf("过期的记录不该被接受，实际 accepted=%d", res.Accepted.Rules)
	}
	if res.MaxRev != 2 {
		t.Errorf("被丢弃的记录不该消耗 rev，maxRev 应为 2，实际 %d", res.MaxRev)
	}
	if got := findRule(t, s, "r1").Title; got != "新标题" {
		t.Errorf("服务端原值应保留 新标题，实际 %q", got)
	}
}

// 契约 §7.2 第 2、3 条：updated_at 相等比 rev，再相等保留服务端原值（幂等）。
func TestPushTieBreaksOnRev(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "v1", "2026-10-01", 1000, 0)}}) // 服务端 rev=1

	// 时间戳相等、rev 更大 → 客户端赢，服务端 rev 变 2
	res := pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "v2", "2026-10-01", 1000, 999)}})
	if res.Accepted.Rules != 1 {
		t.Fatalf("rev 更大的记录应被接受，实际 accepted=%d", res.Accepted.Rules)
	}
	if got := findRule(t, s, "r1"); got.Title != "v2" || got.Rev != 2 {
		t.Errorf("期望 v2/rev=2，实际 %s/rev=%d", got.Title, got.Rev)
	}

	// 时间戳相等、rev 更小 → 服务端胜出
	res = pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "v3", "2026-10-01", 1000, 1)}})
	if res.Accepted.Rules != 0 {
		t.Errorf("rev 更小的记录不该被接受，实际 accepted=%d", res.Accepted.Rules)
	}

	// 时间戳与 rev 全相等 → 幂等，保留服务端
	res = pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "v4", "2026-10-01", 1000, 2)}})
	if res.Accepted.Rules != 0 {
		t.Errorf("全相等的记录应保持服务端原值，实际 accepted=%d", res.Accepted.Rules)
	}
	if got := findRule(t, s, "r1"); got.Title != "v2" || got.Rev != 2 {
		t.Errorf("服务端应保持 v2/rev=2，实际 %s/rev=%d", got.Title, got.Rev)
	}
}

// 契约 §7.2：completion 用 updated_at LWW，不用 max(status)——取消打卡必须同步得过去。
func TestCompletionArbitratesByUpdatedAt(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{
		Rules: []SyncRule{mkRule("r1", "工作", "2026-10-01", 1000, 0)},
		Tasks: []SyncTask{{ID: "t1", RuleID: "r1", Title: "健身", Enabled: 1, UpdatedAt: 1000}},
		Completions: []SyncCompletion{
			{TaskID: "t1", PeriodStart: "2026-10-19", Status: 1, UpdatedAt: 1000},
		},
	})

	// 取消打卡：updated_at 更大
	res := pushReq(t, s, PushRequest{Completions: []SyncCompletion{
		{TaskID: "t1", PeriodStart: "2026-10-19", Status: 0, UpdatedAt: 2000},
	}})
	if res.Accepted.Completions != 1 {
		t.Fatalf("取消打卡应被接受，实际 accepted=%d", res.Accepted.Completions)
	}
	if got := pullFrom(t, s, 0).Completions[0].Status; got != 0 {
		t.Errorf("取消打卡后 status 应为 0（max(status) 仲裁会错误地留在 1），实际 %d", got)
	}

	// 更旧的 status=1 反扑必须被丢弃
	res = pushReq(t, s, PushRequest{Completions: []SyncCompletion{
		{TaskID: "t1", PeriodStart: "2026-10-19", Status: 1, UpdatedAt: 500},
	}})
	if res.Accepted.Completions != 0 {
		t.Errorf("过期的打卡记录不该被接受，实际 accepted=%d", res.Accepted.Completions)
	}
	if got := pullFrom(t, s, 0).Completions[0].Status; got != 0 {
		t.Errorf("status 应仍为 0，实际 %d", got)
	}
}

// 契约 §7.3：软删的墓碑随 pull 下发，不得被过滤掉。
func TestPullIncludesTombstone(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Tasks: []SyncTask{
		{ID: "t1", RuleID: "r1", Title: "健身", Enabled: 1, UpdatedAt: 1000},
	}})
	res := pushReq(t, s, PushRequest{Tasks: []SyncTask{
		{ID: "t1", RuleID: "r1", Title: "健身", Enabled: 1, UpdatedAt: 2000, Deleted: 1},
	}})
	if res.Accepted.Tasks != 1 {
		t.Fatalf("墓碑应被接受，实际 accepted=%d", res.Accepted.Tasks)
	}

	full := pullFrom(t, s, 0)
	if len(full.Tasks) != 1 {
		t.Fatalf("应拉到 1 条任务（墓碑也是记录），实际 %d", len(full.Tasks))
	}
	if full.Tasks[0].Deleted != 1 {
		t.Errorf("deleted 应为 1，实际 %d", full.Tasks[0].Deleted)
	}
	if full.Tasks[0].Rev != 2 {
		t.Errorf("墓碑应拿新 rev=2，实际 %d", full.Tasks[0].Rev)
	}

	// 从 rev=1 之后拉，墓碑必须出现
	delta := pullFrom(t, s, 1)
	if len(delta.Tasks) != 1 || delta.Tasks[0].Deleted != 1 {
		t.Errorf("since=1 应只拉到那条墓碑，实际 %+v", delta.Tasks)
	}
}

// since 增量：只要 rev > since 的记录，不重复下发已经拉过的。
func TestPullSinceReturnsOnlyDelta(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "v1", "2026-10-01", 1000, 0)}})
	first := pullFrom(t, s, 0)
	if len(first.Rules) != 1 || first.MaxRev != 1 || first.HasMore {
		t.Fatalf("首次 pull 应拿到 r1（maxRev=1, hasMore=false），实际 %+v", first)
	}

	pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r2", "v1", "2026-10-01", 1000, 0)}})
	delta := pullFrom(t, s, 1)
	if len(delta.Rules) != 1 || delta.Rules[0].ID != "r2" {
		t.Fatalf("since=1 应只拿到 r2，实际 %+v", delta.Rules)
	}

	// 游标推进到 r2 之后，再改 r1 → rev 3，此时只该拿到 r1
	pushReq(t, s, PushRequest{Rules: []SyncRule{mkRule("r1", "改过的标题", "2026-10-01", 2000, 0)}})
	delta = pullFrom(t, s, 2)
	if len(delta.Rules) != 1 || delta.Rules[0].ID != "r1" || delta.Rules[0].Title != "改过的标题" {
		t.Fatalf("since=2 应只拿到被改过的 r1，实际 %+v", delta.Rules)
	}
	if delta.Rules[0].Rev != 3 {
		t.Errorf("改过的 r1 应拿新 rev=3，实际 %d", delta.Rules[0].Rev)
	}
}

// 分页：按 hasMore/maxRev 逐页拉，合起来不漏不重。
func TestPullSincePagingNoLossNoDup(t *testing.T) {
	old := pullPageSize
	pullPageSize = 3
	t.Cleanup(func() { pullPageSize = old })

	s := openSync(t)
	pushReq(t, s, PushRequest{
		Rules: []SyncRule{
			mkRule("r1", "规则一", "2026-10-01", 1000, 0),
			mkRule("r2", "规则二", "2026-10-01", 1000, 0),
			mkRule("r3", "规则三", "2026-10-01", 1000, 0),
		},
		Tasks: []SyncTask{
			{ID: "t1", RuleID: "r1", Title: "任务一", Enabled: 1, UpdatedAt: 1000},
			{ID: "t2", RuleID: "r2", Title: "任务二", Enabled: 1, UpdatedAt: 1000},
		},
		Memos: []SyncMemo{
			{ID: "m1", Kind: 0, Title: "记事一", UpdatedAt: 1000},
			{ID: "m2", Kind: 1, Title: "倒数日", UpdatedAt: 1000},
		},
	})

	seen := map[string]int{}
	since := int64(0)
	pages := 0
	for {
		res := pullFrom(t, s, since)
		pages++
		for _, r := range res.Rules {
			if r.Rev <= since {
				t.Errorf("第 %d 页的规则 %s 的 rev=%d 不大于 since=%d（重发）", pages, r.ID, r.Rev, since)
			}
			seen["rule:"+r.ID]++
		}
		for _, x := range res.Tasks {
			seen["task:"+x.ID]++
		}
		for _, m := range res.Memos {
			seen["memo:"+m.ID]++
		}
		for _, c := range res.Completions {
			seen["completion:"+c.TaskID+"@"+c.PeriodStart]++
		}
		if totalRecords(res) > pullPageSize {
			t.Errorf("单页超过 pullPageSize=%d，实际 %d", pullPageSize, totalRecords(res))
		}
		if !res.HasMore {
			if res.MaxRev != 7 {
				t.Errorf("收尾页的 maxRev 应是服务端全局 maxRev=7，实际 %d", res.MaxRev)
			}
			break
		}
		if res.MaxRev <= since {
			t.Fatalf("hasMore=true 时游标没有前进（since=%d, maxRev=%d）", since, res.MaxRev)
		}
		since = res.MaxRev
		if pages > 10 {
			t.Fatal("分页没有收敛")
		}
	}

	if pages != 3 {
		t.Errorf("7 条记录、每页 3 条应是 3+3+1 共 3 页，实际 %d 页", pages)
	}
	if len(seen) != 7 {
		t.Errorf("应恰好拉到 7 条记录，实际 %d 条：%v", len(seen), seen)
	}
	for k, v := range seen {
		if v != 1 {
			t.Errorf("%s 被下发了 %d 次（重复）", k, v)
		}
	}
}

// 契约 §3.4 写入层：非法日期必须拒绝并报错，且一条都不能落库。
func TestPushRejectsInvalidDate(t *testing.T) {
	s := openSync(t)

	badRule := mkRule("r_bad", "坏规则", "2026-10-01", 1000, 0)
	badRule.EndDate = "2026-13-01"

	cases := []struct {
		name string
		req  PushRequest
	}{
		{"rule start_date 未补零", PushRequest{Rules: []SyncRule{mkRule("r1", "x", "2026-1-5", 1, 0)}}},
		{"rule start_date 用斜杠", PushRequest{Rules: []SyncRule{mkRule("r1", "x", "2026/10/01", 1, 0)}}},
		{"rule start_date 日号越界", PushRequest{Rules: []SyncRule{mkRule("r1", "x", "2026-02-30", 1, 0)}}},
		{"rule start_date 为空", PushRequest{Rules: []SyncRule{mkRule("r1", "x", "", 1, 0)}}},
		{"rule end_date 月份越界", PushRequest{Rules: []SyncRule{badRule}}},
		{"completion period_start 越界", PushRequest{Completions: []SyncCompletion{
			{TaskID: "t1", PeriodStart: "2026-10-32", Status: 1, UpdatedAt: 1},
		}}},
		{"memo start_date 位数不足", PushRequest{Memos: []SyncMemo{
			{ID: "m1", Kind: 0, Title: "x", StartDate: "2026-10-0", UpdatedAt: 1},
		}}},
		// 合法 + 非法混在一单：整单拒绝，合法的那条也不落库
		{"混合请求整单拒绝", PushRequest{
			Rules: []SyncRule{mkRule("r_ok", "好规则", "2026-10-01", 1, 0), mkRule("r_ok2", "x", "2026-1-5", 1, 0)},
		}},
	}

	for _, c := range cases {
		if _, err := s.Push(c.req); !errors.Is(err, ErrInvalidRecord) {
			t.Errorf("%s：期望 ErrInvalidRecord，实际 %v", c.name, err)
		}
	}

	res := pullFrom(t, s, 0)
	if totalRecords(res) != 0 {
		t.Errorf("非法记录不该落库，实际拉到 %d 条", totalRecords(res))
	}
	if res.MaxRev != 0 {
		t.Errorf("被拒绝的请求不该消耗 rev，maxRev 应为 0，实际 %d", res.MaxRev)
	}
}

// 契约 §7.1（2026-10-24 定稿）：同步 JSON 里的开关列一律 0/1 **整数**，不是 JSON 布尔。
// 这条锁住曾经的断链：SyncRule.Enabled 是 bool 时，PC/Android 发的 enabled:1 在 decode 阶段直接 400。
func TestPushAcceptsClientNumericEnabled(t *testing.T) {
	s := openSync(t)

	// 照客户端真实 payload 的样子（数字 enabled）先解一遍 JSON，再 push
	body := `{"rules":[
		   {"id":"r1","title":"工作","enabled":1,"repeat_mode":0,"weekdays_mask":127,"start_date":"2026-10-01","updated_at":1000},
		   {"id":"r2","title":"已停用","enabled":0,"repeat_mode":0,"weekdays_mask":127,"start_date":"2026-10-01","updated_at":1000}],
		 "tasks":[
		   {"id":"t1","rule_id":"r1","title":"健身","enabled":1,"sort_order":0,"updated_at":1000},
		   {"id":"t2","rule_id":"r1","title":"停用的任务","enabled":0,"sort_order":1,"updated_at":1000}]}`
	var req PushRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("客户端发来的 0/1 整数 enabled 必须能解码（以前是 bool 就死在这里）：%v", err)
	}
	if res := pushReq(t, s, req); res.Accepted != (Accepted{Rules: 2, Tasks: 2}) {
		t.Fatalf("accepted 应为 rules=2/tasks=2，实际 %+v", res.Accepted)
	}

	pulled := pullFrom(t, s, 0)
	rules := map[string]int{}
	for _, r := range pulled.Rules {
		rules[r.ID] = r.Enabled
	}
	tasks := map[string]int{}
	for _, x := range pulled.Tasks {
		tasks[x.ID] = x.Enabled
	}
	if rules["r1"] != 1 || rules["r2"] != 0 {
		t.Errorf("enabled:1 与 enabled:0 都应原样落库，实际 %v", rules)
	}
	if tasks["t1"] != 1 || tasks["t2"] != 0 {
		t.Errorf("任务的 enabled 应原样落库，实际 %v", tasks)
	}
}

// pull 输出必须也是数字 0/1——用弱类型确认类型，不靠字符串猜。
func TestPullEmitsEnabledAsNumber(t *testing.T) {
	s := openSync(t)
	pushReq(t, s, PushRequest{
		Rules: []SyncRule{mkRule("r_on", "启用", "2026-10-01", 1000, 0), mkRule("r_off", "停用", "2026-10-01", 1000, 0)},
		Tasks: []SyncTask{{ID: "t_on", RuleID: "r_on", Title: "甲", Enabled: 1, UpdatedAt: 1000},
			{ID: "t_off", RuleID: "r_on", Title: "乙", Enabled: 0, UpdatedAt: 1000}},
	})
	off := mkRule("r_off", "停用", "2026-10-01", 2000, 0)
	off.Enabled = 0
	pushReq(t, s, PushRequest{Rules: []SyncRule{off}})

	raw, err := json.Marshal(pullFrom(t, s, 0))
	if err != nil {
		t.Fatalf("序列化 pull 结果失败：%v", err)
	}
	if strings.Contains(string(raw), `"enabled":true`) || strings.Contains(string(raw), `"enabled":false`) {
		t.Errorf("pull 的 enabled 必须是数字 0/1，不能是布尔：%s", raw)
	}

	var weak map[string]any
	if err := json.Unmarshal(raw, &weak); err != nil {
		t.Fatalf("反序列化 pull 结果失败：%v", err)
	}
	seen := map[float64]bool{}
	for _, key := range []string{"rules", "tasks"} {
		for _, item := range weak[key].([]any) {
			v := item.(map[string]any)["enabled"]
			n, ok := v.(float64)
			if !ok {
				t.Errorf("%s 里的 enabled 应是 JSON 数字，实际 %T(%v)", key, v, v)
				continue
			}
			seen[n] = true
		}
	}
	if !seen[1] || !seen[0] {
		t.Errorf("pull 应同时出现 1 与 0，实际 %v", seen)
	}
}

// enabled 只接受 0/1：2、-1 一律拒绝，不做宽容归一（否则三端口径又会漂）。
func TestPushRejectsNonBinaryEnabled(t *testing.T) {
	s := openSync(t)

	rule2 := mkRule("r_bad", "坏规则", "2026-10-01", 1000, 0)
	rule2.Enabled = 2
	ruleNeg := mkRule("r_bad2", "坏规则", "2026-10-01", 1000, 0)
	ruleNeg.Enabled = -1

	cases := []struct {
		name string
		req  PushRequest
	}{
		{"rule enabled=2", PushRequest{Rules: []SyncRule{rule2}}},
		{"rule enabled=-1", PushRequest{Rules: []SyncRule{ruleNeg}}},
		{"task enabled=2", PushRequest{Tasks: []SyncTask{
			{ID: "t_bad", RuleID: "r1", Title: "x", Enabled: 2, UpdatedAt: 1000}}}},
		{"reminder enabled=2", PushRequest{Reminders: []SyncReminder{func() SyncReminder {
			r := mkReminder("rm_bad", 0, "r1", 1000)
			r.Enabled = 2
			return r
		}()}}},
	}
	for _, c := range cases {
		if _, err := s.Push(c.req); !errors.Is(err, ErrInvalidRecord) {
			t.Errorf("%s：期望 ErrInvalidRecord，实际 %v", c.name, err)
		}
	}
	if res := pullFrom(t, s, 0); totalRecords(res) != 0 || res.MaxRev != 0 {
		t.Errorf("非 0/1 的开关值不该落库，实际 %d 条、maxRev=%d", totalRecords(res), res.MaxRev)
	}
}
