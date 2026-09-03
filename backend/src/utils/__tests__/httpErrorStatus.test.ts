import { getHttpErrorStatus } from "../httpErrorStatus";

describe("getHttpErrorStatus", () => {
    test.each([
        ["primitive errors", "network failed"],
        ["null", null],
        ["objects without a response", {}],
        ["primitive responses", { response: "gateway failed" }],
        ["null responses", { response: null }],
        ["responses without a status", { response: {} }],
        ["non-numeric statuses", { response: { status: "503" } }],
    ])("returns undefined for %s", (_description, error) => {
        expect(getHttpErrorStatus(error)).toBeUndefined();
    });

    it("returns a numeric status from an Axios-style response", () => {
        expect(getHttpErrorStatus({ response: { status: 503 } })).toBe(503);
    });
});
