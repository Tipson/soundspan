const test = require("node:test");
const assert = require("node:assert/strict");
const contract = require("../dist/index.js");

test("Audius identity survives normalization without local or YouTube substitution", () => {
    const provider = contract.normalizeCanonicalMediaProviderIdentity({
        mediaSource: "audius",
        providerTrackId: "7AlA9",
        youtubeVideoId: "unrelated",
    });
    assert.deepEqual(provider, { source: "audius", providerTrackId: "7AlA9" });
    assert.deepEqual(contract.toLegacyStreamFields(provider), {
        streamSource: "audius",
    });
    assert.equal(contract.toAudioEngineSourceType(provider.source), "audius");
});

test("Audius media policy permits only explicit content origins and provider-only signed CID streams", () => {
    const path =
        "/tracks/cidstream/QmQqUCXvUESsp6j5Dp36n3i679q71UG9UNBMjT376cWRbb?signature=provider-only&skip_play_count=true";
    for (const origin of contract.AUDIUS_MEDIA_ORIGINS.slice(0, 3))
        assert.equal(contract.isAllowedAudiusStreamUrl(origin + path), true);
    const origin = contract.AUDIUS_MEDIA_ORIGINS[0];
    assert.equal(
        contract.isAllowedAudiusStreamUrl(
            origin +
                path.replace(
                    "provider-only",
                    encodeURIComponent(
                        JSON.stringify({
                            data: "fixture",
                            signature: "provider-signature",
                        }),
                    ),
                ),
        ),
        true,
    );
    for (const value of [
        "https://unknown.test" + path,
        "https://creatornode.audius.co.evil.test" + path,
        origin + path + "&token=private",
        origin + path + "&signature=duplicate",
        origin + "/private",
        origin + path + "#hash",
        origin.replace("https:", "http:") + path,
        origin.replace("https://", "https://user:pass@") + path,
    ])
        assert.equal(contract.isAllowedAudiusStreamUrl(value), false);
});

const cdnOrigin =
    "https://validator.eeba4a6ca56a0d87af802270217c2a51.r2.cloudflarestorage.com";
const cid = "QmQqUCXvUESsp6j5Dp36n3i679q71UG9UNBMjT376cWRbb";
const cdnParams = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Checksum-Mode": "ENABLED",
    "X-Amz-Credential": "a".repeat(32) + "/20260905/ENAM/s3/aws4_request",
    "X-Amz-Date": "20260905T135000Z",
    "X-Amz-Expires": "7200",
    "X-Amz-SignedHeaders": "host",
    "X-Amz-Signature": "b".repeat(64),
    "x-id": "GetObject",
});
test("Audius CDN permits only the observed exact-origin signed GET contract", () => {
    const url = `${cdnOrigin}/WRb/${cid}?${cdnParams}`;
    assert.equal(contract.isAllowedAudiusStreamUrl(url), true);
    assert.equal(contract.isAllowedAudiusCdnUrl(url), true);
    assert.equal(contract.isAllowedAudiusContentNodeUrl(url), false);
    assert.ok(contract.AUDIUS_MEDIA_ORIGINS.includes(cdnOrigin));
    for (const invalid of [
        url.replace("validator.", "other."),
        url.replace("/WRb/", "/other/"),
        url + "&token=soundspan",
        url + "&X-Amz-Signature=duplicate",
        url + "#fragment",
        url.replace("https://", "https://user:pass@"),
        url.replace(cid, "%2e%2e/" + cid),
        url.replace("https:", "http:"),
    ])
        assert.equal(contract.isAllowedAudiusStreamUrl(invalid), false);
    for (const [key, value] of [
        ["X-Amz-SignedHeaders", "host;authorization"],
        ["X-Amz-Expires", "7201"],
        ["X-Amz-Expires", "0"],
        ["X-Amz-Algorithm", "other"],
        ["x-id", "PutObject"],
        ["X-Amz-Checksum-Mode", "DISABLED"],
        ["X-Amz-Signature", "private-token"],
        ["X-Amz-Credential", "a".repeat(32) + "/20260906/ENAM/s3/aws4_request"],
        ["X-Amz-Date", "20269999T999999Z"],
    ]) {
        const changed = new URL(url);
        changed.searchParams.set(key, value);
        assert.equal(
            contract.isAllowedAudiusStreamUrl(changed.href),
            false,
            key,
        );
    }
    for (const key of cdnParams.keys()) {
        const changed = new URL(url);
        changed.searchParams.delete(key);
        assert.equal(
            contract.isAllowedAudiusStreamUrl(changed.href),
            false,
            key,
        );
    }
});
