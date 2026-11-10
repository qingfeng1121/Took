// Package store 负责 SQLite 存取与「某月每天有哪些任务命中」的展开。
//
// 只做读：首期是只读月历，写路径留到位但不在本里程碑暴露。
package store

import (
	"database/sql"
	_ "embed"
	"fmt"
	"time"

	"took/server/internal/engine"

	_ "modernc.org/sqlite" // 纯 Go 驱动，不需要 cgo / gcc
)

//go:embed schema.sql
var schemaSQL string

type Store struct{ db *sql.DB }

// Open 打开（或创建）库文件并建表。传 ":memory:" 可用于测试。
func Open(dsn string) (*Store, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 SQLite 失败：%w", err)
	}
	// modernc 驱动对单连接更稳；并发后续再调
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("建表失败：%w", err)
	}
	// 计数器要能接上老库：建库早于 sync_counter 时，四表里可能已有 rev>0 的行，
	// 直接从 0 起会撞号，所以把计数器抬到四表现有 rev 的最大值（幂等）。
	if _, err := db.Exec(`
		INSERT OR IGNORE INTO sync_counter (id, rev) VALUES (1, 0);
		UPDATE sync_counter SET rev = max(rev,
			COALESCE((SELECT max(rev) FROM rule), 0),
			COALESCE((SELECT max(rev) FROM task), 0),
			COALESCE((SELECT max(rev) FROM memo), 0),
			COALESCE((SELECT max(rev) FROM reminder), 0),
			COALESCE((SELECT max(rev) FROM completion), 0))
		WHERE id = 1;`); err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化 rev 计数器失败：%w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Task 是任务的存储视图。
type Task struct {
	ID        string `json:"id"`
	RuleID    string `json:"rule_id"`
	Title     string `json:"title"`
	Enabled   bool   `json:"enabled"`
	SortOrder int    `json:"sort_order"`
}

// Rule 是规则的存储视图，带其下任务。
type Rule struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Enabled      bool   `json:"enabled"`
	RepeatMode   int    `json:"repeat_mode"`
	WeekdaysMask int    `json:"weekdays_mask"`
	RepeatEvery  int    `json:"repeat_every"`
	MonthDay     int    `json:"month_day"`
	YearMonth    int    `json:"year_month"`
	YearDay      int    `json:"year_day"`
	StartDate    string `json:"start_date"`
	EndDate      string `json:"end_date"`
	RepeatUntil  string `json:"repeat_until"`
	Tasks        []Task `json:"tasks"`
}

// toEngine 把存储视图转成命中判定用的规则。
func (r Rule) toEngine() engine.Rule {
	return engine.Rule{
		ID:           r.ID,
		RepeatMode:   r.RepeatMode,
		WeekdaysMask: r.WeekdaysMask,
		RepeatEvery:  r.RepeatEvery,
		MonthDay:     r.MonthDay,
		YearMonth:    r.YearMonth,
		YearDay:      r.YearDay,
		StartDate:    r.StartDate,
		EndDate:      r.EndDate,
		RepeatUntil:  r.RepeatUntil,
	}
}

// InsertRule 写入一条规则与其任务（供种子与测试使用）。
func (s *Store) InsertRule(r Rule, tasks []Task) error {
	now := time.Now().UnixMilli()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	enabled := 0
	if r.Enabled {
		enabled = 1
	}
	if _, err := tx.Exec(
		`INSERT INTO rule (id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,year_month,year_day,start_date,end_date,repeat_until,updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		r.ID, r.Title, enabled, r.RepeatMode, r.WeekdaysMask, r.RepeatEvery, r.MonthDay, r.YearMonth, r.YearDay,
		r.StartDate, nullIfEmpty(r.EndDate), nullIfEmpty(r.RepeatUntil), now,
	); err != nil {
		return fmt.Errorf("插入规则 %s 失败：%w", r.ID, err)
	}
	for i, t := range tasks {
		te := 0
		if t.Enabled {
			te = 1
		}
		if _, err := tx.Exec(
			`INSERT INTO task (id,rule_id,title,enabled,sort_order,updated_at) VALUES (?,?,?,?,?,?)`,
			t.ID, r.ID, t.Title, te, i, now,
		); err != nil {
			return fmt.Errorf("插入任务 %s 失败：%w", t.ID, err)
		}
	}
	return tx.Commit()
}

// SetDone 记录某任务在某个周期已完成。打卡键是 (task_id, period_start)。
func (s *Store) SetDone(taskID, periodStart string, done bool) error {
	status := 0
	if done {
		status = 1
	}
	_, err := s.db.Exec(
		`INSERT INTO completion (task_id,period_start,status,updated_at) VALUES (?,?,?,?)
		 ON CONFLICT(task_id,period_start) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`,
		taskID, periodStart, status, time.Now().UnixMilli(),
	)
	return err
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ListRules 返回未删除的规则与其下未删除的任务。
func (s *Store) ListRules() ([]Rule, error) {
	rows, err := s.db.Query(
		`SELECT id,title,enabled,repeat_mode,weekdays_mask,
		        COALESCE(repeat_every,0),COALESCE(month_day,0),COALESCE(year_month,0),COALESCE(year_day,0),
		        start_date,COALESCE(end_date,''),COALESCE(repeat_until,'')
		   FROM rule WHERE deleted=0 ORDER BY start_date, title`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Rule
	for rows.Next() {
		var r Rule
		var enabled int
		if err := rows.Scan(&r.ID, &r.Title, &enabled, &r.RepeatMode, &r.WeekdaysMask,
			&r.RepeatEvery, &r.MonthDay, &r.YearMonth, &r.YearDay,
			&r.StartDate, &r.EndDate, &r.RepeatUntil); err != nil {
			return nil, err
		}
		r.Enabled = enabled == 1
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	tasks, err := s.allTasks()
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Tasks = tasks[out[i].ID]
	}
	return out, nil
}

func (s *Store) allTasks() (map[string][]Task, error) {
	rows, err := s.db.Query(
		`SELECT id,rule_id,title,enabled,sort_order FROM task WHERE deleted=0 ORDER BY rule_id, sort_order`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	m := map[string][]Task{}
	for rows.Next() {
		var t Task
		var enabled int
		if err := rows.Scan(&t.ID, &t.RuleID, &t.Title, &enabled, &t.SortOrder); err != nil {
			return nil, err
		}
		t.Enabled = enabled == 1
		m[t.RuleID] = append(m[t.RuleID], t)
	}
	return m, rows.Err()
}

// DayTask 是某一天里命中的一个任务。
type DayTask struct {
	TaskID   string `json:"task_id"`
	Title    string `json:"title"`
	RuleID   string `json:"rule_id"`
	RuleName string `json:"rule_title"`
	Done     bool   `json:"done"`
}

// Day 是月历里的一格。
type Day struct {
	Date  string    `json:"date"`
	Tasks []DayTask `json:"tasks"`
}

// MonthGrid 返回 y 年 m 月每一天命中的任务，按日期升序。
// 打卡状态按 (task_id, period_start) 查，故同一周期内所有命中日共享同一状态。
func (s *Store) MonthGrid(y int, m time.Month) ([]Day, error) {
	rules, err := s.ListRules()
	if err != nil {
		return nil, err
	}
	done, err := s.doneSet()
	if err != nil {
		return nil, err
	}

	first := time.Date(y, m, 1, 0, 0, 0, 0, time.UTC)
	days := time.Date(y, m+1, 0, 0, 0, 0, 0, time.UTC).Day()
	out := make([]Day, 0, days)

	for d := 1; d <= days; d++ {
		date := engine.Key(first.AddDate(0, 0, d-1))
		day := Day{Date: date, Tasks: []DayTask{}}
		for _, r := range rules {
			if !r.Enabled {
				continue
			}
			er := r.toEngine()
			if !engine.OccursOn(er, date) {
				continue
			}
			ps, err := engine.PeriodStartOf(er, date)
			if err != nil {
				continue
			}
			for _, t := range r.Tasks {
				if !t.Enabled {
					continue
				}
				day.Tasks = append(day.Tasks, DayTask{
					TaskID: t.ID, Title: t.Title, RuleID: r.ID, RuleName: r.Title,
					Done: done[t.ID+":"+ps],
				})
			}
		}
		out = append(out, day)
	}
	return out, nil
}

func (s *Store) doneSet() (map[string]bool, error) {
	rows, err := s.db.Query(`SELECT task_id,period_start FROM completion WHERE deleted=0 AND status=1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := map[string]bool{}
	for rows.Next() {
		var t, p string
		if err := rows.Scan(&t, &p); err != nil {
			return nil, err
		}
		m[t+":"+p] = true
	}
	return m, rows.Err()
}
