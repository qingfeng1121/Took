package main

import (
	"database/sql"
	"fmt"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	db, err := sql.Open("sqlite", "file:"+os.Args[1]+"?mode=ro")
	if err != nil { fmt.Println("open:", err); return }
	defer db.Close()
	show := func(label, q string) {
		fmt.Println("=== " + label + " ===")
		rows, err := db.Query(q)
		if err != nil { fmt.Println("  err:", err); return }
		defer rows.Close()
		cols, _ := rows.Columns()
		n := 0
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals { ptrs[i] = &vals[i] }
			rows.Scan(ptrs...)
			fmt.Println(" ", vals)
			n++
		}
		if n == 0 { fmt.Println("  (空)") }
	}
	show("system_alarm", "SELECT ruleId,hour,minute,label FROM system_alarm")
	show("reminder(存活)", "SELECT id,owner_id,notify_on,alarm_on,time_of_day FROM reminder WHERE deleted=0")
	show("reminder_schedule", "SELECT ruleId,occurDate,fireAt FROM reminder_schedule LIMIT 6")
}
