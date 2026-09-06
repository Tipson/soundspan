import { z } from "zod";

const credentialsSchema = z.object({
    username: z.string().regex(/^soundspan-test-[a-z0-9][a-z0-9-]{0,47}$/),
    password: z
        .string()
        .min(16)
        .max(72)
        .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
});

interface TestAccountData {
    username: string;
    passwordHash: string;
    role: "user";
    isTestAccount: true;
    onboardingComplete: false;
}

interface TestAccountIdentity {
    id: string;
    username: string;
}

interface TestAccountDependencies {
    create: (data: TestAccountData) => Promise<TestAccountIdentity>;
    hashPassword: (password: string) => Promise<string>;
}

/** Create an operator-owned fixture, never upsert or reset an existing account. */
export async function createPlaybackTestAccount(
    input: unknown,
    dependencies: TestAccountDependencies,
): Promise<TestAccountIdentity> {
    const credentials = credentialsSchema.parse(input);
    const passwordHash = await dependencies.hashPassword(credentials.password);
    return dependencies.create({
        username: credentials.username,
        passwordHash,
        role: "user",
        isTestAccount: true,
        onboardingComplete: false,
    });
}
