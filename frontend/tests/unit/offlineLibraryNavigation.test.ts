import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { handleOfflineLibraryNavigation } from "../../components/layout/offlineLibraryNavigation";

test("offline Library navigation hard-loads the precached Downloads shell", () => {
    const preventDefault = mock.fn();
    const hardNavigate = mock.fn((_path: string) => undefined);

    assert.equal(
        handleOfflineLibraryNavigation({
            isOnline: false,
            preventDefault,
            hardNavigate,
        }),
        true,
    );
    assert.equal(preventDefault.mock.callCount(), 1);
    assert.deepEqual(
        hardNavigate.mock.calls.map((call) => call.arguments[0]),
        ["/library?tab=downloads"],
    );
});

test("online Library navigation remains a normal Next Link transition", () => {
    const preventDefault = mock.fn();
    const hardNavigate = mock.fn((_path: string) => undefined);

    assert.equal(
        handleOfflineLibraryNavigation({
            isOnline: true,
            preventDefault,
            hardNavigate,
        }),
        false,
    );
    assert.equal(preventDefault.mock.callCount(), 0);
    assert.equal(hardNavigate.mock.callCount(), 0);
});
