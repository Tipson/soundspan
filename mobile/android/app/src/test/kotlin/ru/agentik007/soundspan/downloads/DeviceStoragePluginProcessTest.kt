package ru.agentik007.soundspan.downloads

import java.util.UUID
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceStoragePluginProcessTest {
    @Test fun chargingRequiresChargingOrFullRatherThanUnknownBatteryStatus() {
        val plugin = DeviceStoragePlugin()
        assertTrue(plugin.chargingStatus(android.os.BatteryManager.BATTERY_STATUS_CHARGING))
        assertTrue(plugin.chargingStatus(android.os.BatteryManager.BATTERY_STATUS_FULL))
        assertTrue(!plugin.chargingStatus(android.os.BatteryManager.BATTERY_STATUS_UNKNOWN))
        assertTrue(!plugin.chargingStatus(android.os.BatteryManager.BATTERY_STATUS_DISCHARGING))
        assertTrue(!plugin.chargingStatus(-1))
    }
    @Test
    fun instancesForDifferentEnginesShareOneProcessIdentity() {
        val ui = DeviceStoragePlugin().processInstance()
        val headless = DeviceStoragePlugin().processInstance()
        assertTrue(ui == headless)
        val uuid = UUID.fromString(ui)
        assertTrue(uuid.toString() == ui && uuid.version() == 4 && uuid.variant() == 2)
    }
}
