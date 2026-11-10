// Package engine 实现「周期打卡」的重复规则展开。
//
// 三条不可违反的约定（对应定稿 §3.6）：
//  1. 日期一律用 'YYYY-MM-DD' 字符串，绝不用 epoch 毫秒 —— 跨时区/夏令时会整片漂移一格。
//  2. 周期由规则算出，打卡以 (task_id, period_start) 为键 —— 同一周期内所有命中日共享状态。
//  3. 月末钳制只决定「这一次落在哪天」，不改写用户填的值（填 31，下个大月仍回 31）。
package engine

import (
	"fmt"
	"time"
)

// 重复方式（与 rule.schema.json 的 repeat_mode 一一对应）
const (
	Weekly  = 0
	Every   = 1
	Monthly = 2
	Yearly  = 3
	None    = 4
)

// MonthDayLast 表示「每月最后一天」，对应 schema 里的 month_day = -1
const MonthDayLast = -1

// Rule 是参与命中判定的规则字段子集（不关心同步字段）。
type Rule struct {
	ID           string
	RepeatMode   int
	WeekdaysMask int // bit0=周一 … bit6=周日
	RepeatEvery  int
	MonthDay     int
	YearMonth    int
	YearDay      int
	StartDate    string
	EndDate      string
	RepeatUntil  string
}

// ParseDate 解析 'YYYY-MM-DD'，非法格式直接报错，不做静默兜底。
func ParseDate(s string) (time.Time, error) {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, fmt.Errorf("日期必须是 YYYY-MM-DD：%q", s)
	}
	return t, nil
}

// ValidateDate 是契约 §3.4 的**写入层**校验：必须是零填充的 YYYY-MM-DD，且必须是真实存在的日期
// （2026-02-30 也要拒绝）。新增/编辑/导入/同步落库一律先过它。
//
// 读取层（OccursOn / PeriodStartOf）仍按同一节的第二层静默兜底、不共用这份严格口径：
// 月历渲染不能因为一行脏数据整体崩掉。
func ValidateDate(s string) error {
	if len(s) != 10 || s[4] != '-' || s[7] != '-' {
		return fmt.Errorf("日期必须是 YYYY-MM-DD：%q", s)
	}
	for i := 0; i < len(s); i++ {
		if i == 4 || i == 7 {
			continue
		}
		if s[i] < '0' || s[i] > '9' {
			return fmt.Errorf("日期必须是 YYYY-MM-DD：%q", s)
		}
	}
	// time.Parse 会拒绝越界日号（2026-02-30）与越界月（2026-13-01）
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return fmt.Errorf("非法日期 %q：%w", s, err)
	}
	return nil
}

// ValidateTimeOfDay 是契约 §11.2 的**写入层**校验：必须是 24 小时制、零填充的 HH:mm。
// 口径与 reminder.schema.json 的 ^([01][0-9]|2[0-3]):[0-5][0-9]$ 一致——不认 9:05、不认 24:00、
// 不认 21:60，也不认秒或时区尾巴。
func ValidateTimeOfDay(s string) error {
	if len(s) != 5 || s[2] != ':' {
		return fmt.Errorf("时间必须是 HH:mm：%q", s)
	}
	for i := 0; i < len(s); i++ {
		if i == 2 {
			continue
		}
		if s[i] < '0' || s[i] > '9' {
			return fmt.Errorf("时间必须是 HH:mm：%q", s)
		}
	}
	if s[0] > '2' || (s[0] == '2' && s[1] > '3') {
		return fmt.Errorf("小时必须是 00..23：%q", s)
	}
	if s[3] > '5' {
		return fmt.Errorf("分钟必须是 00..59：%q", s)
	}
	return nil
}

// Key 把时间格式化成 'YYYY-MM-DD'。
func Key(t time.Time) string { return t.Format("2006-01-02") }

func daysInMonth(y int, m time.Month) int {
	return time.Date(y, m+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// MonthTargetDay 返回该月实际命中的日号。
// monthDay=-1 取当月最后一天；大于当月天数时钳制到月末，但不改写原值。
func MonthTargetDay(monthDay, y int, m time.Month) int {
	last := daysInMonth(y, m)
	if monthDay == MonthDayLast {
		return last
	}
	if monthDay > last {
		return last
	}
	return monthDay
}

// inRange 判断日期是否落在 [start, until] 内。
// until 为空表示不限；EndDate 与 RepeatUntil 任一有值都作为上界。
func inRange(r Rule, d time.Time) bool {
	start, err := ParseDate(r.StartDate)
	if err != nil {
		return false
	}
	if d.Before(start) {
		return false
	}
	upper := r.RepeatUntil
	if upper == "" {
		upper = r.EndDate
	}
	if upper == "" {
		return true
	}
	end, err := ParseDate(upper)
	if err != nil {
		return false
	}
	return !d.After(end)
}

// OccursOn 判断某天是否命中该规则。
func OccursOn(r Rule, date string) bool {
	d, err := ParseDate(date)
	if err != nil {
		return false
	}
	if !inRange(r, d) {
		return false
	}
	switch r.RepeatMode {
	case None:
		s, err := ParseDate(r.StartDate)
		return err == nil && Key(s) == date
	case Weekly:
		// Go 的 Weekday：周日=0…周六=6；本项目 bit0=周一…bit6=周日，需要换算
		bit := (int(d.Weekday()) + 6) % 7
		return r.WeekdaysMask&(1<<bit) != 0
	case Every:
		if r.RepeatEvery < 1 {
			return false
		}
		s, err := ParseDate(r.StartDate)
		if err != nil {
			return false
		}
		days := int(d.Sub(s).Hours() / 24)
		return days >= 0 && days%r.RepeatEvery == 0
	case Monthly:
		return d.Day() == MonthTargetDay(r.MonthDay, d.Year(), d.Month())
	case Yearly:
		if int(d.Month()) != r.YearMonth {
			return false
		}
		target := r.YearDay
		last := daysInMonth(d.Year(), d.Month())
		if target > last {
			target = last // 2/29 在平年落到 2/28
		}
		return d.Day() == target
	}
	return false
}

// PeriodStartOf 返回 date 所在周期的起始日 'YYYY-MM-DD'。
// 打卡键 = taskID + ":" + PeriodStartOf(...)，同一周期内所有命中日共享状态。
func PeriodStartOf(r Rule, date string) (string, error) {
	d, err := ParseDate(date)
	if err != nil {
		return "", err
	}
	switch r.RepeatMode {
	case Weekly:
		// 周一为一周之始
		bit := (int(d.Weekday()) + 6) % 7
		return Key(d.AddDate(0, 0, -bit)), nil
	case Every:
		if r.RepeatEvery < 1 {
			return "", fmt.Errorf("repeat_every 必须 >= 1，实际 %d", r.RepeatEvery)
		}
		s, err := ParseDate(r.StartDate)
		if err != nil {
			return "", err
		}
		days := int(d.Sub(s).Hours() / 24)
		if days < 0 {
			return "", fmt.Errorf("%s 早于规则起始日 %s", date, r.StartDate)
		}
		return Key(s.AddDate(0, 0, (days/r.RepeatEvery)*r.RepeatEvery)), nil
	default:
		// monthly / yearly / none：一个周期就是一天
		return Key(d), nil
	}
}
