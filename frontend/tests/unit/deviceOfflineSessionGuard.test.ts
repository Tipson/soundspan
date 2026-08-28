import assert from "node:assert/strict";
import test from "node:test";
import { DeviceOfflineSessionGuard } from "../../features/device-offline/sessionGuard";

test("a stale completion cannot publish after its provider unmounts", () => {
    const guard = new DeviceOfflineSessionGuard("user-a");
    const pending = guard.begin("user-a");
    assert.ok(pending);

    guard.unmount();
    let published = false;
    assert.equal(
        guard.publishIfCurrent(pending, () => (published = true)),
        false,
    );
    assert.equal(guard.begin("user-a"), null);
    assert.equal(published, false);
});

test("a stale user A completion cannot supersede user B after a session switch", () => {
    const guard = new DeviceOfflineSessionGuard("user-a");
    const pendingA = guard.begin("user-a");
    assert.ok(pendingA);

    guard.setOwner("user-b");
    const pendingB = guard.begin("user-b");
    assert.ok(pendingB);
    let publishedOwner: string | null = null;

    assert.equal(
        guard.publishIfCurrent(pendingA, () => (publishedOwner = "user-a")),
        false,
    );
    assert.equal(guard.begin("user-a"), null);
    assert.equal(
        guard.publishIfCurrent(pendingB, () => (publishedOwner = "user-b")),
        true,
    );
    assert.equal(publishedOwner, "user-b");
});
