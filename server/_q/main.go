package main

import (
	"database/sql"
	"fmt"
	"os"
	_ "modernc.org/sqlite"
)

func main() {
	db, err := sql.Open("sqlite", "file:"+os.Args[1])
	if err != nil { fmt.Println("open:", err); return }
	defer db.Close()

	// 保留的种子 id
	keepRules := "'r_work','r_words','r_rent','r_med'"
	keepTasks := "'t_fit','t_early','t_words','t_rent','t_med'"

	exec := func(label, q string) {
		res, err := db.Exec(q)
		if err != nil { fmt.Println("  ", label, "err:", err); return }
		n, _ := res.RowsAffected()
		fmt.Printf("  %s → 影响 %d 行\n", label, n)
	}

	fmt.Println("清理前：")
	var n int
	db.QueryRow("SELECT COUNT(*) FROM rule").Scan(&n); fmt.Println("  rule:", n)
	db.QueryRow("SELECT COUNT(*) FROM task").Scan(&n); fmt.Println("  task:", n)
	db.QueryRow("SELECT COUNT(*) FROM completion").Scan(&n); fmt.Println("  completion:", n)
	db.QueryRow("SELECT COUNT(*) FROM memo").Scan(&n); fmt.Println("  memo:", n)

	fmt.Println("\n清理：")
	exec("删测试 completion", "DELETE FROM completion WHERE task_id NOT IN ("+keepTasks+")")
	exec("删测试 task", "DELETE FROM task WHERE id NOT IN ("+keepTasks+")")
	exec("删测试 rule", "DELETE FROM rule WHERE id NOT IN ("+keepRules+")")
	exec("删测试 memo", "DELETE FROM memo WHERE id NOT LIKE 'm_%' OR id IN ('m_b1','m_b2','m_b3')")
	// 只留种子打卡（t_fit/t_early 的 2026-10-19）
	exec("重置 completion 只留种子", "DELETE FROM completion WHERE NOT (task_id IN ('t_fit','t_early') AND period_start='2026-10-19')")

	fmt.Println("\n清理后：")
	db.QueryRow("SELECT COUNT(*) FROM rule").Scan(&n); fmt.Println("  rule:", n)
	db.QueryRow("SELECT COUNT(*) FROM task").Scan(&n); fmt.Println("  task:", n)
	db.QueryRow("SELECT COUNT(*) FROM completion").Scan(&n); fmt.Println("  completion:", n)
	db.QueryRow("SELECT COUNT(*) FROM memo").Scan(&n); fmt.Println("  memo:", n)
	rows, _ := db.Query("SELECT task_id, period_start, status FROM completion")
	defer rows.Close()
	fmt.Println("  打卡明细:")
	for rows.Next() { var t, p string; var s int; rows.Scan(&t,&p,&s); fmt.Printf("    %s %s status=%d\n", t, p, s) }
}
