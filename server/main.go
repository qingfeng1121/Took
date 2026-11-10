// took-server：只读查询 + 同步中介。
//
// 读者接口（/api/health、/api/rules、/api/month）仍然只读；唯一的写入口是契约 §7 的
// 同步推拉（/api/sync/push、/api/sync/pull），后端不参与渲染，只做同步中介。
// 面向用户的编辑接口仍未开放。
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"took/server/internal/auth"
	"took/server/internal/store"
)

func main() {
	dbPath := flag.String("db", "took.db", "SQLite 文件路径")
	addr := flag.String("addr", ":8420", "监听地址")
	token := flag.String("token", "", "同步/导出的 Bearer token；留空=不校验（也可用环境变量 TOOK_TOKEN）")
	flag.Parse()

	// 启动参数优先于环境变量：命令行上看到的永远是生效的那个。
	if *token == "" {
		*token = os.Getenv("TOOK_TOKEN")
	}

	s, err := store.Open(*dbPath)
	if err != nil {
		log.Fatalf("打开数据库失败：%v", err)
	}
	defer s.Close()

	if err := ensureSeed(s); err != nil {
		log.Fatalf("写入种子失败：%v", err)
	}

	mux := http.NewServeMux()

	// protect 只包会写库或吐全量数据的两条路径（同步与导出）；健康探测等只读接口保持公开，
	// 否则客户端连「后端在不在」都探测不了。token 为空时 Middleware 原样放行。
	protect := func(h http.HandlerFunc) http.HandlerFunc {
		return auth.Middleware(*token, h).ServeHTTP
	}

	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "time": time.Now().Format(time.RFC3339)})
	})

	// 规则列表（含其下任务）
	mux.HandleFunc("/api/rules", func(w http.ResponseWriter, r *http.Request) {
		rules, err := s.ListRules()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"rules": rules})
	})

	// 某月每天命中的任务：/api/month?y=2026&m=10
	mux.HandleFunc("/api/month", func(w http.ResponseWriter, r *http.Request) {
		y, _ := strconv.Atoi(r.URL.Query().Get("y"))
		m, _ := strconv.Atoi(r.URL.Query().Get("m"))
		if y < 1970 || y > 9999 || m < 1 || m > 12 {
			http.Error(w, "参数应为 y=1970..9999 & m=1..12", http.StatusBadRequest)
			return
		}
		days, err := s.MonthGrid(y, time.Month(m))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"year": y, "month": m, "days": days})
	})

	// 同步推：POST /api/sync/push（契约 §7.1）——逐条 upsert，LWW 仲裁由 store 负责
	mux.HandleFunc("/api/sync/push", protect(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "只支持 POST", http.StatusMethodNotAllowed)
			return
		}
		var req store.PushRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "请求体不是合法 JSON："+err.Error(), http.StatusBadRequest)
			return
		}
		res, err := s.Push(req)
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, store.ErrInvalidRecord) {
				status = http.StatusBadRequest // 契约 §3.4：写入层校验失败必须报错
			}
			http.Error(w, err.Error(), status)
			return
		}
		writeJSON(w, res)
	}))

	// 同步拉：GET /api/sync/pull?since=N（契约 §7.1）——rev > since 的全部记录，含墓碑
	mux.HandleFunc("/api/sync/pull", protect(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "只支持 GET", http.StatusMethodNotAllowed)
			return
		}
		var since int64
		if v := r.URL.Query().Get("since"); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 0 {
				http.Error(w, "since 必须是非负整数", http.StatusBadRequest)
				return
			}
			since = n
		}
		res, err := s.Pull(since)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, res)
	}))

	// 全量导出：GET /api/v1/export（契约 §7.1）——备份用，五张表全量（含墓碑）。
	// 响应与 push 请求体同构，导出的 JSON 原样 POST 回 /api/sync/push 即可还原。
	// ?format=sqlite 回 SQLite 文件本体（VACUUM INTO 出来的整库快照）。
	mux.HandleFunc("/api/v1/export", protect(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "只支持 GET", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Query().Get("format") == "sqlite" {
			serveSQLiteSnapshot(w, s)
			return
		}
		res, err := s.Export()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, res)
	}))

	if *token == "" {
		log.Printf("未配置 token：/api/sync/* 与 /api/v1/export 不校验（局域网免配置模式）")
	} else {
		log.Printf("已启用 Bearer 鉴权：/api/sync/* 与 /api/v1/export 需要 token")
	}
	log.Printf("took-server 监听 %s，库文件 %s", *addr, *dbPath)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

// serveSQLiteSnapshot 用 VACUUM INTO 把整库快照写进临时文件后整份下发，再删掉。
// 选整库快照而不是「逐表导出再拼 SQLite」：前者一行 SQL 就是同一个事务视图，
// 后者要在三端再维护一份 DDL，最容易漂——契约已经为这种漂移记过一次账。
func serveSQLiteSnapshot(w http.ResponseWriter, s *store.Store) {
	f, err := os.CreateTemp("", "took-export-*.db")
	if err != nil {
		http.Error(w, "创建快照文件失败："+err.Error(), http.StatusInternalServerError)
		return
	}
	path := f.Name()
	f.Close()
	os.Remove(path) // VACUUM INTO 要求目标文件不存在
	defer os.Remove(path)

	if err := s.SnapshotTo(path); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "读取快照失败："+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="took-export.db"`)
	w.Write(data)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("写响应失败：%v", err)
	}
}

// ensureSeed 只在库为空时写入演示数据，避免每次启动重复插入。
func ensureSeed(s *store.Store) error {
	rules, err := s.ListRules()
	if err != nil {
		return err
	}
	if len(rules) > 0 {
		return nil
	}

	seeds := []struct {
		r     store.Rule
		tasks []store.Task
	}{
		{store.Rule{ID: "r_work", Title: "工作日常规", Enabled: true, RepeatMode: 0, WeekdaysMask: 31, StartDate: "2026-10-01"},
			[]store.Task{{ID: "t_fit", Title: "健身", Enabled: true}, {ID: "t_early", Title: "早起", Enabled: true}}},
		{store.Rule{ID: "r_words", Title: "单词打卡", Enabled: true, RepeatMode: 1, RepeatEvery: 1, StartDate: "2026-10-01"},
			[]store.Task{{ID: "t_words", Title: "背单词", Enabled: true}}},
		{store.Rule{ID: "r_rent", Title: "房租", Enabled: true, RepeatMode: 2, MonthDay: 20, StartDate: "2026-01-01"},
			[]store.Task{{ID: "t_rent", Title: "交房租", Enabled: true}}},
		{store.Rule{ID: "r_med", Title: "年度体检", Enabled: true, RepeatMode: 3, YearMonth: 3, YearDay: 15, StartDate: "2026-01-01"},
			[]store.Task{{ID: "t_med", Title: "体检", Enabled: true}}},
	}
	for _, x := range seeds {
		if err := s.InsertRule(x.r, x.tasks); err != nil {
			return fmt.Errorf("插入 %s 失败：%w", x.r.ID, err)
		}
	}
	// 演示打卡：本周（2026-10-19 起）的健身已完成
	return s.SetDone("t_fit", "2026-10-19", true)
}
