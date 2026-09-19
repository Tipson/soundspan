import assert from "node:assert/strict";
import test from "node:test";
import {
    prepareProxyAuthentication,
    prepareFetchProxyAuthentication,
} from "../../lib/media-auth";
const path = `/api/music-sources/leases/${"a".repeat(48)}/stream`;
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
