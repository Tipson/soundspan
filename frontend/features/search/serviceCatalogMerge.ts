import type { MusicSourceCandidate } from "@/lib/api/musicSources";
import type { DiscoverResult } from "./types";

const normalize = (value: string) =>
    value
        .normalize("NFKC")
        .toLowerCase()
        .replaceAll("ё", "е")
        .replace(/[^\p{L}\p{N}]/gu, "");
function identity(row: DiscoverResult): string | null {
    return row.type === "track" &&
        row.artist &&
        row.duration &&
        row.duration > 0
        ? `${normalize(row.artist)}|${normalize(row.name)}`
        : null;
}
function providerIdentity(row: DiscoverResult): string {
    return row.musicSourceRecording
        ? `${row.musicSourceRecording.provider}:${row.musicSourceRecording.id}`
        : `${row.streamSource ?? "metadata"}:${row.youtubeVideoId ?? row.id ?? row.name}`;
}

/** Group matching recording metadata while retaining every selectable provider identity. */
export function mergeServiceCatalogResults(
    existing: DiscoverResult[],
    candidates: MusicSourceCandidate[],
): DiscoverResult[] {
    const result: DiscoverResult[] = [];
    const groups = new Map<string, number[]>();
    const rows: DiscoverResult[] = [
        ...existing,
        ...candidates.map(
            (recording): DiscoverResult => ({
                type: "track",
                id: `${recording.provider}:${recording.id}`,
                name: recording.title,
                artist: recording.artists.join(", "),
                duration: recording.duration,
                musicSourceRecording: recording,
            }),
        ),
    ];
    for (const row of rows) {
        const key = identity(row);
        const index = key
            ? (groups.get(key) ?? []).find((i) => {
                  const previous = result[i];
                  return (previous.versions ?? [previous]).every((version) => {
                      const a = version.musicSourceRecording?.isrc,
                          b = row.musicSourceRecording?.isrc;
                      return (
                          Math.abs(
                              (version.duration ?? 0) - (row.duration ?? 0),
                          ) <= 2 &&
                          (!a || !b || a.toUpperCase() === b.toUpperCase())
                      );
                  });
              })
            : undefined;
        if (index === undefined) {
            if (key)
                groups.set(key, [...(groups.get(key) ?? []), result.length]);
            result.push({ ...row });
            continue;
        }
        const previous = result[index];
        const versions = previous.versions ?? [previous];
        if (
            versions.some(
                (version) =>
                    providerIdentity(version) === providerIdentity(row),
            )
        )
            continue;
        const preferred =
            row.musicSourceRecording?.contentVersion === "explicit" &&
            previous.musicSourceRecording?.contentVersion !== "explicit"
                ? row
                : previous;
        result[index] = { ...preferred, versions: [...versions, row] };
    }
    return result;
}
