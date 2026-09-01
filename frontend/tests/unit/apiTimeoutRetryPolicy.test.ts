import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { ApiClientCore } from "../../lib/api/core";

class TestApiClient extends ApiClientCore {}

const originalFetch = globalThis.fetch;

after(() => {
    if (originalFetch) {
        globalThis.fetch = originalFetch;
    } else {
        Reflect.deleteProperty(globalThis, "fetch");
    }
});

function timeoutFetch(testContext: TestContext) {
    return testContext.mock.method(globalThis, "fetch", async () => {
        throw Object.assign(new Error("provider budget expired"), {
            status: 408,
        });
    });
}

test("a bounded aggregate request can disable the generic timeout retry", async (testContext) => {
    const client = new TestApiClient("http://soundspan.test");
    const fetchMock = timeoutFetch(testContext);

    await assert.rejects(
        client.request("/personalized/home?limit=12", {
            method: "GET",
            timeoutMs: 17_000,
            retryOnTimeout: false,
        }),
        { status: 408 },
    );

    assert.equal(fetchMock.mock.callCount(), 1);
});
