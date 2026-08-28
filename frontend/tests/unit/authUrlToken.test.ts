import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { replaceAuthTokenFromCurrentUrl } from "../../lib/auth-url-token";

GlobalRegistrator.register({ url: "https://soundspan.test/" });

beforeEach(() => {
    window.history.replaceState({}, "", "/");
});

after(async () => {
    await GlobalRegistrator.unregister();
});

test("URL credential is removed before a restricted storage write can fail", () => {
    window.history.replaceState(
        { route: "login" },
        "",
        "/callback?keep=one&token=jwt.secret&other=two#player",
    );
    const calls: string[] = [];

    assert.throws(
        () =>
            replaceAuthTokenFromCurrentUrl({
                revokeRuntime: () => {
                    assert.equal(
                        window.location.href,
                        "https://soundspan.test/callback?keep=one&other=two#player",
                    );
                    calls.push("revoke");
                },
                setToken: (token) => {
                    assert.equal(
                        window.location.search.includes("token="),
                        false,
                    );
                    calls.push(`set:${token}`);
                    throw new DOMException(
                        "Storage is unavailable",
                        "SecurityError",
                    );
                },
            }),
        { name: "SecurityError" },
    );

    assert.deepEqual(calls, ["revoke", "set:jwt.secret"]);
    assert.equal(window.location.search, "?keep=one&other=two");
    assert.equal(window.location.hash, "#player");
    assert.deepEqual(window.history.state, { route: "login" });
});
