import { Client } from "pg";
import { applyScaleMigrations } from "./scaleTestDatabase";
import { createPlayDeliveryTestDatabase } from "./playDeliveryTestDatabase";

jest.mock("pg", () => ({ Client: jest.fn() }));
jest.mock("./scaleTestDatabase", () => ({
    ...jest.requireActual("./scaleTestDatabase"),
    applyScaleMigrations: jest.fn(),
}));

describe("Play delivery database lifecycle without a database server", () => {
    const adminUrl =
        "postgresql://fixture:fixture@127.0.0.1:5432/soundspan?schema=unused";
    const databaseName = `dev08_delivery_${process.pid}_1700000000000`;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const admin = {
        connect: jest.fn(),
        query: jest.fn(),
        end: jest.fn(),
    };

    beforeEach(() => {
        jest.spyOn(Date, "now").mockReturnValue(1700000000000);
        admin.connect.mockResolvedValue(undefined);
        admin.query.mockReset().mockResolvedValue({ rows: [] });
        admin.end.mockResolvedValue(undefined);
        jest.mocked(Client).mockImplementation(() => admin as unknown as Client);
        jest.mocked(applyScaleMigrations).mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalDatabaseUrl;
    });

    test("an admin URL creates, migrates and drops only its dedicated delivery database", async () => {
        const fixture = await createPlayDeliveryTestDatabase(adminUrl);

        expect(fixture.name).toBe(databaseName);
        expect(Client).toHaveBeenCalledWith({
            connectionString:
                "postgresql://fixture:fixture@127.0.0.1:5432/soundspan",
        });
        expect(admin.query.mock.calls).toEqual([
            [`CREATE DATABASE "${databaseName}"`],
        ]);
        expect(process.env.DATABASE_URL).toBe(databaseUrl.toString());
        expect(applyScaleMigrations).toHaveBeenCalledWith(
            databaseUrl.toString(),
            600_000,
        );
        expect(admin.end).not.toHaveBeenCalled();

        await fixture.close();

        expect(admin.query.mock.calls).toEqual([
            [`CREATE DATABASE "${databaseName}"`],
            [`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`],
        ]);
        expect(admin.end).toHaveBeenCalledTimes(1);
    });

    test("a failed create never drops a database it did not create", async () => {
        const collision = new Error("Database already exists");
        admin.query.mockRejectedValueOnce(collision);

        await expect(createPlayDeliveryTestDatabase(adminUrl)).rejects.toBe(
            collision,
        );

        expect(admin.query.mock.calls).toEqual([
            [`CREATE DATABASE "${databaseName}"`],
        ]);
        expect(applyScaleMigrations).not.toHaveBeenCalled();
        expect(admin.end).toHaveBeenCalledTimes(1);
        expect(process.env.DATABASE_URL).toBe(originalDatabaseUrl);
    });

    test("failed migration drops only the database created by this attempt", async () => {
        const failure = new Error("Migration failed");
        jest.mocked(applyScaleMigrations).mockRejectedValueOnce(failure);

        await expect(createPlayDeliveryTestDatabase(adminUrl)).rejects.toBe(
            failure,
        );

        expect(admin.query.mock.calls).toEqual([
            [`CREATE DATABASE "${databaseName}"`],
            [`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`],
        ]);
        expect(admin.end).toHaveBeenCalledTimes(1);
    });

    test.each(["soundspan", "postgres", "dev08_admin", "dev08_delivery_1_2_extra"])(
        "schema-fixture rejects unsafe database %s before connecting or dropping",
        async (name) => {
            const url = new URL(adminUrl);
            url.pathname = `/${name}`;

            await expect(
                createPlayDeliveryTestDatabase(url.toString(), "schema-fixture"),
            ).rejects.toThrow("Unsafe delivery test database name");

            expect(Client).not.toHaveBeenCalled();
            expect(admin.connect).not.toHaveBeenCalled();
            expect(admin.query).not.toHaveBeenCalled();
            expect(admin.end).not.toHaveBeenCalled();
            expect(applyScaleMigrations).not.toHaveBeenCalled();
        },
    );
});
