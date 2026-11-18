package ru.agentik007.soundspan.app.updates

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import java.lang.ref.WeakReference

/** Explicit, non-exported mutable PendingIntent receiver. Never launches UI itself. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = record(context)
        val nonce = intent.getStringExtra("nonce") ?: return
        val id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        if (intent.action != "${context.packageName}.UPDATE_STATUS" ||
            prefs.getString("nonce", null) != nonce || prefs.getInt("session", -1) != id || id <= 0) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION && status !in 0..8) return
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            prefs.edit().putString("phase", "pending").commit()
        } else { clear(context, nonce, id) }
        listener?.get()?.onInstallStatus(intent, nonce, id, status)
    }
    companion object {
        internal var listener: WeakReference<NativeAppUpdatePlugin>? = null
        internal fun record(context: Context) = context.getSharedPreferences("soundspan.appUpdate.v1", Context.MODE_PRIVATE)
        internal fun clear(context: Context, nonce: String, id: Int) {
            val prefs = record(context)
            if (prefs.getString("nonce", null) == nonce && prefs.getInt("session", -1) == id) prefs.edit().clear().commit()
        }
    }
}
