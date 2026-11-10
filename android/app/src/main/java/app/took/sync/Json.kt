package app.took.sync

import kotlin.math.abs

/**
 * 极简 JSON 编解码，只为同步协议的形状服务。
 *
 * 不引第三方库的原因：android.jar 里的 org.json 在 JVM 单测中是抛异常的桩类，
 * 而同步仲裁恰恰是本轮必须用单测覆盖的部分；自己写 100 行既能测，
 * 也避免为一次 push/pull 拉进 Gson/Moshi/jackson。
 *
 * 值模型：null / Boolean / Long / Double / String / Map<String, Any?> / List<Any?>。
 */
object Json {

    fun write(value: Any?): String = StringBuilder().also { writeTo(it, value) }.toString()

    fun parse(text: String): Any? {
        val p = Parser(text)
        val v = p.value()
        p.skipWs()
        require(p.eof()) { "JSON 尾部有多余字符，位置 ${p.pos}" }
        return v
    }

    private fun writeTo(sb: StringBuilder, value: Any?) {
        when (value) {
            null -> sb.append("null")
            is String -> quote(sb, value)
            is Boolean -> sb.append(if (value) "true" else "false")
            is Int, is Long, is Short, is Byte -> sb.append(value.toString())
            is Double -> if (value == value.toLong().toDouble() && abs(value) < 1e15) {
                sb.append(value.toLong().toString())
            } else {
                sb.append(value.toString())
            }
            is Float -> sb.append(value.toString())
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    first = false
                    quote(sb, k?.toString() ?: "null")
                    sb.append(':')
                    writeTo(sb, v)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (e in value) {
                    if (!first) sb.append(',')
                    first = false
                    writeTo(sb, e)
                }
                sb.append(']')
            }
            else -> quote(sb, value.toString())
        }
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
    }

    private class Parser(private val s: String) {
        var pos = 0

        fun eof(): Boolean = pos >= s.length

        fun skipWs() {
            while (pos < s.length && s[pos].isWhitespace()) pos++
        }

        fun value(): Any? {
            skipWs()
            if (pos >= s.length) throw IllegalArgumentException("JSON 意外结束")
            return when (val c = s[pos]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) num() else throw IllegalArgumentException("JSON 非法字符 '$c'，位置 $pos")
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            require(s.startsWith(word, pos)) { "JSON 期望 $word，位置 $pos" }
            pos += word.length
            return v
        }

        private fun obj(): Map<String, Any?> {
            expect('{')
            val m = LinkedHashMap<String, Any?>()
            skipWs()
            if (peek() == '}') {
                pos++
                return m
            }
            while (true) {
                val k = str()
                expect(':')
                m[k] = value()
                skipWs()
                when (peek()) {
                    ',' -> pos++
                    '}' -> {
                        pos++
                        return m
                    }
                    else -> throw IllegalArgumentException("JSON 期望 , 或 }，位置 $pos")
                }
            }
        }

        private fun arr(): List<Any?> {
            expect('[')
            val out = ArrayList<Any?>()
            skipWs()
            if (peek() == ']') {
                pos++
                return out
            }
            while (true) {
                out.add(value())
                skipWs()
                when (peek()) {
                    ',' -> pos++
                    ']' -> {
                        pos++
                        return out
                    }
                    else -> throw IllegalArgumentException("JSON 期望 , 或 ]，位置 $pos")
                }
            }
        }

        private fun str(): String {
            expect('"')
            val sb = StringBuilder()
            while (true) {
                require(pos < s.length) { "JSON 字符串未结束" }
                when (val c = s[pos++]) {
                    '"' -> return sb.toString()
                    '\\' -> {
                        require(pos < s.length) { "JSON 转义未结束" }
                        when (val e = s[pos++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                require(pos + 4 <= s.length) { "JSON \\u 转义不完整" }
                                sb.append(s.substring(pos, pos + 4).toInt(16).toChar())
                                pos += 4
                            }
                            else -> throw IllegalArgumentException("JSON 非法转义 \\$e，位置 $pos")
                        }
                    }
                    else -> sb.append(c)
                }
            }
        }

        private fun num(): Any {
            val start = pos
            if (peek() == '-') pos++
            while (pos < s.length) {
                val c = s[pos]
                if (c.isDigit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') pos++ else break
            }
            val raw = s.substring(start, pos)
            return if (raw.contains('.') || raw.contains('e') || raw.contains('E')) raw.toDouble() else raw.toLong()
        }

        private fun peek(): Char = if (pos < s.length) s[pos] else '\u0000'

        private fun expect(c: Char) {
            skipWs()
            if (peek() != c) throw IllegalArgumentException("JSON 期望 '$c'，位置 $pos")
            pos++
        }
    }
}
