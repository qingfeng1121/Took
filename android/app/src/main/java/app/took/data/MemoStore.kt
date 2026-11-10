package app.took.data

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase

/**
 * memo（记事 / 倒数日 / 笔记本）的存储端口。
 *
 * 与 [RuleStore] 同理：校验与软删语义必须在 JVM 单测里断言（M1~M6），
 * 因此读写的具体 SQL 全部退到这层实现后面，测试用内存实现即可跑。
 * 读方法含软删行（写路径要看得见墓碑，避免「删了又建同 id」把墓碑覆盖掉）。
 */
interface MemoStore {
    fun memo(id: String): MemoRow?

    /** 全部 memo（含软删）。 */
    fun memos(): List<MemoRow>
    fun putMemo(memo: MemoRow)
}

/** SQLite 实现：整行写入（含同步四件套），调用方负责算好 updated_at / dirty / deleted。 */
class SqliteMemoStore(private val db: TookDb) : MemoStore {

    override fun memo(id: String): MemoRow? {
        db.readableDatabase.rawQuery(
            "SELECT $MEMO_COLUMNS FROM memo WHERE id=?",
            arrayOf(id),
        ).use { c ->
            if (!c.moveToFirst()) return null
            return readMemo(c)
        }
    }

    override fun memos(): List<MemoRow> {
        val out = ArrayList<MemoRow>()
        db.readableDatabase.rawQuery(
            "SELECT $MEMO_COLUMNS FROM memo ORDER BY kind, updated_at",
            null,
        ).use { c ->
            while (c.moveToNext()) out.add(readMemo(c))
        }
        return out
    }

    override fun putMemo(memo: MemoRow) {
        val v = ContentValues().apply {
            put("id", memo.id)
            put("kind", memo.kind)
            put("title", memo.title)
            // 空串落 NULL：与 PC 端 empty_to_null 一致，避免同构库里出现两种「空」
            put("content", memo.content?.takeIf { it.isNotBlank() })
            put("start_date", memo.startDate?.takeIf { it.isNotBlank() })
            put("end_date", memo.endDate?.takeIf { it.isNotBlank() })
            put("category", memo.category?.takeIf { it.isNotBlank() })
            put("rev", memo.rev)
            put("updated_at", memo.updatedAt)
            put("deleted", memo.deleted)
            put("dirty", memo.dirty)
        }
        db.writableDatabase.insertWithOnConflict("memo", null, v, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun readMemo(c: android.database.Cursor) = MemoRow(
        id = c.getString(0),
        kind = c.getInt(1),
        title = c.getString(2),
        content = if (c.isNull(3)) null else c.getString(3),
        startDate = if (c.isNull(4)) null else c.getString(4),
        endDate = if (c.isNull(5)) null else c.getString(5),
        category = if (c.isNull(6)) null else c.getString(6),
        rev = c.getLong(7),
        updatedAt = c.getLong(8),
        deleted = c.getInt(9),
        dirty = c.getInt(10),
    )

    private companion object {
        const val MEMO_COLUMNS =
            "id, kind, title, content, start_date, end_date, category, rev, updated_at, deleted, dirty"
    }
}
