import sqlite3
c = sqlite3.connect(r'D:/work/Project/Took/android/took-device.db')
for q in [
  "select name from sqlite_master where type='table' order by name",
  "select id,title,enabled,repeat_mode,weekdays_mask,repeat_every,month_day,year_month,year_day,start_date from rule order by id",
  "select id,rule_id,title,sort_order from task order by rule_id,sort_order",
  "select task_id,period_start,status from completion",
]:
    print('---', q)
    for row in c.execute(q):
        print(row)
