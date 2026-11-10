package engine

import "testing"

func rule(mode int, mut func(*Rule)) Rule {
	r := Rule{ID: "r", RepeatMode: mode, StartDate: "2026-10-01"}
	if mut != nil {
		mut(&r)
	}
	return r
}

func TestOccursOn(t *testing.T) {
	cases := []struct {
		name string
		r    Rule
		date string
		want bool
	}{
		// 每周：周一~周五（mask = 0b0011111 = 31）
		{"weekly 周一命中", rule(Weekly, func(r *Rule) { r.WeekdaysMask = 31 }), "2026-10-19", true},
		{"weekly 周日不命中", rule(Weekly, func(r *Rule) { r.WeekdaysMask = 31 }), "2026-10-25", false},
		{"weekly 周六不命中", rule(Weekly, func(r *Rule) { r.WeekdaysMask = 31 }), "2026-10-24", false},

		// 每 8 天，起点 10-01
		{"every 第 0 天", rule(Every, func(r *Rule) { r.RepeatEvery = 8 }), "2026-10-01", true},
		{"every 第 8 天", rule(Every, func(r *Rule) { r.RepeatEvery = 8 }), "2026-10-09", true},
		{"every 第 9 天不命中", rule(Every, func(r *Rule) { r.RepeatEvery = 8 }), "2026-10-10", false},
		{"every 起点前不命中", rule(Every, func(r *Rule) { r.RepeatEvery = 8 }), "2026-09-30", false},

		// 每月 20 日
		{"monthly 10-20", rule(Monthly, func(r *Rule) { r.MonthDay = 20 }), "2026-10-20", true},
		{"monthly 11-20", rule(Monthly, func(r *Rule) { r.MonthDay = 20 }), "2026-11-20", true},
		{"monthly 10-21 不命中", rule(Monthly, func(r *Rule) { r.MonthDay = 20 }), "2026-10-21", false},

		// 每月 31 日：小月钳制到月末，但用户填的值不被改写
		{"monthly 31 大月 10-31", rule(Monthly, func(r *Rule) { r.MonthDay = 31 }), "2026-10-31", true},
		{"monthly 31 小月 11-30", rule(Monthly, func(r *Rule) { r.MonthDay = 31 }), "2026-11-30", true},
		{"monthly 31 小月 11-29 不命中", rule(Monthly, func(r *Rule) { r.MonthDay = 31 }), "2026-11-29", false},
		{"monthly 31 平年 2 月末", rule(Monthly, func(r *Rule) { r.MonthDay = 31 }), "2027-02-28", true},
		{"monthly 31 平年 2-27 不命中", rule(Monthly, func(r *Rule) { r.MonthDay = 31 }), "2027-02-27", false},
		{"monthly 31 闰年 2 月末", rule(Monthly, func(r *Rule) { r.MonthDay = 31 }), "2028-02-29", true},

		// 每月最后一天：起始日提前到 2026-01-01，否则 1 月/4 月会早于默认 start 而被正确排除
		{"monthly last 1-31", rule(Monthly, func(r *Rule) { r.MonthDay = MonthDayLast; r.StartDate = "2026-01-01" }), "2026-01-31", true},
		{"monthly last 4-30", rule(Monthly, func(r *Rule) { r.MonthDay = MonthDayLast; r.StartDate = "2026-01-01" }), "2026-04-30", true},
		{"monthly last 2-28 非闰年", rule(Monthly, func(r *Rule) { r.MonthDay = MonthDayLast; r.StartDate = "2027-01-01" }), "2027-02-28", true},
		{"monthly last 闰年 2-29", rule(Monthly, func(r *Rule) { r.MonthDay = MonthDayLast }), "2028-02-29", true},
		{"monthly last 平年 2-28", rule(Monthly, func(r *Rule) { r.MonthDay = MonthDayLast }), "2027-02-28", true},

		// 每年 3/15
		{"yearly 2027-03-15", rule(Yearly, func(r *Rule) { r.YearMonth = 3; r.YearDay = 15 }), "2027-03-15", true},
		{"yearly 2027-03-14 不命中", rule(Yearly, func(r *Rule) { r.YearMonth = 3; r.YearDay = 15 }), "2027-03-14", false},

		// 每年 2/29：平年落 2/28，闰年落 2/29，且不溢出到 3/1
		{"yearly 2/29 闰年", rule(Yearly, func(r *Rule) { r.YearMonth = 2; r.YearDay = 29 }), "2028-02-29", true},
		{"yearly 2/29 平年落 2/28", rule(Yearly, func(r *Rule) { r.YearMonth = 2; r.YearDay = 29 }), "2027-02-28", true},
		{"yearly 2/29 平年 3-01 不命中", rule(Yearly, func(r *Rule) { r.YearMonth = 2; r.YearDay = 29 }), "2027-03-01", false},

		// 起始日之前的日期一律不命中（刚才 monthly last 用例暴露的语义，钉住它）
		{"早于起始日不命中", rule(Monthly, func(r *Rule) { r.MonthDay = 20 }), "2026-09-20", false},

		// 不重复
		{"none 当天命中", rule(None, nil), "2026-10-01", true},
		{"none 次日不命中", rule(None, nil), "2026-10-02", false},

		// 时间范围与终止日
		{"终止日后不命中", rule(Monthly, func(r *Rule) { r.MonthDay = 20; r.RepeatUntil = "2026-11-30" }), "2026-12-20", false},
		{"终止日内命中", rule(Monthly, func(r *Rule) { r.MonthDay = 20; r.RepeatUntil = "2026-11-30" }), "2026-11-20", true},
	}

	for _, c := range cases {
		if got := OccursOn(c.r, c.date); got != c.want {
			t.Errorf("%s：OccursOn(%s) = %v，期望 %v", c.name, c.date, got, c.want)
		}
	}
}

func TestPeriodStartOf(t *testing.T) {
	cases := []struct {
		name string
		r    Rule
		date string
		want string
	}{
		// 周一开始：2026-10-19 是周一，10-25 是周日，同属一个周期
		{"weekly 周一", rule(Weekly, func(r *Rule) { r.WeekdaysMask = 31 }), "2026-10-19", "2026-10-19"},
		{"weekly 周五同周期", rule(Weekly, func(r *Rule) { r.WeekdaysMask = 31 }), "2026-10-23", "2026-10-19"},
		{"weekly 周日仍同周期", rule(Weekly, func(r *Rule) { r.WeekdaysMask = 127 }), "2026-10-25", "2026-10-19"},
		{"weekly 下周一新周期", rule(Weekly, func(r *Rule) { r.WeekdaysMask = 127 }), "2026-10-26", "2026-10-26"},

		// 每 8 天：10-01 起，10-01~10-08 同周期，10-09 新周期
		{"every 第 5 天回到起点", rule(Every, func(r *Rule) { r.RepeatEvery = 8 }), "2026-10-06", "2026-10-01"},
		{"every 第 8 天新周期", rule(Every, func(r *Rule) { r.RepeatEvery = 8 }), "2026-10-09", "2026-10-09"},

		// monthly / yearly / none：一周期一天
		{"monthly 周期即当天", rule(Monthly, func(r *Rule) { r.MonthDay = 20 }), "2026-11-20", "2026-11-20"},
		{"yearly 周期即当天", rule(Yearly, func(r *Rule) { r.YearMonth = 3; r.YearDay = 15 }), "2027-03-15", "2027-03-15"},
		{"none 周期即起始日", rule(None, nil), "2026-10-01", "2026-10-01"},
	}

	for _, c := range cases {
		got, err := PeriodStartOf(c.r, c.date)
		if err != nil {
			t.Errorf("%s：意外报错 %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s：PeriodStartOf(%s) = %s，期望 %s", c.name, c.date, got, c.want)
		}
	}
}

// ValidateDate 是契约 §3.4 的写入层口径：比 ParseDate 更严格，零填充 + 真实日期。
func TestValidateDate(t *testing.T) {
	valid := []string{"2026-10-01", "2024-02-29", "1999-12-31", "2026-01-31"}
	for _, s := range valid {
		if err := ValidateDate(s); err != nil {
			t.Errorf("合法日期 %q 被拒绝：%v", s, err)
		}
	}

	invalid := []string{
		"",            // 空
		"2026-1-5",    // 未补零
		"2026/10/01",  // 分隔符错
		"2026-10-1",   // 位数不足
		"2026-10-001", // 位数过多
		"2026-02-30",  // 不存在的日期
		"2027-02-29",  // 平年 2/29
		"2026-13-01",  // 月份越界
		"2026-00-10",  // 月份 0
		"2026-10-00",  // 日 0
		"26-10-01",    // 两位年份
		"2026-10-01 ", // 尾随空格
		"2026-1O-01",  // 字母 O 冒充 0
	}
	for _, s := range invalid {
		if err := ValidateDate(s); err == nil {
			t.Errorf("非法日期 %q 应被拒绝，却通过了", s)
		}
	}
}

func TestInvalidDateRejected(t *testing.T) {
	for _, bad := range []string{"2026-1-5", "2026/10/01", "26-10-01", ""} {
		if _, err := ParseDate(bad); err == nil {
			t.Errorf("非法日期 %q 应被拒绝，却通过了", bad)
		}
	}
}

// 契约 §11.2：time_of_day 是写入层校验的 HH:mm，口径与 reminder.schema.json 的 pattern 一致。
func TestValidateTimeOfDay(t *testing.T) {
	for _, ok := range []string{"00:00", "09:05", "13:59", "21:00", "23:59"} {
		if err := ValidateTimeOfDay(ok); err != nil {
			t.Errorf("合法时间 %q 应通过，实际 %v", ok, err)
		}
	}
	for _, bad := range []string{"", "9:05", "21:0", "2100", "24:00", "23:60", "21:00:00", "21：00", " 21:00", "21:00 ", "-1:00", "ab:cd"} {
		if err := ValidateTimeOfDay(bad); err == nil {
			t.Errorf("非法时间 %q 应被拒绝，却通过了", bad)
		}
	}
}
