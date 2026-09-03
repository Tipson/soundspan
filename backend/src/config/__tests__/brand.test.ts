describe("brand runtime metadata", () => {
    const originalPackageVersion = process.env.npm_package_version;

    afterEach(() => {
        if (originalPackageVersion === undefined) {
            delete process.env.npm_package_version;
        } else {
            process.env.npm_package_version = originalPackageVersion;
        }
    });

    it("uses a stable fallback version outside an npm lifecycle", () => {
        delete process.env.npm_package_version;

        jest.isolateModules(() => {
            const { BRAND_USER_AGENT } = require("../brand") as typeof import("../brand");

            expect(BRAND_USER_AGENT).toBe(
                "soundspan/1.0.0 (https://github.com/soundspan/soundspan)",
            );
        });
    });
});
