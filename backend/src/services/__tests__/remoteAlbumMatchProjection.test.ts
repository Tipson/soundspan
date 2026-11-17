import { currentRemoteAlbumMatch } from "../remoteAlbumMatchProjection";
import { albumMatchInputHash } from "../remoteAlbumMatchInput";

const now = new Date("2026-11-17T12:00:00Z"),
    id = "11111111-1111-4111-8111-111111111111";
const base = {
    location: "REMOTE",
    rgMbid: "remote:one",
    title: "Album",
    artist: { name: "Artist", mbid: null },
    matchedRgMbid: id,
    rgMbidCheckedAt: now,
    rgMbidMatchInputHash: "",
};
base.rgMbidMatchInputHash = albumMatchInputHash(base);
describe("current owner-visible REMOTE match projection", () => {
    it("returns a current real RG without changing the placeholder", () => {
        expect(currentRemoteAlbumMatch(base, now)).toBe(id);
        expect(base.rgMbid).toBe("remote:one");
    });
    it.each([
        { title: "Changed" },
        { artist: { name: "Other", mbid: null } },
        { location: "LIBRARY" },
        { rgMbid: id },
        { matchedRgMbid: "vk:opaque" },
        { rgMbidCheckedAt: null },
        { rgMbidCheckedAt: new Date(now.getTime() + 1) },
        { rgMbidCheckedAt: new Date(now.getTime() - 30 * 86400000) },
        { rgMbidMatchInputHash: null },
    ])("hides stale or invalid state %j", (extra) => {
        expect(currentRemoteAlbumMatch({ ...base, ...extra }, now)).toBeNull();
    });
});
