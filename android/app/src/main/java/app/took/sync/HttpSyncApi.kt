package app.took.sync

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * 用 HttpURLConnection 实现推送/拉取，刻意不引 OkHttp：
 * 只有两个请求、没有连接池/拦截器/重试策略的需求，多一个依赖就多一份 APK 体积与版本冲突面。
 * 超时都设死，局域网地址打不通时必须快速失败（同步是后台静默动作，不能挂住界面线程）。
 */
class HttpSyncApi(
    private val baseUrl: String,
    private val connectTimeoutMs: Int = 4000,
    private val readTimeoutMs: Int = 8000,
) : SyncApi {

    override fun push(batch: SyncBatch): PushResponse {
        val text = exchange("POST", "/api/sync/push", Json.write(batch.toJson()))
        val obj = asObject(text, "push")
        val accepted = (obj["accepted"] as? JsonObject).orEmpty()
            .mapValues { (_, v) -> (v as? Number)?.toInt() ?: 0 }
        return PushResponse(accepted, number(obj["maxRev"]))
    }

    override fun pull(since: Long): PullResponse {
        val text = exchange("GET", "/api/sync/pull?since=" + since, null)
        val obj = asObject(text, "pull")
        return PullResponse(
            batch = SyncBatch.fromJson(obj),
            maxRev = number(obj["maxRev"]),
            hasMore = obj["hasMore"] as? Boolean ?: false,
        )
    }

    private fun asObject(text: String, what: String): JsonObject =
        Json.parse(text) as? JsonObject
            ?: throw IOException("$what 响应不是 JSON 对象：${text.take(120)}")

    private fun number(v: Any?): Long = (v as? Number)?.toLong() ?: 0L

    private fun exchange(method: String, path: String, body: String?): String {
        val url = URL(baseUrl.trimEnd('/') + path)
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = connectTimeoutMs
            conn.readTimeout = readTimeoutMs
            conn.setRequestProperty("Accept", "application/json")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = (conn.errorStream ?: conn.inputStream)?.use { it.readBytes().toString(Charsets.UTF_8) }
                throw IOException("HTTP $code：${err?.take(200).orEmpty()}")
            }
            return conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        } finally {
            conn.disconnect()
        }
    }
}
