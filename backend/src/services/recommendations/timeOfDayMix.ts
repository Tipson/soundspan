import { createHash } from "node:crypto";
import type {
    PersonalizedHomeFeed,
    PersonalizedTrack,
} from "../personalizedCatalog";
import type { MixSnapshotMetadata } from "./mixSnapshotMetadata";

const TARGET_TRACKS = 40;
const CHECK_INTERVAL_MS = 10 * 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** One authoritative finite view of the already admitted personal feed. */
export interface TimeOfDayMix {
    tracks: PersonalizedTrack[];
    snapshot: MixSnapshotMetadata;
}

function period(hour: number): number {
    return Math.floor(hour / 6);
}

/**
 * Reuse the existing Web daypart recipe without another rank, cache or provider read.
 * Membership keys outlive refetches; check time never masquerades as a generation date.
 */
export function buildTimeOfDayMix(input: {
    shelves: PersonalizedHomeFeed["shelves"];
    checkedAt: Date;
    localHour: number;
    /** Local minus UTC in minutes, positive east of UTC, as sent by both clients. */
    timezoneOffsetMinutes: number;
    providerDegraded: boolean;
}): TimeOfDayMix {
    const tracks: PersonalizedTrack[] = [];
    const identities: string[] = [];
    const seen = new Set<string>();
    const artists = new Map<string, number>();
    for (const shelf of [
        input.shelves.discovery,
        input.shelves.quickPicks,
        input.shelves.listenAgain,
    ]) {
        for (const track of shelf) {
            const identity =
                track.source === "youtube"
                    ? `youtube:${track.youtubeVideoId.trim()}`
                    : `${track.source}:${track.provider.providerTrackId}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            const artist = track.artist.name.trim().toLocaleLowerCase();
            if (artist && artist !== "unknown artist") {
                const count = artists.get(artist) ?? 0;
                if (count >= 2) continue;
                artists.set(artist, count + 1);
            }
            tracks.push(track);
            identities.push(identity);
            if (tracks.length === TARGET_TRACKS) break;
        }
        if (tracks.length === TARGET_TRACKS) break;
    }

    const now = input.checkedAt.getTime();
    const offset = input.timezoneOffsetMinutes * MINUTE_MS;
    const local = new Date(now + offset);
    const localHour = local.getUTCHours();
    const nextLocalPeriod =
        Date.UTC(
            local.getUTCFullYear(),
            local.getUTCMonth(),
            local.getUTCDate(),
        ) +
        (period(localHour) + 1) * 6 * HOUR_MS -
        offset;
    const nextUtcDay = Date.UTC(
        input.checkedAt.getUTCFullYear(),
        input.checkedAt.getUTCMonth(),
        input.checkedAt.getUTCDate() + 1,
    );
    // The client supplies the current fixed offset, not an IANA future-DST rule.
    // Its existing clock observer rechecks offsets; a stale period is never fresh.
    const refreshAfter =
        period(input.localHour) === period(localHour)
            ? Math.min(now + CHECK_INTERVAL_MS, nextUtcDay, nextLocalPeriod)
            : now;
    const reasons: MixSnapshotMetadata["reasons"] = [];
    if (input.providerDegraded) reasons.push("provider_degraded");
    if (tracks.length < TARGET_TRACKS) reasons.push("pool_limited");
    return {
        tracks,
        snapshot: {
            checkedAt: input.checkedAt.toISOString(),
            compositionKey: `daypart-v1:${createHash("sha256").update(JSON.stringify(identities)).digest("hex")}`,
            refreshAfter: new Date(refreshAfter).toISOString(),
            requestedCount: TARGET_TRACKS,
            snapshotCount: tracks.length,
            availableCount: tracks.length,
            reasons,
        },
    };
}
