import assert from "node:assert/strict";
import test from "node:test";
import {
    startPhysicalFileDownload,
    type PhysicalFileDownloadLink,
    type PhysicalFileDownloadRuntime,
} from "../../features/device-offline/physicalFileExport";

function createRuntime(input?: { clickError?: Error }) {
    const links: PhysicalFileDownloadLink[] = [];
    const appended: PhysicalFileDownloadLink[] = [];
    const removed: PhysicalFileDownloadLink[] = [];
    const deferred: Array<() => void> = [];
    let clicks = 0;
    const runtime: PhysicalFileDownloadRuntime = {
        createLink: () => {
            const link: PhysicalFileDownloadLink = {
                href: "",
                download: "",
                rel: "",
                click: () => {
                    clicks += 1;
                    if (input?.clickError) throw input.clickError;
                },
                remove: () => removed.push(link),
            };
            links.push(link);
            return link;
        },
        appendLink: (link) => appended.push(link),
        defer: (callback) => deferred.push(callback),
    };
    return {
        runtime,
        links,
        appended,
        removed,
        deferred,
        clicks: () => clicks,
    };
}

test("physical export starts one browser file download and releases the Blob URL after handoff", () => {
    const harness = createRuntime();
    let releases = 0;

    startPhysicalFileDownload(
        {
            url: "blob:soundspan/export",
            displayName: "Artist - Track.mp3",
            release: () => {
                releases += 1;
            },
        },
        harness.runtime,
    );

    assert.equal(harness.clicks(), 1);
    assert.equal(harness.appended.length, 1);
    assert.equal(harness.removed.length, 1);
    assert.equal(harness.links[0].href, "blob:soundspan/export");
    assert.equal(harness.links[0].download, "Artist - Track.mp3");
    assert.equal(harness.links[0].rel, "noopener");
    assert.equal(releases, 0);
    assert.equal(harness.deferred.length, 1);
    harness.deferred[0]();
    harness.deferred[0]();
    assert.equal(releases, 1);
});

test("physical export releases its Blob URL and removes the link when the browser rejects the click", () => {
    const harness = createRuntime({ clickError: new Error("blocked") });
    let releases = 0;

    assert.throws(
        () =>
            startPhysicalFileDownload(
                {
                    url: "blob:soundspan/export",
                    displayName: "Track.mp3",
                    release: () => {
                        releases += 1;
                    },
                },
                harness.runtime,
            ),
        /blocked/,
    );
    assert.equal(harness.removed.length, 1);
    assert.equal(releases, 1);
    assert.equal(harness.deferred.length, 0);
});
