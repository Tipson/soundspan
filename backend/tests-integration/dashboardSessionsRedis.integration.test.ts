import { randomBytes, createHash } from "node:crypto";
import { createClient } from "redis";
import { DashboardSessions } from "../src/utils/dashboardSessions";

const redisUrl = process.env.INTEGRATION_REDIS_URL;
const suite =
    redisUrl && process.env.DASHBOARD_ISOLATED_REDIS === "1"
        ? describe
        : describe.skip;

suite("dashboard grants on an explicitly isolated Redis fixture", () => {
    const client = createClient({
        url: redisUrl,
        socket: { reconnectStrategy: false },
        disableOfflineQueue: true,
    });
    const second = createClient({
        url: redisUrl,
        socket: { reconnectStrategy: false },
        disableOfflineQueue: true,
    });
    const sessions = new DashboardSessions(client);
    const otherApi = new DashboardSessions(second);
    const opaque = () => randomBytes(24).toString("hex");
    const credential = () =>
        createHash("sha256").update(opaque()).digest("hex");

    beforeAll(async () => {
        if (!redisUrl || new URL(redisUrl).hostname !== "127.0.0.1")
            throw new Error("Explicit loopback isolated Redis required");
        await Promise.all([client.connect(), second.connect()]);
    });
    beforeEach(async () => {
        await client.flushDb();
    });
    afterAll(async () => {
        await client.flushDb();
        client.destroy();
        second.destroy();
    });

    async function binding() {
        const id = opaque();
        const value = {
            ownerId: "admin-1",
            tokenVersion: 2,
            epoch: opaque(),
            grantNonce: null,
            bearerHash: credential(),
        };
        expect(await sessions.bootstrap(id, value)).toBe(true);
        return { id, value };
    }

    test("a second API instance observes a committed grant and scoped logout", async () => {
        const { id, value } = await binding();
        const nonce = opaque();
        expect(await sessions.mint(id, value, nonce, value.bearerHash)).toBe(
            nonce,
        );
        expect(await otherApi.grantActive(id, value, nonce)).toBe(true);
        await otherApi.revoke(id, value.bearerHash);
        expect(await sessions.grantActive(id, value, nonce)).toBe(false);
        expect(
            await sessions.mint(id, value, opaque(), value.bearerHash),
        ).toBeNull();
    });

    test("a late bootstrap after logout contains no authenticating grant", async () => {
        const hash = credential();
        await otherApi.revoke(null, hash);
        const lateId = opaque();
        const lateBinding = {
            ownerId: "admin-1",
            tokenVersion: 2,
            epoch: opaque(),
            grantNonce: null,
            bearerHash: hash,
        };
        expect(await sessions.bootstrap(lateId, lateBinding)).toBe(true);
        expect(await sessions.grantActive(lateId, lateBinding, opaque())).toBe(
            false,
        );
        const independent = await binding();
        const independentNonce = opaque();
        expect(
            await sessions.mint(
                independent.id,
                independent.value,
                independentNonce,
                independent.value.bearerHash,
            ),
        ).toBe(independentNonce);
    });

    test("end access kills delayed mint while allowing an explicit fresh bootstrap", async () => {
        const { id, value } = await binding();
        await otherApi.revoke(id, null, false);
        expect(
            await sessions.mint(id, value, opaque(), value.bearerHash),
        ).toBeNull();
        expect(
            await sessions.bootstrap(opaque(), { ...value, epoch: opaque() }),
        ).toBe(true);
    });

    test("owner, token version, epoch and nonce cannot be substituted", async () => {
        const { id, value } = await binding();
        expect(
            await sessions.mint(
                id,
                { ...value, ownerId: "other" },
                opaque(),
                value.bearerHash,
            ),
        ).toBeNull();
        expect(
            await sessions.mint(
                id,
                { ...value, tokenVersion: 3 },
                opaque(),
                value.bearerHash,
            ),
        ).toBeNull();
        expect(
            await sessions.mint(
                id,
                { ...value, epoch: opaque() },
                opaque(),
                value.bearerHash,
            ),
        ).toBeNull();
        expect(await sessions.grantActive(id, value, opaque())).toBe(false);
    });

    test("bootstrap cannot install an authenticating grant nonce", async () => {
        const { value } = await binding();
        await expect(
            sessions.bootstrap(opaque(), { ...value, grantNonce: opaque() }),
        ).rejects.toThrow("bootstrap cannot issue a grant");
    });

    test("data loss never lets mint or guard recreate an old binding", async () => {
        const { id, value } = await binding();
        const nonce = opaque();
        expect(await sessions.mint(id, value, nonce, value.bearerHash)).toBe(
            nonce,
        );
        await client.flushDb();
        expect(await otherApi.grantActive(id, value, nonce)).toBe(false);
        expect(
            await otherApi.mint(id, value, nonce, value.bearerHash),
        ).toBeNull();
        expect(await sessions.read(id)).toBeNull();
    });

    test("all bounded bindings associated with one bearer are retired together", async () => {
        const hash = credential();
        const ids = Array.from({ length: 16 }, () => opaque());
        const value = {
            ownerId: "admin-1",
            tokenVersion: 2,
            epoch: opaque(),
            grantNonce: null,
            bearerHash: hash,
        };
        for (const id of ids)
            expect(await sessions.bootstrap(id, value)).toBe(true);
        expect(await sessions.bootstrap(opaque(), value)).toBe(false);
        await otherApi.revoke(null, hash);
        for (const id of ids)
            expect(await sessions.mint(id, value, opaque(), hash)).toBeNull();
    });

    test("restart of the API object does not forget shared Redis revocation", async () => {
        const { id, value } = await binding();
        await sessions.revoke(id, value.bearerHash);
        const restartedApi = new DashboardSessions(second);
        expect(
            await restartedApi.mint(id, value, opaque(), value.bearerHash),
        ).toBeNull();
    });
});
