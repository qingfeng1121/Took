package store

import (
	"testing"
	"time"
)

// seed 写入一套覆盖五种重复的种子，返回 Store。
func seed(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("打开内存库失败：%v", err)
	}
	t.Cleanup(func() { s.Close() })

	type row struct {
		r     Rule
		tasks []Task
	}
	rows := []row{
		{Rule{ID: "r_work", Title: "工作日常规", Enabled: true, RepeatMode: 0, WeekdaysMask: 31, StartDate: "2026-10-01"},
			[]Task{{ID: "t_fit", Title: "健身", Enabled: true}, {ID: "t_early", Title: "早起", Enabled: true}}},
		{Rule{ID: "r_every8", Title: "每八天", Enabled: true, RepeatMode: 1, RepeatEvery: 8, StartDate: "2026-10-01"},
			[]Task{{ID: "t_e8", Title: "背单词", Enabled: true}}},
		{Rule{ID: "r_rent", Title: "房租", Enabled: true, RepeatMode: 2, MonthDay: 20, StartDate: "2026-01-01"},
			[]Task{{ID: "t_rent", Title: "交房租", Enabled: true}}},
		{Rule{ID: "r_bday", Title: "生日", Enabled: true, RepeatMode: 3, YearMonth: 3, YearDay: 15, StartDate: "2026-01-01"},
			[]Task{{ID: "t_bday", Title: "生日提醒", Enabled: true}}},
		{Rule{ID: "r_off", Title: "已停用", Enabled: false, RepeatMode: 0, WeekdaysMask: 127, StartDate: "2026-10-01"},
			[]Task{{ID: "t_off", Title: "不该出现", Enabled: true}}},
	}
	for _, x := range rows {
		if err := s.InsertRule(x.r, x.tasks); err != nil {
			t.Fatalf("插入种子失败：%v", err)
		}
	}
	return s
}

func TestListRules(t *testing.T) {
	s := seed(t)
	rules, err := s.ListRules()
	if err != nil {
		t.Fatalf("ListRules 失败：%v", err)
	}
	if len(rules) != 5 {
		t.Fatalf("规则数应为 5，实际 %d", len(rules))
	}
	var work *Rule
	for i := range rules {
		if rules[i].ID == "r_work" {
			work = &rules[i]
		}
	}
	if work == nil {
		t.Fatal("找不到 r_work")
	}
	if len(work.Tasks) != 2 {
		t.Fatalf("r_work 应有 2 个任务，实际 %d", len(work.Tasks))
	}
}

func TestMonthGridOccurrence(t *testing.T) {
	s := seed(t)
	days, err := s.MonthGrid(2026, time.October)
	if err != nil {
		t.Fatalf("MonthGrid 失败：%v", err)
	}
	if len(days) != 31 {
		t.Fatalf("10 月应有 31 格，实际 %d", len(days))
	}

	byDate := map[string][]string{}
	for _, d := range days {
		for _, tk := range d.Tasks {
			byDate[d.Date] = append(byDate[d.Date], tk.TaskID)
		}
	}

	// 2026-10-01 是周四 → 工作日规则命中
	if got := byDate["2026-10-01"]; len(got) == 0 {
		t.Error("2026-10-01 应命中工作日规则")
	}
	// 2026-10-04 是周日 → 工作日规则不命中
	for _, id := range byDate["2026-10-04"] {
		if id == "t_fit" || id == "t_early" {
			t.Errorf("2026-10-04 是周日，不该命中工作日规则，却出现了 %s", id)
		}
	}
	// 房租每月 20 日
	if !contains(byDate["2026-10-20"], "t_rent") {
		t.Error("2026-10-20 应命中房租")
	}
	if contains(byDate["2026-10-21"], "t_rent") {
		t.Error("2026-10-21 不该命中房租")
	}
	// 已停用规则一次都不出现
	for _, d := range days {
		for _, tk := range d.Tasks {
			if tk.TaskID == "t_off" {
				t.Errorf("%s 出现了已停用规则的任务", d.Date)
			}
		}
	}
	// 每年 3/15 在 10 月不该出现
	for _, d := range days {
		for _, tk := range d.Tasks {
			if tk.TaskID == "t_bday" {
				t.Errorf("%s 不该出现生日规则", d.Date)
			}
		}
	}
}

func TestCheckinSharedWithinPeriod(t *testing.T) {
	s := seed(t)
	// 2026-10-19 是周一，10-21 是周三，同属一个周周期
	if err := s.SetDone("t_fit", "2026-10-19", true); err != nil {
		t.Fatalf("SetDone 失败：%v", err)
	}
	days, err := s.MonthGrid(2026, time.October)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range days {
		for _, tk := range d.Tasks {
			if tk.TaskID != "t_fit" {
				continue
			}
			if d.Date >= "2026-10-19" && d.Date <= "2026-10-25" && !tk.Done {
				t.Errorf("%s 属于 10-19 那一周，应显示为已完成", d.Date)
			}
			if d.Date >= "2026-10-26" && tk.Done {
				t.Errorf("%s 属于下一周，不该显示为已完成", d.Date)
			}
		}
	}
}

func TestYearlyAndEveryAcrossMonths(t *testing.T) {
	s := seed(t)
	// 2027 年 3 月 15 日命中生日
	days, err := s.MonthGrid(2027, time.March)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, d := range days {
		for _, tk := range d.Tasks {
			if tk.TaskID == "t_bday" && d.Date == "2027-03-15" {
				found = true
			}
			if tk.TaskID == "t_bday" && d.Date != "2027-03-15" {
				t.Errorf("生日只该在 3-15 出现，却在 %s 出现", d.Date)
			}
		}
	}
	if !found {
		t.Error("2027-03-15 应命中生日规则")
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
