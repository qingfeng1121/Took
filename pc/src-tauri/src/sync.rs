//! 同步客户端（契约 §7）：先 push 本地 dirty=1，再 pull since=lastPulledRev 并仲裁落库。
//!
//! 两条实现决定：
//!  1. HTTP/1.1 手写在 std::net::TcpStream 上，只支持 http://。局域网自部署（契约 §7.5 不做端到端
//!     加密、不做公网），为此引一个 reqwest/ureq 会拖进整套 TLS 依赖；本机没有对应 crate 缓存，
//!     离线也装不上，所以这里不引新依赖。
//!  2. 失败一律不回滚本地数据（契约 §7.4）：dirty 保留，错误写进 local_state，下次重试。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde::Serialize;

use crate::db::{self, Db};

const TIMEOUT: Duration = Duration::from_secs(6);
/// pull 分页上限：hasMore 为真时继续拉，但不允许无限循环
const MAX_PAGES: usize = 50;
/// 最近一次错误只留前这么多字符，避免设置页撑爆
const MAX_ERR: usize = 300;

/// sync_now 的返回（契约 §7.1 + 任务约定：pushed / pulled / ok / error）
#[derive(Clone, Debug, Serialize)]
pub struct SyncResult {
    pub pushed: i64,
    pub pulled: i64,
    pub ok: bool,
    pub error: String,
}

/// 设置页要展示的同步状态（字段名与前端 app.js 一致，均为 snake_case）
#[derive(Clone, Debug, Serialize)]
pub struct SyncStatus {
    pub url: String,
    pub last_sync_at: i64,
    pub dirty: i64,
    pub last_error: String,
    pub last_pulled_rev: i64,
    /// 已存的 Bearer token（**回给前端做回显**，不回显用户就不知道自己配没配）。
    /// 局域网自部署、库文件在用户自己机器上，与 sync_url 同级可见。
    pub token: String,
}

pub fn status(db: &Db) -> SyncStatus {
    SyncStatus {
        url: db.sync_url(),
        last_sync_at: db.last_sync_at(),
        dirty: db.dirty_count().unwrap_or(0),
        last_error: db.last_error(),
        last_pulled_rev: db.last_pulled_rev(),
        token: db.sync_token(),
    }
}

/// 改同步地址（设置页用），返回改完后的状态
pub fn set_url(db: &Db, url: &str) -> Result<SyncStatus, String> {
    db.set_sync_url(url)?;
    Ok(status(db))
}

/// 改同步令牌（设置页用）；传空串即清除，返回改完后的状态
pub fn set_token(db: &Db, token: &str) -> Result<SyncStatus, String> {
    db.set_sync_token(token)?;
    Ok(status(db))
}

/// 真发一次 GET /api/health 的探测结果（设置页「测试连接」）。
/// 全部字段都是这次请求真跑出来的：ok / status / elapsed_ms / body / error。
#[derive(Clone, Debug, Serialize)]
pub struct HealthProbe {
    pub url: String,
    pub ok: bool,
    pub status: u16,
    pub elapsed_ms: i64,
    pub body: String,
    pub error: String,
}

/// 「测试连接」：对**当前已保存的地址与令牌**真发一条 GET /api/health。
///
/// 为什么不复用 http_json：它把非 2xx 直接折成 Err、丢掉状态码，
/// 而这里要把「HTTP 200 但 body 不是 ok」与「连不上」「401」分开呈现。
/// 请求路径与头（含 Authorization: Bearer）与真实同步完全一致，不另起一套。
pub fn health_probe(db: &Db) -> HealthProbe {
    let base = db.sync_url();
    let token = db.sync_token();
    let started = std::time::Instant::now();
    let mut out = HealthProbe {
        url: base.clone(),
        ok: false,
        status: 0,
        elapsed_ms: 0,
        body: String::new(),
        error: String::new(),
    };
    match raw_get(&base, "/api/health", &token) {
        Ok((code, body)) => {
            out.status = code;
            out.body = body.chars().take(300).collect();
            out.ok = (200..300).contains(&code);
            if !out.ok {
                out.error = format!("HTTP {code}");
            }
        }
        Err(e) => out.error = e,
    }
    out.elapsed_ms = started.elapsed().as_millis() as i64;
    out
}

/// 导出的原样返回：状态码 + body。前端按状态码决定「下载」还是「显示后端错误」。
#[derive(Clone, Debug, Serialize)]
pub struct ExportPayload {
    pub status: u16,
    pub body: String,
}

/// 取全量导出 JSON（GET /api/v1/export，契约 §7.1）。前端拿它直接落成 .json 文件。
/// 返回 (HTTP 状态码, body)；非 2xx 也把 body 原样带回，让用户看得见后端说了什么。
pub fn export_json(db: &Db) -> Result<(u16, String), String> {
    raw_get(&db.sync_url(), "/api/v1/export", &db.sync_token())
}

/// 不做状态码收敛的裸 GET：把 (code, body) 原样交回调用方。
fn raw_get(base: &str, path_query: &str, token: &str) -> Result<(u16, String), String> {
    let (host, port) = parse_base(base)?;
    let addr = format!("{host}:{port}");
    let mut stream =
        TcpStream::connect(addr.as_str()).map_err(|e| format!("连不上 {addr}：{e}"))?;
    let _ = stream.set_read_timeout(Some(TIMEOUT));
    let _ = stream.set_write_timeout(Some(TIMEOUT));

    let mut req = format!(
        "GET {path_query} HTTP/1.1\r\nHost: {addr}\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    let tok = token.trim();
    if !tok.is_empty() {
        req.push_str(&format!("Authorization: Bearer {tok}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| format!("发送请求失败：{e}"))?;
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Write);

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| format!("读取响应失败：{e}"))?;
    let (code, headers, payload) = split_response(&raw)?;
    let bytes = if headers.contains("transfer-encoding: chunked") {
        decode_chunked(&payload)?
    } else {
        payload
    };
    Ok((code, String::from_utf8_lossy(&bytes).to_string()))
}

/// 主入口：无论成败都返回结构化的结果，绝不 panic、绝不抛错给前端（失败要静默）。
pub fn sync_now(db: &Db) -> SyncResult {
    let url = db.sync_url();
    let mut res = run_once(db);
    res.ok = res.error.is_empty();
    if res.ok {
        let _ = db.record_sync_ok(db::now_ms());
    } else {
        let short: String = res.error.chars().take(MAX_ERR).collect();
        let _ = db.record_sync_err(&short);
    }
    // 一行诊断：同步失败要静默，但终端里得能看见到底打了哪个地址
    println!(
        "[took] sync_now {url} -> ok={} pushed={} pulled={} error={}",
        res.ok, res.pushed, res.pulled, res.error
    );
    res
}

fn run_once(db: &Db) -> SyncResult {
    let mut res = SyncResult { pushed: 0, pulled: 0, ok: false, error: String::new() };
    let url = db.sync_url();
    let mut errors: Vec<String> = Vec::new();

    // ---- 1) push：只推 dirty=1，成功后本地清 dirty ----
    match db.collect_dirty() {
        Ok(body) if !body.is_empty() => match serde_json::to_string(&body) {
            Ok(payload) => match http_json_auth(&url, "POST", "/api/sync/push", Some(&payload), &db.sync_token()) {
                Ok(text) => match serde_json::from_str::<db::PushResp>(&text) {
                    Ok(resp) => {
                        if let Err(e) = db.mark_pushed(&body) {
                            errors.push(format!("清 dirty 失败：{e}"));
                        }
                        res.pushed = resp.accepted.total();
                        if res.pushed == 0 {
                            // 服务端按 §7.2 全部判输（它那边更新），本地也算推完了
                            res.pushed = body.len() as i64;
                        }
                    }
                    Err(e) => errors.push(format!("push 响应解析失败：{e}")),
                },
                Err(e) => errors.push(format!("push 失败：{e}")),
            },
            Err(e) => errors.push(format!("序列化失败：{e}")),
        },
        Ok(_) => {}
        Err(e) => errors.push(format!("读取待推送记录失败：{e}")),
    }

    // ---- 2) pull since=lastPulledRev，逐页应用 ----
    let mut since = db.last_pulled_rev();
    for _ in 0..MAX_PAGES {
        let path = format!("/api/sync/pull?since={since}");
        let text = match http_json_auth(&url, "GET", &path, None, &db.sync_token()) {
            Ok(t) => t,
            Err(e) => {
                errors.push(format!("pull 失败：{e}"));
                break;
            }
        };
        let resp: db::PullResp = match serde_json::from_str(&text) {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("pull 响应解析失败：{e}"));
                break;
            }
        };
        match db.apply_pull(&resp) {
            Ok(n) => res.pulled += n as i64,
            Err(e) => {
                errors.push(format!("落库失败：{e}"));
                break;
            }
        }
        // 游标只前进不回退：maxRev 比 since 小时保持原值
        if resp.max_rev > since {
            since = resp.max_rev;
        }
        if let Err(e) = db.set_last_pulled_rev(since) {
            errors.push(format!("写游标失败：{e}"));
            break;
        }
        if !resp.has_more {
            break;
        }
    }

    if !errors.is_empty() {
        res.error = errors.join(" / ");
    }
    res
}

/* ============================ HTTP/1.1 最小客户端 ============================ */

/// 把 http://host:port[/] 拆成 (host, port)。https 明确拒绝（契约 §7.5）。
fn parse_base(base: &str) -> Result<(String, u16), String> {
    let b = base.trim().trim_end_matches('/');
    let rest = if let Some(r) = b.strip_prefix("http://") {
        r
    } else if b.starts_with("https://") {
        return Err("暂不支持 https（局域网自部署只用 http）".to_string());
    } else {
        return Err(format!("同步地址必须以 http:// 开头：{base}"));
    };
    if rest.is_empty() || rest.contains('/') {
        return Err(format!("同步地址非法：{base}"));
    }
    match rest.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => Ok((
            host.to_string(),
            port.parse::<u16>().map_err(|_| format!("端口非法：{base}"))?,
        )),
        Some(_) => Err(format!("同步地址非法：{base}")),
        None => Ok((rest.to_string(), 80)),
    }
}

/// 无鉴权的 GET/POST。同步走 http_json_auth，这里保留原签名给测试与本地 mock 用。
#[allow(dead_code)]
fn http_json(base: &str, method: &str, path_query: &str, body: Option<&str>) -> Result<String, String> {
    http_json_auth(base, method, path_query, body, "")
}

/// 带鉴权的版本：token 非空就加 `Authorization: Bearer <token>`（契约 §7.1）。
/// 原 `http_json` 保持四参签名不变，测试与既有调用点零改动。
fn http_json_auth(
    base: &str,
    method: &str,
    path_query: &str,
    body: Option<&str>,
    token: &str,
) -> Result<String, String> {
    let (host, port) = parse_base(base)?;
    let addr = format!("{host}:{port}");
    let mut stream =
        TcpStream::connect(addr.as_str()).map_err(|e| format!("连不上 {addr}：{e}"))?;
    let _ = stream.set_read_timeout(Some(TIMEOUT));
    let _ = stream.set_write_timeout(Some(TIMEOUT));

    let mut req = format!(
        "{method} {path_query} HTTP/1.1\r\nHost: {addr}\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    let tok = token.trim();
    if !tok.is_empty() {
        req.push_str(&format!("Authorization: Bearer {tok}\r\n"));
    }
    if let Some(b) = body {
        req.push_str("Content-Type: application/json; charset=utf-8\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", b.as_bytes().len()));
    }
    req.push_str("\r\n");
    if let Some(b) = body {
        req.push_str(b);
    }
    stream.write_all(req.as_bytes()).map_err(|e| format!("发送请求失败：{e}"))?;
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Write);

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| format!("读取响应失败：{e}"))?;
    let (code, headers, payload) = split_response(&raw)?;
    if !(200..300).contains(&code) {
        return Err(format!("后端返回 HTTP {code}：{}", snippet(&payload)));
    }
    let bytes = if headers.contains("transfer-encoding: chunked") {
        decode_chunked(&payload)?
    } else {
        payload
    };
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// 拆成 (状态码, 小写响应头, body)
fn split_response(raw: &[u8]) -> Result<(u16, String, Vec<u8>), String> {
    let pos = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "响应不完整（没有找到头部结束标记）".to_string())?;
    let head = String::from_utf8_lossy(&raw[..pos]).to_string();
    let body = raw[pos + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("状态行无法解析：{status_line}"))?;
    Ok((code, head.to_ascii_lowercase(), body))
}

/// Go 的 net/http 在响应较大或未预置长度时会用 chunked，必须解码
fn decode_chunked(payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < payload.len() {
        let line_end = payload[i..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .map(|p| i + p)
            .ok_or_else(|| "chunk 头不完整".to_string())?;
        let line = String::from_utf8_lossy(&payload[i..line_end]).to_string();
        let size_hex = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| format!("chunk 长度非法：{size_hex:?}"))?;
        i = line_end + 2;
        if size == 0 {
            break;
        }
        let end = (i + size).min(payload.len());
        out.extend_from_slice(&payload[i..end]);
        i = end + 2; // 跳过 chunk 末尾的 CRLF
    }
    Ok(out)
}

fn snippet(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let t: String = s.trim().chars().take(200).collect();
    if t.is_empty() {
        "（空响应体）".to_string()
    } else {
        t
    }
}

#[cfg(test)]
mod tests {
    //! 后端 server/ 目前只有 /api/health /api/rules /api/month，还没有 /api/sync（本轮限定只改 pc/，
    //! 不改 server/）。所以客户端逻辑用进程内的最小 mock 后端来验证 —— 等价于 Go 的
    //! httptest.NewServer：真监听 127.0.0.1 随机端口、真解 HTTP、按契约 §7.2 做 LWW 仲裁。

    use super::*;
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    #[derive(Default)]
    struct MockState {
        rules: BTreeMap<String, Value>,
        tasks: BTreeMap<String, Value>,
        memos: BTreeMap<String, Value>,
        reminders: BTreeMap<String, Value>,
        completions: BTreeMap<String, Value>,
        max_rev: i64,
        requests: Vec<String>,
    }

    fn start_mock() -> (String, Arc<Mutex<MockState>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定随机端口");
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(MockState::default()));
        let st = Arc::clone(&state);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    let t = line.trim();
                    if t.is_empty() {
                        break;
                    }
                    if let Some(v) = t.to_ascii_lowercase().strip_prefix("content-length:") {
                        content_length = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut buf = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut buf);
                }
                let body = String::from_utf8_lossy(&buf).to_string();
                let (code, payload) = {
                    let mut guard = st.lock().unwrap();
                    handle(&mut guard, &request_line, &body)
                };
                let resp = format!(
                    "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.as_bytes().len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://127.0.0.1:{port}"), state)
    }

    fn handle(st: &mut MockState, request_line: &str, body: &str) -> (u16, String) {
        st.requests.push(request_line.trim().to_string());
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("");
        let route = target.split('?').next().unwrap_or("");
        match (method, route) {
            ("POST", "/api/sync/push") => {
                let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                let mut accepted = [0i64; 5];
                for (i, table) in ["rules", "tasks", "memos", "reminders", "completions"].iter().enumerate() {
                    let rows = parsed
                        .get(*table)
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let map = match *table {
                        "rules" => &mut st.rules,
                        "tasks" => &mut st.tasks,
                        "memos" => &mut st.memos,
                        "reminders" => &mut st.reminders,
                        _ => &mut st.completions,
                    };
                    accepted[i] = merge(map, &rows, &mut st.max_rev);
                }
                (
                    200,
                    json!({
                        "accepted": {
                            "rules": accepted[0], "tasks": accepted[1],
                            "memos": accepted[2], "reminders": accepted[3],
                            "completions": accepted[4]
                        },
                        "maxRev": st.max_rev
                    })
                    .to_string(),
                )
            }
            ("GET", "/api/sync/pull") => {
                let since: i64 = target
                    .split("since=")
                    .nth(1)
                    .and_then(|v| v.split('&').next())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let pick = |m: &BTreeMap<String, Value>| -> Vec<Value> {
                    m.values()
                        .filter(|r| r.get("rev").and_then(|v| v.as_i64()).unwrap_or(0) > since)
                        .cloned()
                        .collect()
                };
                (
                    200,
                    json!({
                        "rules": pick(&st.rules),
                        "tasks": pick(&st.tasks),
                        "memos": pick(&st.memos),
                        "reminders": pick(&st.reminders),
                        "completions": pick(&st.completions),
                        "maxRev": st.max_rev,
                        "hasMore": false
                    })
                    .to_string(),
                )
            }
            _ => (404, json!({ "error": "not found" }).to_string()),
        }
    }

    /// 服务端侧仲裁：updated_at 大者赢，相等比 rev，再相等保留原值；赢的一方 rev = maxRev+1
    fn merge(map: &mut BTreeMap<String, Value>, rows: &[Value], max_rev: &mut i64) -> i64 {
        let mut n = 0;
        for row in rows {
            let key = match (
                row.get("id").and_then(|v| v.as_str()),
                row.get("task_id").and_then(|v| v.as_str()),
                row.get("period_start").and_then(|v| v.as_str()),
            ) {
                (Some(id), _, _) => id.to_string(),
                (None, Some(t), Some(p)) => format!("{t}:{p}"),
                _ => continue,
            };
            let inc_ts = row.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
            let inc_rev = row.get("rev").and_then(|v| v.as_i64()).unwrap_or(0);
            let win = match map.get(&key) {
                None => true,
                Some(cur) => {
                    let ts = cur.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
                    let rev = cur.get("rev").and_then(|v| v.as_i64()).unwrap_or(0);
                    inc_ts > ts || (inc_ts == ts && inc_rev > rev)
                }
            };
            if !win {
                continue;
            }
            *max_rev += 1;
            let mut row = row.clone();
            row["rev"] = json!(*max_rev);
            map.insert(key, row);
            n += 1;
        }
        n
    }

    /* ---------- 用例 ---------- */

    /// push 真能被后端收下 + 本地 dirty 清零 + pull 把对端更新的取消打卡合并回来。
    #[test]
    fn push_then_pull_round_trip_against_mock_server() {
        let (url, mock) = start_mock();
        let db = crate::db::Db::open_in_memory().unwrap();
        db.set_sync_url(&url).unwrap();
        db.toggle_done("t_fit", "2026-10-19", true).unwrap();
        assert_eq!(db.dirty_count().unwrap(), 1);

        let res = sync_now(&db);
        assert!(res.ok, "首次同步应成功：{}", res.error);
        assert_eq!(res.pushed, 1, "应推上去 1 条打卡");
        assert_eq!(db.dirty_count().unwrap(), 0, "push 成功后本地清 dirty");

        {
            let st = mock.lock().unwrap();
            assert!(
                st.requests.iter().any(|r| r.starts_with("POST /api/sync/push")),
                "服务端应收到 push：{:?}",
                st.requests
            );
            assert!(
                st.requests.iter().any(|r| r.starts_with("GET /api/sync/pull?since=0")),
                "服务端应收到 since=0 的 pull：{:?}",
                st.requests
            );
            assert_eq!(st.completions.len(), 1, "服务端应存下这条打卡");
            let row = st.completions.get("t_fit:2026-10-19").unwrap();
            assert_eq!(row["status"], json!(1));
            assert_eq!(st.max_rev, 1);
        }

        // 另一台设备把同周期改成未完成（updated_at 更大）→ 本轮 pull 应让它赢
        {
            let mut st = mock.lock().unwrap();
            let key = "t_fit:2026-10-19".to_string();
            let mut row = st.completions.get(&key).unwrap().clone();
            row["status"] = json!(0);
            row["updated_at"] = json!(row["updated_at"].as_i64().unwrap() + 5000);
            st.max_rev += 1;
            row["rev"] = json!(st.max_rev);
            st.completions.insert(key, row);
        }

        let res2 = sync_now(&db);
        assert!(res2.ok, "第二次同步应成功：{}", res2.error);
        assert_eq!(res2.pushed, 0, "本地已无 dirty");
        assert_eq!(res2.pulled, 1, "应拉回 1 条对端更新");
        assert!(db.last_pulled_rev() >= 2, "游标应前进到 2：{}", db.last_pulled_rev());
        assert!(
            !db.day("2026-10-20")
                .unwrap()
                .tasks
                .iter()
                .find(|t| t.task_id == "t_fit")
                .unwrap()
                .done,
            "对端更新的取消打卡应生效（整周回到未完成）"
        );
        // 第三次同步是空转：没 dirty，游标已经到 maxRev，不再重复应用
        let res3 = sync_now(&db);
        assert!(res3.ok, "{}", res3.error);
        assert_eq!((res3.pushed, res3.pulled), (0, 0), "幂等：第三次同步不该重复写");
    }

    /// 后端没起（端口没人听）：返回错误、保留 dirty、本地数据不回滚。
    #[test]
    fn sync_failure_keeps_dirty_and_never_rolls_back() {
        let db = crate::db::Db::open_in_memory().unwrap();
        db.set_sync_url("http://127.0.0.1:1").unwrap();
        db.toggle_done("t_fit", "2026-10-19", true).unwrap();

        let res = sync_now(&db);
        assert!(!res.ok, "连不上必须报失败");
        assert!(!res.error.is_empty(), "错误信息不能为空");
        assert_eq!((res.pushed, res.pulled), (0, 0));
        assert_eq!(db.dirty_count().unwrap(), 1, "失败保留 dirty 等下次重试");
        assert!(
            db.day("2026-10-20")
                .unwrap()
                .tasks
                .iter()
                .find(|t| t.task_id == "t_fit")
                .unwrap()
                .done,
            "失败不回滚本地数据"
        );
        assert!(!db.last_error().is_empty(), "最近一次错误应落到 local_state");
        assert_eq!(db.last_sync_at(), 0, "失败不刷新上次同步时间");
    }

    /// 同步成功/失败都要反映在设置页要用的状态里。
    #[test]
    fn status_reflects_success_and_failure() {
        let (url, _mock) = start_mock();
        let db = crate::db::Db::open_in_memory().unwrap();
        db.set_sync_url(&url).unwrap();
        db.toggle_done("t_fit", "2026-10-19", true).unwrap();

        let before = status(&db);
        assert_eq!(before.dirty, 1);
        assert_eq!(before.last_sync_at, 0);

        assert!(sync_now(&db).ok);
        let after = status(&db);
        assert!(after.last_sync_at > 0, "成功后应记下上次同步时间");
        assert_eq!(after.dirty, 0);
        assert_eq!(after.last_error, "");
        assert_eq!(after.url, url);
        assert!(after.last_pulled_rev >= 0);
    }

    /// 地址解析：只认 http，缺协议头 / 带路径都要拒绝。
    #[test]
    fn parse_base_rules() {
        assert_eq!(parse_base("http://127.0.0.1:8420").unwrap(), ("127.0.0.1".into(), 8420));
        assert_eq!(parse_base("http://192.168.1.9:8080/").unwrap(), ("192.168.1.9".into(), 8080));
        assert_eq!(parse_base("http://example.lan").unwrap(), ("example.lan".into(), 80));
        assert!(parse_base("https://example.lan:8420").is_err(), "https 明确不支持");
        assert!(parse_base("192.168.1.9:8420").is_err());
        assert!(parse_base("http://").is_err());
        assert!(parse_base("http://host:port").is_err());
    }

    /// chunked 响应必须能解（Go 的 net/http 在大响应或未预置长度时会这么回）
    #[test]
    fn decodes_chunked_body() {
        let payload = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(String::from_utf8(decode_chunked(payload).unwrap()).unwrap(), "hello world");
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
        let (code, headers, body) = split_response(raw).unwrap();
        assert_eq!(code, 200);
        assert!(headers.contains("transfer-encoding: chunked"));
        assert_eq!(String::from_utf8(decode_chunked(&body).unwrap()).unwrap(), "hello");
    }

    #[test]
    fn http_error_status_is_reported() {
        let (url, mock) = start_mock();
        // 打一个 mock 不认识的路径 → 404，错误信息里要带状态码
        let err = http_json(&url, "GET", "/api/nope", None).unwrap_err();
        assert!(err.contains("404"), "错误信息应带状态码：{err}");
        assert_eq!(mock.lock().unwrap().requests.len(), 1);
    }

    /// R5（契约 §11.4）：提醒随规则一起同步 —— push 后后端 reminder 表有该行，另一台 pull 得到同一行。
    #[test]
    fn r5_reminder_round_trips_to_another_device() {
        let (url, mock) = start_mock();
        let a = crate::db::Db::open_in_memory().unwrap();
        a.set_sync_url(&url).unwrap();
        let id = a
            .save_reminder(
                &crate::db::ReminderInput {
                    owner_kind: crate::db::REMINDER_RULE,
                    owner_id: "r_work".into(),
                    notify_on: 1,
                    alarm_on: 1,
                    time_of_day: "21:00".into(),
                    notify_text: "该打卡了：工作日常规".into(),
                    snooze_min: 5,
                    ..Default::default()
                },
                1_700_000_000_000,
            )
            .unwrap();

        let res = sync_now(&a);
        assert!(res.ok, "首次同步应成功：{}", res.error);
        assert_eq!(res.pushed, 1, "应推上去 1 条提醒");
        assert_eq!(a.dirty_count().unwrap(), 0, "push 成功后本地清 dirty");
        {
            let st = mock.lock().unwrap();
            assert!(
                st.requests.iter().any(|r| r.starts_with("POST /api/sync/push")),
                "服务端应收到 push：{:?}",
                st.requests
            );
            assert_eq!(st.reminders.len(), 1, "后端 reminder 表应有这一行");
            let row = st.reminders.get(&id).expect("按 id 存下");
            assert_eq!(row["notify_on"], json!(1));
            assert_eq!(row["alarm_on"], json!(1));
            assert_eq!(row["owner_kind"], json!(0));
            assert_eq!(row["owner_id"], json!("r_work"));
            assert_eq!(row["time_of_day"], json!("21:00"));
        }

        // 另一台设备：同样的种子、空的 reminder 表 → pull 后拿到同一条提醒与同样的摘要
        let b = crate::db::Db::open_in_memory().unwrap();
        b.set_sync_url(&url).unwrap();
        let res2 = sync_now(&b);
        assert!(res2.ok, "第二台同步应成功：{}", res2.error);
        assert_eq!(res2.pulled, 1, "应拉回 1 条提醒");
        let row = b
            .get_reminder(crate::db::REMINDER_RULE, "r_work")
            .unwrap()
            .expect("另一台应拉到提醒");
        assert_eq!((row.notify_on, row.alarm_on), (1, 1));
        assert_eq!(row.time_of_day, "21:00");
        assert_eq!(row.notify_text, "该打卡了：工作日常规");
        assert_eq!(row.dirty, 0, "pull 下来的行不该再 dirty");
        let summary = b
            .list_rules(true)
            .unwrap()
            .into_iter()
            .find(|r| r.id == "r_work")
            .unwrap()
            .reminder_summary;
        assert_eq!(summary, "通知 21:00 + 闹钟 21:00", "R5：另一台的列表摘要");
    }
}
