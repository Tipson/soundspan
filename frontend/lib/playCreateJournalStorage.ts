import { z } from "zod";
import type { PlayEngagementInput } from "./api/plays";
import {
    projectPlayCreatePayload,
    readPlayCreateKey,
    type PlayCreatePayload,
} from "./playCreateJournal";

const nonce = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const epoch = z.number().int().min(0).max(2_147_483_647);
const time = z.number().finite().nonnegative().max(8_640_000_000_000_000);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z
    .object({
        ownerId: z.string().min(1).max(128),
        loginNonce: nonce,
        historyEpoch: epoch,
    })
    .strict();
const leaseSchema = scopeSchema.extend({ leaseNonce: nonce }).strict();
const metadataSchema = leaseSchema
    .extend({
        version: z.literal(1),
        revoked: z.boolean(),
        holdoffUntilMs: time,
    })
    .strict();
const totalsSchema = z
    .object({
        listenedSeconds: z.number().finite().min(0).max(86_400),
        completionRatio: z.number().finite().min(0).max(1),
        outcome: z.enum(["failed", "skipped", "meaningful", "completed"]),
    })
    .strict();
const claimSchema = z
    .object({ token: nonce, expiresAtServerMs: time })
    .strict();
const rowSchema = leaseSchema
    .extend({
        version: z.literal(1),
        key: z.string().max(64),
        source: z.enum(["youtube", "vk", "yandex"]),
        wireJson: z.string().max(65_536),
        state: z.enum(["ready", "unknown", "known", "terminal"]),
        createAttempts: z.number().int().min(0).max(3),
        createClaim: claimSchema.nullable(),
        playId: z.string().min(1).max(128).nullable(),
        maxServerNowMs: time,
        holdoffUntilMs: time,
        totals: totalsSchema.nullable(),
        engagementRevision: revision,
        ackRevision: revision,
        patchClaim: claimSchema.extend({ revision }).strict().nullable(),
        final: z.boolean(),
    })
    .strict();
type Metadata = z.infer<typeof metadataSchema>;

/** Logical owner scope comes from a verified online identity, never cached UI. */
export type PlayCreateStorageScope = z.infer<typeof scopeSchema>;
/** Shared durable scope; same-login tabs reuse it, while revoke changes its authority. */
export type PlayCreateStorageLease = Readonly<z.infer<typeof leaseSchema>>;
/** Private DTO and absolute engagement share one IndexedDB transaction. */
export type PlayCreateStoredRow = z.infer<typeof rowSchema>;

const databaseName = "soundspan-play-create-journal-v1";
const rowsName = "rows";
const metadataName = "metadata";
const metadataKey = "active";
const maxRows = 100;
const claimLifetimeMs = 120_000;
const automaticCreateAgeMs = 600_000;
const outcomes = ["failed", "skipped", "meaningful", "completed"] as const;

function matches(
    a: PlayCreateStorageLease,
    b: PlayCreateStorageLease,
): boolean {
    return (
        a.ownerId === b.ownerId &&
        a.loginNonce === b.loginNonce &&
        a.historyEpoch === b.historyEpoch &&
        a.leaseNonce === b.leaseNonce
    );
}
function parseRow(raw: unknown): PlayCreateStoredRow | null {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) return null;
    const row = parsed.data,
        key = readPlayCreateKey(row.key);
    let projected: PlayCreatePayload | null;
    try {
        projected = projectPlayCreatePayload(JSON.parse(row.wireJson));
    } catch {
        return null;
    }
    if (
        !key ||
        key.epoch !== row.historyEpoch ||
        !projected ||
        projected.source !== row.source ||
        projected.wireJson !== row.wireJson ||
        row.ackRevision > row.engagementRevision ||
        (row.final && row.totals === null) ||
        (row.state === "known"
            ? !row.playId || row.createClaim !== null
            : row.playId !== null) ||
        (row.createClaim !== null && row.state !== "unknown") ||
        (row.patchClaim !== null &&
            (row.state !== "known" ||
                row.totals === null ||
                row.patchClaim.revision > row.engagementRevision ||
                row.patchClaim.revision <= row.ackRevision))
    )
        return null;
    return row;
}

/** Conditional storage only: admission/HTTP/retry scheduling belongs to the runtime adapter. */
export class PlayCreateJournalStorage {
    private opening: Promise<IDBDatabase> | null = null;
    private closed = false;
    constructor(
        private readonly options: {
            databaseName?: string;
            indexedDB?: IDBFactory;
            isCurrent: (scope: PlayCreateStorageScope) => boolean;
        },
    ) {}

    private current(scope: PlayCreateStorageScope): boolean {
        try {
            return !this.closed && this.options.isCurrent(scope) === true;
        } catch {
            return false;
        }
    }
    private database(): Promise<IDBDatabase> {
        if (this.closed)
            return Promise.reject(new Error("Play journal closed"));
        if (this.opening) return this.opening;
        const attempt = new Promise<IDBDatabase>((resolve, reject) => {
            let settled = false;
            const request = (this.options.indexedDB ?? indexedDB).open(
                this.options.databaseName ?? databaseName,
                1,
            );
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error("Play journal open timed out"));
                }
            }, 5000);
            request.onupgradeneeded = () => {
                const db = request.result;
                db.createObjectStore(rowsName, { keyPath: "key" });
                db.createObjectStore(metadataName);
            };
            request.onsuccess = () => {
                const db = request.result;
                if (settled) {
                    db.close();
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (this.closed) {
                    db.close();
                    reject(new Error("Play journal closed"));
                    return;
                }
                db.onversionchange = () => {
                    db.close();
                    this.opening = null;
                };
                resolve(db);
            };
            const failed = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error("Play journal unavailable"));
            };
            request.onerror = failed;
            request.onblocked = failed;
        });
        const retryable = attempt.catch((error: unknown) => {
            if (this.opening === retryable) this.opening = null;
            throw error;
        });
        this.opening = retryable;
        return retryable;
    }

    private async transaction<T>(
        scope: PlayCreateStorageScope,
        update: (
            metadata: Metadata | null,
            rows: PlayCreateStoredRow[],
            stores: { rows: IDBObjectStore; metadata: IDBObjectStore },
        ) => T,
    ): Promise<T | null> {
        if (!this.current(scope)) return null;
        const db = await this.database();
        if (!this.current(scope)) return null;
        return new Promise<T | null>((resolve, reject) => {
            const tx = db.transaction([rowsName, metadataName], "readwrite");
            const stores = {
                rows: tx.objectStore(rowsName),
                metadata: tx.objectStore(metadataName),
            };
            let result: T | null = null,
                metaReady = false,
                rowsReady = false,
                metaRaw: unknown,
                rowsRaw: unknown[] = [];
            const timer = setTimeout(() => {
                try {
                    tx.abort();
                } catch {
                    /* Already settled. */
                }
            }, 5000);
            tx.oncomplete = () => {
                clearTimeout(timer);
                resolve(this.current(scope) ? result : null);
            };
            tx.onerror = tx.onabort = () => {
                clearTimeout(timer);
                reject(new Error("Play journal transaction unavailable"));
            };
            const apply = () => {
                if (!metaReady || !rowsReady || !this.current(scope)) return;
                if (rowsRaw.length > maxRows) return;
                const parsedMeta =
                    metaRaw === undefined
                        ? null
                        : metadataSchema.safeParse(metaRaw);
                if (parsedMeta !== null && !parsedMeta.success) return;
                const rows: PlayCreateStoredRow[] = [];
                for (const raw of rowsRaw) {
                    const row = parseRow(raw);
                    if (!row) return;
                    rows.push(row);
                }
                try {
                    result = update(
                        parsedMeta === null ? null : parsedMeta.data,
                        rows,
                        stores,
                    );
                } catch {
                    tx.abort();
                }
            };
            const metaRequest = stores.metadata.get(metadataKey);
            metaRequest.onsuccess = () => {
                metaReady = true;
                metaRaw = metaRequest.result;
                apply();
            };
            const rowsRequest = stores.rows.getAll(undefined, maxRows + 1);
            rowsRequest.onsuccess = () => {
                rowsReady = true;
                rowsRaw = rowsRequest.result;
                apply();
            };
        });
    }

    private withLease<T>(
        lease: PlayCreateStorageLease,
        update: (
            metadata: Metadata,
            rows: PlayCreateStoredRow[],
            stores: { rows: IDBObjectStore; metadata: IDBObjectStore },
        ) => T,
    ): Promise<T | null> {
        const captured = leaseSchema.safeParse(lease);
        if (!captured.success) return Promise.resolve(null);
        return this.transaction<T | null>(
            captured.data,
            (metadata, rows, stores) => {
                if (
                    !metadata ||
                    metadata.revoked ||
                    !matches(metadata, captured.data) ||
                    rows.some((row) => !matches(row, captured.data))
                )
                    return null;
                return update(metadata, rows, stores);
            },
        );
    }

    /** Activate only after fresh verified identity/capability; this does not authorize HTTP. */
    async activateLease(
        scope: PlayCreateStorageScope,
        leaseNonce: string,
    ): Promise<PlayCreateStorageLease | null> {
        const parsed = scopeSchema.safeParse(scope);
        if (!parsed.success || !nonce.safeParse(leaseNonce).success)
            return null;
        const captured = parsed.data;
        return this.transaction(captured, (metadata, _rows, stores) => {
            if (
                metadata &&
                metadata.ownerId === captured.ownerId &&
                metadata.historyEpoch > captured.historyEpoch
            )
                return null;
            if (
                metadata &&
                metadata.ownerId === captured.ownerId &&
                metadata.loginNonce === captured.loginNonce &&
                metadata.historyEpoch === captured.historyEpoch
            ) {
                if (metadata.revoked) return null;
                return Object.freeze({
                    ownerId: metadata.ownerId,
                    loginNonce: metadata.loginNonce,
                    historyEpoch: metadata.historyEpoch,
                    leaseNonce: metadata.leaseNonce,
                });
            }
            const lease = { ...captured, leaseNonce };
            stores.rows.clear();
            stores.metadata.put(
                { ...lease, version: 1, revoked: false, holdoffUntilMs: 0 },
                metadataKey,
            );
            return Object.freeze(lease);
        });
    }

    /** Bounded owner-local snapshot, never records belonging to another lease. */
    async list(
        lease: PlayCreateStorageLease,
    ): Promise<PlayCreateStoredRow[] | null> {
        return (await this.snapshot(lease))?.rows ?? null;
    }

    /** The coordinator can schedule one wake from the same atomic rows/holdoff snapshot. */
    snapshot(lease: PlayCreateStorageLease): Promise<{
        rows: PlayCreateStoredRow[];
        sharedHoldoffUntilMs: number;
    } | null> {
        return this.withLease(lease, (metadata, rows) => ({
            rows,
            sharedHoldoffUntilMs: metadata.holdoffUntilMs,
        }));
    }

    /** Insert the already frozen DTO once; a colliding key never overwrites an obligation. */
    async insertReady(
        lease: PlayCreateStorageLease,
        input: { key: string; payload: PlayCreatePayload },
    ): Promise<boolean> {
        const key = readPlayCreateKey(input.key);
        let payload: PlayCreatePayload | null;
        try {
            payload = projectPlayCreatePayload(
                JSON.parse(input.payload.wireJson),
            );
        } catch {
            return false;
        }
        if (
            !key ||
            key.epoch !== lease.historyEpoch ||
            !payload ||
            payload.source !== input.payload.source ||
            payload.wireJson !== input.payload.wireJson
        )
            return false;
        return (
            (await this.withLease(lease, (metadata, rows, stores) => {
                if (
                    rows.length >= maxRows ||
                    rows.some((row) => row.key === key.value)
                )
                    return false;
                stores.rows.add({
                    ownerId: metadata.ownerId,
                    loginNonce: metadata.loginNonce,
                    historyEpoch: metadata.historyEpoch,
                    leaseNonce: metadata.leaseNonce,
                    version: 1,
                    key: key.value,
                    ...payload,
                    state: "ready",
                    createAttempts: 0,
                    createClaim: null,
                    playId: null,
                    maxServerNowMs: key.issuedAtMs,
                    holdoffUntilMs: 0,
                    totals: null,
                    engagementRevision: 0,
                    ackRevision: 0,
                    patchClaim: null,
                    final: false,
                });
                return true;
            })) === true
        );
    }

    /** Reserve before wire handoff; claim token and engagement revision are separate CAS domains. */
    async reserveCreate(
        lease: PlayCreateStorageLease,
        key: string,
        token: string,
        serverNowMs: number,
    ): Promise<PlayCreateStoredRow | null> {
        if (
            !nonce.safeParse(token).success ||
            !time.safeParse(serverNowMs).success
        )
            return null;
        return this.withLease(lease, (metadata, rows, stores) => {
            const row = rows.find((value) => value.key === key),
                decoded = readPlayCreateKey(key);
            if (
                !row ||
                !decoded ||
                row.state === "known" ||
                row.state === "terminal"
            )
                return null;
            const now = Math.max(serverNowMs, row.maxServerNowMs);
            if (now >= decoded.expiresAtMs) {
                stores.rows.delete(key);
                return null;
            }
            if (row.createClaim && row.createClaim.expiresAtServerMs > now)
                return null;
            if (
                row.createAttempts >= 3 ||
                now - decoded.issuedAtMs >= automaticCreateAgeMs
            ) {
                stores.rows.put({
                    ...row,
                    state: "terminal",
                    createClaim: null,
                    maxServerNowMs: now,
                });
                return null;
            }
            if (Math.max(metadata.holdoffUntilMs, row.holdoffUntilMs) > now)
                return null;
            const next: PlayCreateStoredRow = {
                ...row,
                state: "unknown",
                createAttempts: row.createAttempts + 1,
                maxServerNowMs: now,
                createClaim: {
                    token,
                    expiresAtServerMs: Math.min(
                        decoded.expiresAtMs,
                        now + claimLifetimeMs,
                    ),
                },
            };
            stores.rows.put(next);
            return next;
        });
    }

    /** Matching create ACK reads the latest totals and never upserts a revoked/missing row. */
    async acknowledgeCreate(
        lease: PlayCreateStorageLease,
        key: string,
        token: string,
        playId: string,
    ): Promise<boolean> {
        if (
            !nonce.safeParse(token).success ||
            !z.string().trim().min(1).max(128).safeParse(playId).success ||
            playId.trim() !== playId
        )
            return false;
        return (
            (await this.withLease(lease, (_metadata, rows, stores) => {
                const row = rows.find((value) => value.key === key);
                if (
                    !row ||
                    row.state !== "unknown" ||
                    row.createClaim?.token !== token
                )
                    return false;
                stores.rows.put({
                    ...row,
                    state: "known",
                    playId,
                    createClaim: null,
                });
                return true;
            })) === true
        );
    }

    /** Absolute maxima and finality survive an in-flight create or PATCH response. */
    async mergeEngagement(
        lease: PlayCreateStorageLease,
        key: string,
        input: PlayEngagementInput,
        final: boolean,
    ): Promise<boolean> {
        const parsed = totalsSchema.safeParse(input);
        if (!parsed.success || typeof final !== "boolean") return false;
        return (
            (await this.withLease(lease, (_metadata, rows, stores) => {
                const row = rows.find((value) => value.key === key);
                if (
                    !row ||
                    row.state === "terminal" ||
                    row.engagementRevision === Number.MAX_SAFE_INTEGER
                )
                    return false;
                const prior = row.totals;
                const totals = prior
                    ? {
                          listenedSeconds: Math.max(
                              prior.listenedSeconds,
                              parsed.data.listenedSeconds,
                          ),
                          completionRatio: Math.max(
                              prior.completionRatio,
                              parsed.data.completionRatio,
                          ),
                          outcome:
                              outcomes[
                                  Math.max(
                                      outcomes.indexOf(prior.outcome),
                                      outcomes.indexOf(parsed.data.outcome),
                                  )
                              ],
                      }
                    : parsed.data;
                if (
                    prior &&
                    totals.listenedSeconds === prior.listenedSeconds &&
                    totals.completionRatio === prior.completionRatio &&
                    totals.outcome === prior.outcome &&
                    (row.final || !final)
                )
                    return true;
                stores.rows.put({
                    ...row,
                    totals,
                    final: row.final || final,
                    engagementRevision: row.engagementRevision + 1,
                });
                return true;
            })) === true
        );
    }

    /** Claim a snapshot revision; another tab's non-final run remains a valid obligation. */
    async reservePatch(
        lease: PlayCreateStorageLease,
        key: string,
        token: string,
        serverNowMs: number,
    ): Promise<PlayCreateStoredRow | null> {
        if (
            !nonce.safeParse(token).success ||
            !time.safeParse(serverNowMs).success
        )
            return null;
        return this.withLease(lease, (metadata, rows, stores) => {
            const row = rows.find((value) => value.key === key),
                decoded = readPlayCreateKey(key);
            if (
                !row ||
                !decoded ||
                row.state !== "known" ||
                !row.totals ||
                row.engagementRevision <= row.ackRevision
            )
                return null;
            const now = Math.max(serverNowMs, row.maxServerNowMs);
            if (now >= decoded.expiresAtMs) {
                stores.rows.delete(key);
                return null;
            }
            if (
                Math.max(metadata.holdoffUntilMs, row.holdoffUntilMs) > now ||
                (row.patchClaim && row.patchClaim.expiresAtServerMs > now)
            )
                return null;
            const next = {
                ...row,
                maxServerNowMs: now,
                patchClaim: {
                    token,
                    revision: row.engagementRevision,
                    expiresAtServerMs: Math.min(
                        decoded.expiresAtMs,
                        now + claimLifetimeMs,
                    ),
                },
            };
            stores.rows.put(next);
            return next;
        });
    }

    /** Delete only the latest final revision; progress committed during the request survives. */
    async acknowledgePatch(
        lease: PlayCreateStorageLease,
        key: string,
        token: string,
    ): Promise<boolean> {
        return (
            (await this.withLease(lease, (_metadata, rows, stores) => {
                const row = rows.find((value) => value.key === key);
                if (
                    !row ||
                    row.state !== "known" ||
                    !row.patchClaim ||
                    row.patchClaim.token !== token
                )
                    return false;
                const ackRevision = row.patchClaim.revision;
                if (row.final && ackRevision === row.engagementRevision)
                    stores.rows.delete(key);
                else stores.rows.put({ ...row, ackRevision, patchClaim: null });
                return true;
            })) === true
        );
    }

    /** Release only the matching flight; rate-limit holdoff is shared durably by this lease. */
    async settleFailure(
        lease: PlayCreateStorageLease,
        key: string,
        failure: {
            kind: "create" | "patch";
            token: string;
            serverNowMs: number;
            retryAfterUntilMs: number;
            shared: boolean;
            terminal: boolean;
        },
    ): Promise<boolean> {
        const parsed = z
            .object({
                kind: z.enum(["create", "patch"]),
                token: nonce,
                serverNowMs: time,
                retryAfterUntilMs: time,
                shared: z.boolean(),
                terminal: z.boolean(),
            })
            .strict()
            .safeParse(failure);
        if (!parsed.success) return false;
        const captured = parsed.data;
        return (
            (await this.withLease(lease, (metadata, rows, stores) => {
                const row = rows.find((value) => value.key === key),
                    decoded = readPlayCreateKey(key);
                if (!row || !decoded) return false;
                const claim =
                    captured.kind === "create"
                        ? row.createClaim
                        : row.patchClaim;
                if (
                    !claim ||
                    claim.token !== captured.token ||
                    (captured.kind === "create"
                        ? row.state !== "unknown"
                        : row.state !== "known")
                )
                    return false;
                const now = Math.max(row.maxServerNowMs, captured.serverNowMs);
                const holdoff = Math.min(
                    decoded.expiresAtMs,
                    Math.max(
                        now,
                        captured.retryAfterUntilMs,
                        row.holdoffUntilMs,
                    ),
                );
                stores.rows.put({
                    ...row,
                    state: captured.terminal ? "terminal" : row.state,
                    playId: captured.terminal ? null : row.playId,
                    createClaim:
                        captured.kind === "create" || captured.terminal
                            ? null
                            : row.createClaim,
                    patchClaim:
                        captured.kind === "patch" || captured.terminal
                            ? null
                            : row.patchClaim,
                    maxServerNowMs: now,
                    holdoffUntilMs: holdoff,
                });
                if (captured.shared)
                    stores.metadata.put(
                        {
                            ...metadata,
                            holdoffUntilMs: Math.max(
                                metadata.holdoffUntilMs,
                                holdoff,
                            ),
                        },
                        metadataKey,
                    );
                return true;
            })) === true
        );
    }

    /** Remove expired obligations without evicting an unexpired unknown run to make space. */
    async pruneExpired(
        lease: PlayCreateStorageLease,
        serverNowMs: number,
    ): Promise<number | null> {
        if (!time.safeParse(serverNowMs).success) return null;
        return this.withLease(lease, (_metadata, rows, stores) => {
            let removed = 0;
            for (const row of rows) {
                const decoded = readPlayCreateKey(row.key)!;
                const now = Math.max(serverNowMs, row.maxServerNowMs);
                if (now >= decoded.expiresAtMs) {
                    stores.rows.delete(row.key);
                    removed++;
                } else if (now > row.maxServerNowMs)
                    stores.rows.put({ ...row, maxServerNowMs: now });
            }
            return removed;
        });
    }

    /** Logical history/logout revoke is atomic with removal and conditional on the old lease. */
    async retireLease(lease: PlayCreateStorageLease): Promise<boolean> {
        return (
            (await this.withLease(lease, (metadata, _rows, stores) => {
                stores.metadata.put(
                    { ...metadata, revoked: true, holdoffUntilMs: 0 },
                    metadataKey,
                );
                stores.rows.clear();
                return true;
            })) === true
        );
    }

    /** Close only this tab's handle; persisted obligations remain available after reload. */
    async close(): Promise<void> {
        this.closed = true;
        const db = await this.opening?.catch(() => null);
        db?.close();
        this.opening = null;
    }
}

/** Create an isolated handle without opening, migrating, or clearing other offline databases. */
export function createPlayCreateJournalStorage(
    options: ConstructorParameters<typeof PlayCreateJournalStorage>[0],
): PlayCreateJournalStorage {
    return new PlayCreateJournalStorage(options);
}
