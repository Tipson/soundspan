export interface DeviceOfflineSessionLoadToken {
    readonly ownerId: string | null;
    readonly generation: number;
}

/** Prevents async work from publishing after its provider or owner is stale. */
export class DeviceOfflineSessionGuard {
    private mounted = true;
    private ownerId: string | null;
    private generation = 0;

    constructor(ownerId: string | null) {
        this.ownerId = ownerId;
    }

    setOwner(ownerId: string | null): void {
        if (ownerId === this.ownerId) return;
        this.ownerId = ownerId;
        this.generation += 1;
    }

    mount(ownerId: string | null): void {
        this.mounted = true;
        this.ownerId = ownerId;
        this.generation += 1;
    }

    unmount(): void {
        this.mounted = false;
        this.generation += 1;
    }

    begin(
        expectedOwnerId: string | null,
    ): DeviceOfflineSessionLoadToken | null {
        if (!this.mounted || expectedOwnerId !== this.ownerId) return null;
        this.generation += 1;
        return {
            ownerId: expectedOwnerId,
            generation: this.generation,
        };
    }

    publishIfCurrent(
        token: DeviceOfflineSessionLoadToken,
        publish: () => void,
    ): boolean {
        if (
            !this.mounted ||
            token.ownerId !== this.ownerId ||
            token.generation !== this.generation
        ) {
            return false;
        }
        publish();
        return true;
    }
}
