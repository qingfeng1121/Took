// mock_sync_server 按 docs/本地优先契约.md §7.1 / §7.2 实现 /api/sync/push 与 /api/sync/pull。
//
// 为什么需要它：真后端 server/main.go 目前只有 /api/health、/api/rules、/api/month 三个只读接口，
// 契约 §7 的同步接口尚未实现；本轮范围限定「只改 android/」，所以用这台独立 mock 做 Android 端联调，
// 报文形状与仲裁规则逐条照 §7.1 / §7.2。真后端补完接口后，把客户端地址指过去即可。
//
// 用法：go run mock_sync_server.go -addr :8420
// 模拟器访问宿主机：adb reverse tcp:8420 tcp:8420（或把设置页地址改成 http://10.0.2.2:8420）
package main

import (
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
)

type row = map[string]any

type store struct {
	mu          sync.Mutex
	rev         int64
	completions map[string]row
}

func key(r row) string { return str(r["task_id"]) + "|" + str(r["period_start"]) }

func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func num(v any) int64 {
	if f, ok := v.(float64); ok {
		return int64(f)
	}
	return 0
}

// remoteWins = 契约 §7.2 的 LWW：updated_at 大者赢；相等比 rev；再相等保留本地（幂等）。
func remoteWins(local, remote row) bool {
	if local == nil {
		return true
	}
	lu, ru := num(local["updated_at"]), num(remote["updated_at"])
	if ru != lu {
		return ru > lu
	}
	lr, rr := num(local["rev"]), num(remote["rev"])
	if rr != lr {
		return rr > lr
	}
	return false
}

func main() {
	addr := flag.String("addr", ":8420", "监听地址")
	flag.Parse()
	s := &store{completions: map[string]row{}}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/sync/push", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		log.Printf("PUSH_BODY %s", string(raw))
		var body map[string][]row
		if err := json.Unmarshal(raw, &body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.mu.Lock()
		accepted := 0
		for _, rec := range body["completions"] {
			k := key(rec)
			if remoteWins(s.completions[k], rec) {
				stored := row{}
				for kk, vv := range rec {
					stored[kk] = vv
				}
				delete(stored, "dirty") // §7.1：服务端不回传 dirty
				s.rev++
				stored["rev"] = float64(s.rev)
				s.completions[k] = stored
				accepted++
				log.Printf("PUSH accept completion key=%s status=%v updated_at=%v -> rev=%d", k, rec["status"], rec["updated_at"], s.rev)
			} else {
				log.Printf("PUSH reject completion key=%s（服务端副本更新，保留服务端）", k)
			}
		}
		log.Printf("PUSH rules=%d tasks=%d memos=%d completions=%d accepted=%d maxRev=%d",
			len(body["rules"]), len(body["tasks"]), len(body["memos"]), len(body["completions"]), accepted, s.rev)
		maxRev := s.rev
		s.mu.Unlock()
		writeJSON(w, map[string]any{
			"accepted": map[string]int{"rules": 0, "tasks": 0, "memos": 0, "completions": accepted},
			"maxRev":   maxRev,
		})
	})

	mux.HandleFunc("/api/sync/pull", func(w http.ResponseWriter, r *http.Request) {
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		s.mu.Lock()
		rows := []row{}
		for _, rec := range s.completions {
			if num(rec["rev"]) > since {
				rows = append(rows, rec)
			}
		}
		maxRev := s.rev
		s.mu.Unlock()
		log.Printf("PULL since=%d -> completions=%d maxRev=%d", since, len(rows), maxRev)
		writeJSON(w, map[string]any{
			"rules": []row{}, "tasks": []row{}, "memos": []row{},
			"completions": rows, "maxRev": maxRev, "hasMore": false,
		})
	})

	log.Printf("mock sync server 监听 %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("写响应失败：%v", err)
	}
}
