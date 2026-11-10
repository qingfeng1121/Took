# verify/ · 验收材料与联调工具

本目录只放**验收证据与联调脚本**，不参与 APK 构建。

## 1. mock_sync_server.go

按 `docs/本地优先契约.md` §7.1 / §7.2 实现 `/api/sync/push` 与 `/api/sync/pull` 的独立 mock：

```bash
go run mock_sync_server.go -addr :8421     # 默认 :8420，会和真后端抢端口，联调时建议换端口
adb reverse tcp:8421 tcp:8421             # 模拟器 127.0.0.1:8421 → 宿主机 8421
```

行为要点：push 对每条 completion 与已有行做 LWW（updated_at → rev → 保留服务端），
收下则 `rev = 当前 maxRev + 1`，回 `{accepted:{...}, maxRev}`；pull 回 `rev > since` 的记录 + `{maxRev, hasMore}`。
每条请求都会打一行日志（`PUSH_BODY` 是完整请求体），便于核对客户端到底发了什么。

> 注意：宿主机上若已有真后端在听 8420（`took-server`），mock 再绑同端口会串流（Windows 下
> SO_REUSEADDR 允许双绑），观测到的“服务端状态”会随机来自两个进程。联调时务必换端口或用
> `netstat -ano | grep 8420` 确认监听者。

## 2. probe.mjs

`node probe.mjs 8420` 打印服务端 `/api/sync/pull?since=0` 的 maxRev 与 completion 列表，
用来和真机本地库对照（排查“谁在改数据”比读日志快）。

## 3. uiautomator dump（真机实测证据）

`uiautomator dump` 出来的单行 XML 用 `tr '>' '\n'` 拆行再 grep，文件名含义：

| 文件 | 证明的事 |
|---|---|
| `ui-r2-home.xml` / `home.txt` | 42 格网格渲染，格子描述 `YYYY-MM-DD 当天安排` |
| `panel3.txt` | 打卡前：`早起 打卡 未完成`；点任务后同面板变 `已完成` |
| `panel-1019.txt` / `panel-1022.txt` | 周三打卡后，同周周一/周四的面板也已变成 `已完成`（同周期共享） |
| `grid-after-checkin.txt` | 网格里出现 5 个 `早起 已完成` 的格子（周一~周五），未重新进页面 |
| `panel-1022-cancel.txt` / `panel-1021-cancelled.txt` | 取消打卡后，原本打卡的那天也回到 `未完成` |
| `grid-after-cancel.txt` | `早起 已完成` 格子数回到 0 |
| `settings-before.txt` / `settings-after.txt` | 设置页同步配置：地址、立即同步、上次同步、待推送、最近错误、关于 |
| `cfg.txt` | 配置页只读列出 4 条规则 + 5 个任务与重复描述 |
