import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { handleOfflineLibraryNavigation } from "../../components/layout/offlineLibraryNavigation";

test("offline Library navigation opens local downloads without replacing the document", () => {
    const preventDefault = mock.fn();
    const openDownloads = mock.fn();

    assert.equal(
        handleOfflineLibraryNavigation({
            isOnline: false,
            preventDefault,
            openDownloads,
        }),
        true,
    );
    assert.equal(preventDefault.mock.callCount(), 1);
    assert.equal(openDownloads.mock.callCount(), 1);
});

test("online Library navigation remains a normal Next Link transition", () => {
    const preventDefault = mock.fn();
    const openDownloads = mock.fn();

    assert.equal(
        handleOfflineLibraryNavigation({
            isOnline: true,
            preventDefault,
            openDownloads,
        }),
        false,
    );
    assert.equal(preventDefault.mock.callCount(), 0);
    assert.equal(openDownloads.mock.callCount(), 0);
});

test("modified offline links retain the browser's new-tab action", () => {
    const preventDefault = mock.fn();
    const openDownloads = mock.fn();
    assert.equal(
        handleOfflineLibraryNavigation({
            isOnline: false,
            isModifiedClick: true,
            preventDefault,
            openDownloads,
        }),
        false,
    );
    assert.equal(preventDefault.mock.callCount(), 0);
    assert.equal(openDownloads.mock.callCount(), 0);
});
