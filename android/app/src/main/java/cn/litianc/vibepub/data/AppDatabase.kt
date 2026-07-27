package cn.litianc.vibepub.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [RecordingEntity::class], version = 10, exportSchema = false)
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
                    .addMigrations(
                        MIGRATION_1_2,
                        MIGRATION_2_3,
                        MIGRATION_3_4,
                        MIGRATION_4_5,
                        MIGRATION_5_6,
                        MIGRATION_6_7,
                        MIGRATION_7_8,
                        MIGRATION_8_9,
                        MIGRATION_9_10,
                    )
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

        private val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE recordings ADD COLUMN coverImageUrl TEXT")
            }
        }

        private val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE recordings ADD COLUMN sourceType TEXT NOT NULL DEFAULT 'RECORDING'")
                db.execSQL("ALTER TABLE recordings ADD COLUMN inputText TEXT")
            }
        }

        private val MIGRATION_8_9 = object : Migration(8, 9) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE recordings ADD COLUMN userId TEXT NOT NULL DEFAULT 'default_user'")
                db.execSQL("DROP INDEX IF EXISTS index_recordings_filename")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_recordings_userId_filename ON recordings(userId, filename)")
            }
        }

        internal val MIGRATION_9_10 = object : Migration(9, 10) {
            override fun migrate(db: SupportSQLiteDatabase) {
                migrateRecordings9To10(db::execSQL)
            }
        }
    }
}

internal fun migrateRecordings9To10(execSql: (String) -> Unit) {
    listOf(
        "ALTER TABLE recordings ADD COLUMN remoteRecordingId INTEGER",
        "ALTER TABLE recordings ADD COLUMN publicationRunId TEXT",
        "ALTER TABLE recordings ADD COLUMN publicationState TEXT",
        "ALTER TABLE recordings ADD COLUMN publicationRunStatus TEXT",
        "ALTER TABLE recordings ADD COLUMN publicationStage TEXT",
        "ALTER TABLE recordings ADD COLUMN publicationStateRevision INTEGER",
        "ALTER TABLE recordings ADD COLUMN publicationProgressPercent INTEGER",
        "ALTER TABLE recordings ADD COLUMN publicationLastSuccessfulState TEXT",
        "ALTER TABLE recordings ADD COLUMN publicationLastSuccessfulProgressPercent INTEGER",
        "ALTER TABLE recordings ADD COLUMN publicationRetryCount INTEGER",
        "ALTER TABLE recordings ADD COLUMN publicationNextAction TEXT",
        "ALTER TABLE recordings ADD COLUMN publicationErrorCode TEXT",
        "ALTER TABLE recordings ADD COLUMN publicationRunCreatedAt TEXT",
        "ALTER TABLE recordings ADD COLUMN publicationUpdatedAt TEXT",
    ).forEach(execSql)
}
