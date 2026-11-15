import { z } from "zod";

const TTL_SECONDS = 24 * 60 * 60;
const MAX_BINDINGS_PER_BEARER = 16;
const REDIS_DEADLINE_MS = 1500;
const PREFIX = "soundspan:dashboard:v1:";
const opaqueId = z.string().regex(/^[a-f0-9]{48}$/);
const bearerHash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z
    .object({
        ownerId: z.string().min(1).max(256),
        tokenVersion: z.number().int().nonnegative(),
        epoch: opaqueId,
        grantNonce: opaqueId.nullable(),
        bearerHash,
    })
    .strict();

/** Non-authenticating browser binding; only a matching live grant authorizes a cookie. */
export type DashboardBinding = z.infer<typeof bindingSchema>;

/** Redis command port; the production adapter supplies a bounded command timeout. */
export interface DashboardRedis {
    readonly isReady: boolean;
    eval(
        script: string,
        options: { keys: string[]; arguments: string[] },
    ): Promise<unknown>;
}

/** Optional dashboard state is unavailable; ordinary music credentials are unaffected. */
export class DashboardStateUnavailableError extends Error {
    constructor(
        cause?: unknown,
        readonly operation = "unknown",
        readonly completionUnknown = false,
    ) {
        super(
            `Dashboard session state unavailable (${operation}${completionUnknown ? "; command outcome unknown" : ""})`,
            { cause },
        );
        this.name = "DashboardStateUnavailableError";
    }
}

const BOOTSTRAP = `
local members = redis.call('SMEMBERS', KEYS[2])
for _, id in ipairs(members) do
  if redis.call('EXISTS', ARGV[4] .. id) == 0 then redis.call('SREM', KEYS[2], id) end
end
if redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 0 end
if redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX') == false then return 0 end
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`;
const READ = `return redis.call('GET', KEYS[1])`;
const MINT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.ownerId ~= ARGV[1] or tostring(current.tokenVersion) ~= ARGV[2] or current.epoch ~= ARGV[3] then return 0 end
for _, id in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  if redis.call('EXISTS', ARGV[5] .. id) == 0 then redis.call('SREM', KEYS[2], id) end
end
if redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[6]) and redis.call('SISMEMBER', KEYS[2], ARGV[7]) == 0 then return 0 end
if type(current.grantNonce) ~= 'string' then current.grantNonce = ARGV[4] end
redis.call('SET', KEYS[1], cjson.encode(current), 'KEEPTTL')
redis.call('SADD', KEYS[2], ARGV[7])
redis.call('EXPIRE', KEYS[2], ARGV[8])
return current.grantNonce
`;
const REVOKE = `
local hashes = {}
if ARGV[1] ~= '' then hashes[ARGV[1]] = true end
local raw = redis.call('GET', KEYS[1])
if raw and ARGV[2] == '1' then
  local current = cjson.decode(raw)
  hashes[current.bearerHash] = true
end
if ARGV[2] == '1' then
  for hash, _ in pairs(hashes) do
    local association = ARGV[3] .. hash
    for _, id in ipairs(redis.call('SMEMBERS', association)) do
      redis.call('DEL', ARGV[4] .. id)
    end
    redis.call('DEL', association)
  end
end
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * Shared, bounded dashboard-only grant state. Mint is compare-and-set and never
 * recreates missing bindings. Revocation and grant creation linearize in Redis.
 */
export class DashboardSessions {
    constructor(private readonly redis: DashboardRedis) {}

    private async run(
        script: string,
        keys: string[],
        args: string[],
        operation: "bootstrap" | "read" | "mint" | "revoke",
    ): Promise<unknown> {
        if (!this.redis.isReady)
            throw new DashboardStateUnavailableError(undefined, operation);
        let deadline: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                this.redis.eval(script, { keys, arguments: args }),
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(
                        () =>
                            reject(
                                new DashboardStateUnavailableError(
                                    undefined,
                                    operation,
                                    true,
                                ),
                            ),
                        REDIS_DEADLINE_MS,
                    );
                }),
            ]);
        } catch (cause) {
            if (cause instanceof DashboardStateUnavailableError) throw cause;
            throw new DashboardStateUnavailableError(cause, operation, true);
        } finally {
            clearTimeout(deadline);
        }
    }

    /** Creates only a non-authenticating binding during an explicit bootstrap. */
    async bootstrap(id: string, binding: DashboardBinding): Promise<boolean> {
        opaqueId.parse(id);
        const value = bindingSchema.parse(binding);
        if (value.grantNonce !== null)
            throw new Error("Dashboard bootstrap cannot issue a grant");
        return (
            (await this.run(
                BOOTSTRAP,
                [
                    `${PREFIX}binding:${id}`,
                    `${PREFIX}bearer:${value.bearerHash}`,
                ],
                [
                    JSON.stringify(value),
                    String(TTL_SECONDS),
                    id,
                    `${PREFIX}binding:`,
                    String(MAX_BINDINGS_PER_BEARER),
                ],
                "bootstrap",
            )) === 1
        );
    }

    /** Missing/evicted state is not authorization and cannot be repaired by mint. */
    async read(id: string): Promise<DashboardBinding | null> {
        opaqueId.parse(id);
        const raw = await this.run(
            READ,
            [`${PREFIX}binding:${id}`],
            [],
            "read",
        );
        if (raw === null) return null;
        if (typeof raw !== "string")
            throw new DashboardStateUnavailableError(undefined, "read");
        try {
            return bindingSchema.parse(JSON.parse(raw) as unknown);
        } catch (cause) {
            throw new DashboardStateUnavailableError(cause, "read");
        }
    }

    /** Returns the shared grant nonce, or null when the binding was revoked/stale. */
    async mint(
        id: string,
        expected: Pick<DashboardBinding, "ownerId" | "tokenVersion" | "epoch">,
        nonce: string,
        credentialHash: string,
    ): Promise<string | null> {
        opaqueId.parse(id);
        opaqueId.parse(expected.epoch);
        opaqueId.parse(nonce);
        bearerHash.parse(credentialHash);
        const result = await this.run(
            MINT,
            [`${PREFIX}binding:${id}`, `${PREFIX}bearer:${credentialHash}`],
            [
                expected.ownerId,
                String(expected.tokenVersion),
                expected.epoch,
                nonce,
                `${PREFIX}binding:`,
                String(MAX_BINDINGS_PER_BEARER),
                id,
                String(TTL_SECONDS),
            ],
            "mint",
        );
        if (result === 0) return null;
        const parsed = opaqueId.safeParse(result);
        if (!parsed.success)
            throw new DashboardStateUnavailableError(undefined, "mint");
        return parsed.data;
    }

    /** Checks the exact owner/version/epoch/nonce on every cookie-backed request. */
    async grantActive(
        id: string,
        expected: Pick<DashboardBinding, "ownerId" | "tokenVersion" | "epoch">,
        nonce: string,
    ): Promise<boolean> {
        const current = await this.read(id);
        return (
            current !== null &&
            current.ownerId === expected.ownerId &&
            current.tokenVersion === expected.tokenVersion &&
            current.epoch === expected.epoch &&
            current.grantNonce === nonce
        );
    }

    /**
     * Removes a binding. Logout additionally removes bindings associated with
     * this bearer and the original bearer; ordinary access tokens remain valid.
     */
    async revoke(
        id: string | null,
        credentialHash: string | null,
        allForBearer = true,
    ): Promise<void> {
        if (id !== null) opaqueId.parse(id);
        if (credentialHash !== null) bearerHash.parse(credentialHash);
        if (id === null && credentialHash === null) return;
        await this.run(
            REVOKE,
            [`${PREFIX}binding:${id ?? "absent"}`],
            [
                credentialHash ?? "",
                allForBearer ? "1" : "0",
                `${PREFIX}bearer:`,
                `${PREFIX}binding:`,
            ],
            "revoke",
        );
    }
}
