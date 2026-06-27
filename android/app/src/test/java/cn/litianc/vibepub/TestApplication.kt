package cn.litianc.vibepub

import android.app.Application
import androidx.work.Configuration
import androidx.work.testing.WorkManagerTestInitHelper

class TestApplication : Application(), Configuration.Provider {
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.DEBUG)
            .build()

    override fun onCreate() {
        super.onCreate()
        WorkManagerTestInitHelper.initializeTestWorkManager(this)
    }
}
