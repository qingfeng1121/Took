package app.took.sync

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.Closeable
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * 同步客户端的端到端测试：**真开一个 HTTP 服务器**（裸 ServerSocket，不引第三方），
 * 真跑 HttpSyncApi → SyncManager → 内存 SyncStore 的整条链路。
 *
 * 为什么不是「起 Go 后端真跑」：server/main.go 当前只实现 /api/health、/api/rules、/api/month，
 * 契约 §7.1 的 /api/sync/push、/api/sync/pull **尚未实现**（本轮范围限定只改 android/，
 * 不能顺手加后端接口）。因此这里按 §7.1 / §7.2 的报文形状与仲裁规则实现 mock，
 * 客户端侧的行为（push 后清 dirty、pull 后按 LWW 合并、游标推进、失败保留 dirty）都是真跑的。
 * 后端补完接口后，同一份测试把这台 mock 换成真地址即可。
 */
class SyncHttpTest {

    private lateinit var server: MockSyncServer
    private lateinit var store: MemoryStore
    private lateinit var api: HttpSyncApi

    @Before
    fun setUp() {
        server = MockSyncServer()
        store = MemoryStore()
        api = HttpSyncApi("http://127.0.0.1:${server.port}")
    }

    @After
    fun tearDown() {
        server.close()
    }

    @Test
    fun pushSendsDirtyCheckinThenClearsDirtyAndAdvancesCursor() {
        store.put("t_fit", "2026-10-19", status = 1, updatedAt = 1000, rev = 0, dirty = 1)

        val outcome = SyncManager(store, api).syncOnce()

        assertTrue("同步应成功", outcome.ok)
        assertEquals("推送 1 条", 1, outcome.pushed)
        assertEquals("服务端按 LWW 收下 status=1", 1L, server.completions["t_fit|2026-10-19"]?.get("status"))
        assertEquals("push 成功后 dirty 清零", 0, store.dirtyCount())
        assertEquals("游标推进到服务端 maxRev", server.rev, store.lastPulledRev())
        assertTrue("请求体里有 completions 数组", server.pushBodies.first().contains("\"completions\""))
        assertTrue(
            "pull 带上了 since 游标：" + server.pullTargets.first(),
            server.pullTargets.first().startsWith("/api/sync/pull?since="),
        )
    }

    @Test
    fun pullAppliesRemoteNewerCheckin() {
        server.seedCompletion("t_fit", "2026-10-19", status = 1, updatedAt = 5000)

        val outcome = SyncManager(store, api).syncOnce()

        assertTrue(outcome.ok)
        assertEquals("本地无脏记录则不 push", 0, outcome.pushed)
        assertEquals("远端更新的完成要落库", 1L, store.statusOf("t_fit", "2026-10-19"))
        assertEquals(1, outcome.pulled)
    }

    @Test
    fun pullKeepsNewerLocalCancellation() {
        // 本地已同步过的取消（dirty=0），服务端还停在更早的「已完成」
        store.put("t_fit", "2026-10-19", status = 0, updatedAt = 9000, rev = 3, dirty = 0)
        server.seedCompletion("t_fit", "2026-10-19", status = 1, updatedAt = 1000)

        val outcome = SyncManager(store, api).syncOnce()

        assertTrue(outcome.ok)
        assertEquals("旧完成不能复活本地取消", 0L, store.statusOf("t_fit", "2026-10-19"))
        assertEquals("被仲裁掉的记录不计入 applied", 0, outcome.pulled)
        assertEquals("游标照样推进，避免反复拉同一条", server.rev, store.lastPulledRev())
    }

    @Test
    fun pushFailureKeepsDirtyAndCursor() {
        store.put("t_fit", "2026-10-19", status = 1, updatedAt = 1000, rev = 0, dirty = 1)
        server.failPush = true

        val outcome = SyncManager(store, api).syncOnce()

        assertFalse(outcome.ok)
        assertNotNull(outcome.error)
        assertEquals("失败不回滚：dirty 保留待重试", 1, store.dirtyCount())
        assertEquals("游标不动", 0L, store.lastPulledRev())
    }

    /* ----------------------------- 测试替身 ----------------------------- */

    /** 内存版 SyncStore：仲裁走生产的 Merge，落库时 dirty 清 0（与 SqliteSyncStore 一致）。 */
    private class MemoryStore : SyncStore {
        val rows = LinkedHashMap<String, LinkedHashMap<String, Any?>>()
        private var cursor = 0L

        fun put(taskId: String, periodStart: String, status: Long, updatedAt: Long, rev: Long, dirty: Long) {
            rows["$taskId|$periodStart"] = linkedMapOf(
                "task_id" to taskId,
                "period_start" to periodStart,
                "status" to status,
                "updated_at" to updatedAt,
                "rev" to rev,
                "deleted" to 0L,
                "dirty" to dirty,
            )
        }

        fun statusOf(taskId: String, periodStart: String): Long? =
            (rows["$taskId|$periodStart"]?.get("status") as? Number)?.toLong()

        private fun key(row: JsonObject): String =
            row["task_id"].toString() + "|" + row["period_start"].toString()

        private fun dirtyRowsNow(): List<JsonObject> =
            rows.values.filter { Merge.num(it["dirty"]) == 1L }.map { it.toMap() }

        override fun lastPulledRev(): Long = cursor

        override fun setLastPulledRev(rev: Long) {
            cursor = rev
        }

        override fun dirtyCount(): Int = dirtyRowsNow().size

        override fun dirtyRows(): SyncBatch = SyncBatch(completions = dirtyRowsNow())

        override fun markClean(pushed: SyncBatch) {
            pushed.completions.forEach { row ->
                rows[key(row)]?.set("dirty", 0L)
            }
        }

        override fun applyPulled(pulled: SyncBatch): Int {
            var applied = 0
            pulled.completions.forEach { row ->
                val k = key(row)
                if (Merge.remoteWins(rows[k]?.toMap(), row)) {
                    val stored = LinkedHashMap(row)
                    stored["dirty"] = 0L
                    rows[k] = stored
                    applied++
                }
            }
            return applied
        }
    }

    /**
     * 按契约 §7.1 / §7.2 实现的 mock 服务端：
     *  - push：对每条 completion 与已有行做 LWW，收下则 rev = 当前 maxRev + 1，回 {accepted, maxRev}；
     *  - pull：返回 rev > since 的记录（含墓碑，本测试只造 completion）+ {maxRev, hasMore}。
     */
    private class MockSyncServer : Closeable {
        private val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val port: Int get() = socket.localPort
        val completions = LinkedHashMap<String, LinkedHashMap<String, Any?>>()
        val pushBodies = ArrayList<String>()
        val pullTargets = ArrayList<String>()
        var rev = 0L

        @Volatile
        var failPush = false

        @Volatile
        private var running = true

        init {
            Thread({ loop() }, "mock-sync-server").also {
                it.isDaemon = true
                it.start()
            }
        }

        fun seedCompletion(taskId: String, periodStart: String, status: Long, updatedAt: Long) {
            synchronized(this) {
                val row = linkedMapOf<String, Any?>(
                    "task_id" to taskId,
                    "period_start" to periodStart,
                    "status" to status,
                    "updated_at" to updatedAt,
                    "deleted" to 0L,
                )
                row["rev"] = ++rev
                completions["$taskId|$periodStart"] = row
            }
        }

        private fun loop() {
            while (running) {
                val client = try {
                    socket.accept()
                } catch (e: Exception) {
                    return
                }
                try {
                    handle(client)
                } catch (e: Exception) {
                    // 单条连接失败不影响后续请求
                } finally {
                    runCatching { client.close() }
                }
            }
        }

        private fun handle(client: Socket) {
            val input = client.getInputStream()
            val requestLine = readLine(input) ?: return
            val target = requestLine.split(" ").getOrNull(1) ?: "/"
            var length = 0
            while (true) {
                val line = readLine(input) ?: return
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0 && line.substring(0, idx).trim().equals("Content-Length", ignoreCase = true)) {
                    length = line.substring(idx + 1).trim().toIntOrNull() ?: 0
                }
            }
            val body = if (length > 0) String(readBytes(input, length), Charsets.UTF_8) else ""

            val response = when {
                target.startsWith("/api/sync/push") -> {
                    synchronized(this) { pushBodies.add(body) }
                    if (failPush) http(500, "{\"error\":\"mock push failure\"}") else http(200, onPush(body))
                }
                target.startsWith("/api/sync/pull") -> {
                    synchronized(this) { pullTargets.add(target) }
                    http(200, onPull(target))
                }
                else -> http(404, "{\"error\":\"not found\"}")
            }
            client.getOutputStream().apply {
                write(response.toByteArray(Charsets.UTF_8))
                flush()
            }
        }

        private fun onPush(body: String): String {
            val obj = Json.parse(body) as? JsonObject ?: emptyMap()
            var accepted = 0
            synchronized(this) {
                for (raw in (obj[SyncTables.COMPLETIONS] as? List<*>).orEmpty()) {
                    val row = raw as? JsonObject ?: continue
                    val k = row["task_id"].toString() + "|" + row["period_start"].toString()
                    if (Merge.remoteWins(completions[k]?.toMap(), row)) {
                        val stored = LinkedHashMap(row)
                        stored.remove("dirty") // §7.1：服务端不回传 dirty，客户端自己清
                        stored["rev"] = ++rev
                        completions[k] = stored
                    }
                    accepted++
                }
                return Json.write(
                    linkedMapOf(
                        "accepted" to linkedMapOf(
                            "rules" to 0, "tasks" to 0, "memos" to 0, "completions" to accepted,
                        ),
                        "maxRev" to rev,
                    ),
                )
            }
        }

        private fun onPull(target: String): String {
            val since = target.substringAfter("since=", "0").substringBefore("&").toLongOrNull() ?: 0L
            synchronized(this) {
                val rows = completions.values.filter { Merge.num(it["rev"]) > since }.map { it.toMap() }
                return Json.write(
                    linkedMapOf(
                        SyncTables.RULES to emptyList<Any?>(),
                        SyncTables.TASKS to emptyList<Any?>(),
                        SyncTables.MEMOS to emptyList<Any?>(),
                        SyncTables.COMPLETIONS to rows,
                        "maxRev" to rev,
                        "hasMore" to false,
                    ),
                )
            }
        }

        private fun http(code: Int, body: String): String {
            val bytes = body.toByteArray(Charsets.UTF_8)
            val reason = if (code == 200) "OK" else "Error"
            return "HTTP/1.1 $code $reason\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Connection: close\r\n\r\n" + body
        }

        private fun readLine(input: InputStream): String? {
            val sb = StringBuilder()
            while (true) {
                val b = input.read()
                if (b < 0) return if (sb.isEmpty()) null else sb.toString()
                if (b == '\n'.code) return sb.toString()
                if (b != '\r'.code) sb.append(b.toChar())
            }
        }

        private fun readBytes(input: InputStream, length: Int): ByteArray {
            val buf = ByteArray(length)
            var read = 0
            while (read < length) {
                val n = input.read(buf, read, length - read)
                if (n < 0) break
                read += n
            }
            return buf
        }

        override fun close() {
            running = false
            runCatching { socket.close() }
        }
    }
}
