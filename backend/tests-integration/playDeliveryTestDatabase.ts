import { Client } from "pg";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    applyScaleMigrations,
    scaleAdminDatabaseUrl,
} from "./scaleTestDatabase";

const namePattern = /^dev08_delivery_\d+_\d+$/;

/** Creates only this phase's explicit database; does not inspect other consumers. */
export async function createPlayDeliveryTestDatabase(
    adminUrl: string,
    mode: "migrate-deploy" | "schema-fixture" = "migrate-deploy",
) {
    const target = new URL(adminUrl);
    const precreated = mode === "schema-fixture";
    const name = precreated
        ? target.pathname.slice(1)
        : `dev08_delivery_${process.pid}_${Date.now()}`;
    if (!namePattern.test(name))
        throw new Error("Unsafe delivery test database name");
    const administrative = new URL(adminUrl);
    if (precreated) administrative.pathname = "/dev08_admin";
    const admin = new Client({
        connectionString: scaleAdminDatabaseUrl(administrative.toString()),
    });
    await admin.connect();
    let created = false;
    const close = async () => {
        try {
            if (created)
                await admin.query(
                    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
                );
        } finally {
            await admin.end();
        }
    };
    try {
        if (!precreated) await admin.query(`CREATE DATABASE "${name}"`);
        created = true;
        const url = new URL(adminUrl);
        url.pathname = `/${name}`;
        process.env.DATABASE_URL = url.toString();
        if (mode === "schema-fixture")
            await inspectPlayDeliverySchemaFixture(url.toString());
        else await applyScaleMigrations(url.toString(), 600_000);
        return { name, close };
    } catch (error) {
        await close();
        throw error;
    }
}

/** Inspects a native-psql precreated fixture; never claims Prisma migrate deploy success. */
export async function inspectPlayDeliverySchemaFixture(
    databaseUrl: string,
): Promise<void> {
    const database = new Client({ connectionString: databaseUrl });
    await database.connect();
    try {
        const directory = join(__dirname, "../prisma/migrations");
        const migrations = readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        const checksums: Array<{ name: string; sha256: string }> = [];
        for (const name of migrations) {
            const sql = readFileSync(
                join(directory, name, "migration.sql"),
                "utf8",
            );
            checksums.push({
                name,
                sha256: createHash("sha256").update(sql).digest("hex"),
            });
        }
        const expected = JSON.parse(
            readFileSync(
                join(__dirname, ".play-delivery-sql-manifest.json"),
                "utf8",
            ),
        ) as {
            setup?: string;
            migrations: Array<{ name: string; sha256: string }>;
        };
        const setup =
            expected.setup === "SCHEMA_FIXTURE_ONLY_FROM_TEMPLATE"
                ? expected.setup
                : "SCHEMA_FIXTURE_ONLY";
        if (
            JSON.stringify(checksums) !==
            JSON.stringify(
                expected.migrations.map((item) => ({
                    name: item.name,
                    sha256: item.sha256,
                })),
            )
        )
            throw new Error("Delivery schema fixture SQL manifest mismatch");
        const columns = await database.query(
            `SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('User','Play','PlayCreationReceipt','ScrobbleConnection','PlayScrobbleDispatch') ORDER BY table_name,ordinal_position`,
        );
        if (
            !columns.rows.some(
                (row) =>
                    row.table_name === "User" &&
                    row.column_name === "playHistoryEpoch",
            )
        )
            throw new Error("Delivery schema fixture catalog sanity failed");
        const indexes = await database.query(
            `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('User','Play','PlayCreationReceipt','ScrobbleConnection','PlayScrobbleDispatch') ORDER BY tablename,indexname`,
        );
        for (const [table, column] of [
            ["ScrobbleConnection", "authEpoch"],
            ["PlayScrobbleDispatch", "claimToken"],
            ["PlayScrobbleDispatch", "metadata"],
            ["PlayScrobbleDispatch", "expiresAt"],
            ["PlayScrobbleDispatch", "userTokenVersion"],
        ]) {
            if (
                !columns.rows.some(
                    (row) =>
                        row.table_name === table && row.column_name === column,
                )
            )
                throw new Error(
                    "Delivery schema fixture destination catalog mismatch",
                );
        }
        for (const name of [
            "PlayScrobbleDispatch_playId_service_key",
            "PlayScrobbleDispatch_state_availableAt_id_idx",
            "PlayScrobbleDispatch_state_claimExpiresAt_idx",
            "PlayCreationReceipt_expiresAt_userId_idx",
        ]) {
            if (!indexes.rows.some((row) => row.indexname === name))
                throw new Error("Delivery schema fixture index mismatch");
        }
        const constraints = await database.query(
            `SELECT r.relname,c.conname,c.contype,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND r.relname IN ('User','Play','PlayCreationReceipt','ScrobbleConnection','PlayScrobbleDispatch') ORDER BY r.relname,c.conname`,
        );
        writeFileSync(
            join(tmpdir(), "soundspan-dev08-delivery-schema-receipt.json"),
            JSON.stringify({
                setup,
                checksums,
                columns: columns.rows,
                indexes: indexes.rows,
                constraints: constraints.rows,
            }),
        );
        console.info(
            JSON.stringify({
                setup,
                sqlFiles: migrations.length,
                catalogSanity: "PASS",
            }),
        );
    } finally {
        await database.end();
    }
}
