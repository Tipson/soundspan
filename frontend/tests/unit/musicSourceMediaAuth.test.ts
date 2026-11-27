import assert from "node:assert/strict";
import test from "node:test";
import {
    prepareProxyAuthentication,
    prepareFetchProxyAuthentication,
} from "../../lib/media-auth";
const path = `/api/music-sources/leases/${"a".repeat(48)}/stream`;
const versionPath =
    "/api/track-audio/versions/19b2ace6-d28a-4d70-9cb5-44fce755a86e/stream";
test("both proxies forward browser media credentials only to full version reads", () => {
    for (const [method, url, expected] of [
        ["GET", versionPath, "Bearer test-access"],
        ["HEAD", versionPath, "Bearer test-access"],
        ["PUT", "/api/track-audio/library/a/draft", null],
        ["GET", "/api/track-audio/library/a/manage", null],
        ["GET", "/api/track-audio/versions/not-a-uuid/stream", null],
        ["POST", versionPath, null],
    ] as const) {
        const headers = new Headers({
            cookie: "soundspan_media_auth=test-access",
        });
        const req = {
            method,
            url,
            headers: { cookie: "soundspan_media_auth=test-access" } as Record<
                string,
                string
            >,
        };
        prepareProxyAuthentication(req);
        prepareFetchProxyAuthentication(url, headers, method);
        assert.equal(req.headers.authorization ?? null, expected);
        assert.equal(headers.get("authorization"), expected);
        assert.equal(req.headers.cookie, undefined);
        assert.equal(headers.get("cookie"), null);
    }
});
test("both proxy paths authenticate GET and HEAD on exact music lease routes", () => {
    for (const method of ["GET", "HEAD"]) {
        const req = {
            method,
            url: path,
            headers: { cookie: "soundspan_media_auth=test-access" } as Record<
                string,
                string
            >,
        };
        prepareProxyAuthentication(req);
        assert.equal(req.headers.authorization, "Bearer test-access");
        assert.equal(req.headers.cookie, undefined);
        const headers = new Headers({
            cookie: "soundspan_media_auth=test-access",
        });
        prepareFetchProxyAuthentication(path, headers, method);
        assert.equal(headers.get("authorization"), "Bearer test-access");
    }
});
test("music source management and malformed lease URLs never gain cookie authentication", () => {
    for (const [method, url] of [
        ["PUT", "/api/music-sources/connections/vk"],
        ["GET", "/api/music-sources/connections"],
        ["POST", path],
        ["GET", path + "/other"],
    ]) {
        const req = {
            method,
            url,
            headers: { cookie: "soundspan_media_auth=test-access" } as Record<
                string,
                string
            >,
        };
        prepareProxyAuthentication(req);
        assert.equal(req.headers.authorization, undefined);
    }
});
