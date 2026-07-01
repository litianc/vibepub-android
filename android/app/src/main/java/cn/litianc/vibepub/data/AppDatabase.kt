package cn.litianc.vibepub.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [RecordingEntity::class], version = 6, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun recordingDao(): RecordingDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getDatabase(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "vibepub_database"
                )
                    .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6)
                    .build()
                INSTANCE = instance
                instance
            }
        }

        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    DELETE FROM recordings
                    WHERE EXISTS (
                        SELECT 1
                        FROM recordings AS better
                        WHERE better.filename = recordings.filename
                          AND (
                              better.durationMs > recordings.durationMs
                              OR (
                                  better.durationMs = recordings.durationMs
                                  AND better.timestamp < recordings.timestamp
                              )
                              OR (
                                  better.durationMs = recordings.durationMs
                                  AND better.timestamp = recordings.timestamp
                                  AND better.id < recordings.id
                              )
                          )
                    )
                    """.trimIndent()
                )
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_recordings_filename ON recordings(filename)")
            }
        }

        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE recordings ADD COLUMN articleTitle TEXT")
                db.execSQL("ALTER TABLE recordings ADD COLUMN rawTextPreview TEXT")
                db.execSQL("ALTER TABLE recordings ADD COLUMN localAudioPath TEXT")
                db.execSQL("ALTER TABLE recordings ADD COLUMN remoteStatusUpdatedAt TEXT")
                db.execSQL("ALTER TABLE recordings ADD COLUMN lastError TEXT")
                db.execSQL("ALTER TABLE recordings ADD COLUMN completedAt INTEGER")
                db.execSQL(
                    """
                    UPDATE recordings
                    SET status = CASE
                        WHEN status = 'TRANSCRIBED' THEN 'COMPLETED'
                        WHEN status IS NULL OR status = '' THEN 'LOCAL_RECORDED'
                        ELSE status
                    END
                    """.trimIndent(),
                )
            }
        }

        private val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE recordings ADD COLUMN wechatDraftId TEXT")
                db.execSQL("ALTER TABLE recordings ADD COLUMN wechatUrl TEXT")
            }
        }

        private val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE recordings ADD COLUMN processingStage TEXT")
            }
        }

        private val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE recordings ADD COLUMN deletedAt INTEGER")
            }
        }
    }
}
