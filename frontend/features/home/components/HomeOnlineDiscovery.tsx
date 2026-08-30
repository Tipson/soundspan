import Link from "next/link";
import { Music2 } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { api } from "@/lib/api";
import type {
    PlaylistPreview,
    YtMusicHomeShelf,
    YtMusicShelfItem,
} from "@/hooks/useQueries";
import { SectionHeader } from "./SectionHeader";
import { ru } from "@/lib/i18n/ru";

const REGIONAL_DUMP_PATTERN =
    /(?:\b(?:schlager|german|germany|deutsch(?:e|land)?|mega\s*hits?\s+der)\b|немецк(?:ая|ие|ой|ую)|германи(?:я|и|ю))/i;
const PERSONAL_SHELF_PATTERN =
    /(?:\b(?:for you|made for you|because you|recommended|listen again|your mix|quick picks|radio|station)\b|для вас|сделано для вас|ваш(?:и|у)? микс|слушать снова|радио|станци)/i;
const DISCOVERY_SHELF_PATTERN =
    /(?:\b(?:new releases?|discover|trending|popular|charts?|fresh)\b|новинки|открытия|популярн|чарты?|свеж)/i;

interface HomeMediaItem {
    key: string;
    href: string;
    title: string;
    subtitle: string | null;
    imageUrl: string | null;
}

interface HomeOnlineDiscoveryProps {
    enabled: boolean;
    homeShelves: YtMusicHomeShelf[];
    chartPlaylists: PlaylistPreview[];
}

function shelfScore(shelf: YtMusicHomeShelf): number {
    const title = shelf.title ?? "";
    if (PERSONAL_SHELF_PATTERN.test(title)) return 2;
    if (DISCOVERY_SHELF_PATTERN.test(title)) return 1;
    return 0;
}

function isRegionalDumpShelf(shelf: YtMusicHomeShelf): boolean {
    if (REGIONAL_DUMP_PATTERN.test(shelf.title ?? "")) return true;
    return (shelf.contents ?? []).some((item) =>
        REGIONAL_DUMP_PATTERN.test(
            `${item.title ?? ""} ${item.subtitle ?? ""}`,
        ),
    );
}

/** Keeps only compact, navigable, unique provider shelves for Home. */
export function curateHomeShelves(
    shelves: YtMusicHomeShelf[],
): YtMusicHomeShelf[] {
    const seenTitles = new Set<string>();

    return shelves
        .map((shelf, sourceIndex) => {
            const seenItems = new Set<string>();
            const contents = (shelf.contents ?? [])
                .filter(
                    (item) =>
                        Boolean(item.playlistId) ||
                        (Boolean(item.browseId) && item.type === "album"),
                )
                .filter((item) => {
                    const key = item.playlistId ?? item.browseId;
                    if (!key || seenItems.has(key)) return false;
                    seenItems.add(key);
                    return true;
                })
                .slice(0, 8);

            return { shelf, sourceIndex, contents };
        })
        .filter(({ shelf, contents }) => {
            const normalizedTitle = (shelf.title ?? "featured")
                .trim()
                .toLocaleLowerCase();
            if (contents.length === 0 || isRegionalDumpShelf(shelf)) {
                return false;
            }
            if (seenTitles.has(normalizedTitle)) return false;
            seenTitles.add(normalizedTitle);
            return true;
        })
        .sort(
            (left, right) =>
                shelfScore(right.shelf) - shelfScore(left.shelf) ||
                left.sourceIndex - right.sourceIndex,
        )
        .slice(0, 3)
        .map(({ shelf, contents }) => ({ ...shelf, contents }));
}

function shelfItemToMedia(item: YtMusicShelfItem): HomeMediaItem | null {
    const href = item.playlistId
        ? `/explore/yt-playlist/${encodeURIComponent(item.playlistId)}`
        : item.browseId && item.type === "album"
          ? `/explore/yt-playlist/${encodeURIComponent(item.browseId)}?type=album`
          : null;
    const key = item.playlistId ?? item.browseId ?? null;
    if (!href || !key || !item.title?.trim()) return null;

    return {
        key,
        href,
        title: item.title.trim(),
        subtitle: item.subtitle?.trim() || null,
        imageUrl: item.thumbnailUrl
            ? api.getBrowseImageUrl(item.thumbnailUrl)
            : null,
    };
}

function addUniqueMedia(
    target: HomeMediaItem[],
    item: HomeMediaItem | null,
    seen: Set<string>,
    limit: number,
) {
    if (!item || target.length >= limit || seen.has(item.key)) return;
    seen.add(item.key);
    target.push(item);
}

/** Folds provider data into one station row and one discovery row. */
export function buildHomeDiscoveryRows({
    homeShelves,
    chartPlaylists,
}: Omit<HomeOnlineDiscoveryProps, "enabled">): {
    stations: HomeMediaItem[];
    discoveries: HomeMediaItem[];
} {
    const stations: HomeMediaItem[] = [];
    const discoveries: HomeMediaItem[] = [];
    const seen = new Set<string>();
    const curatedShelves = curateHomeShelves(homeShelves);

    curatedShelves
        .filter((shelf) => PERSONAL_SHELF_PATTERN.test(shelf.title ?? ""))
        .flatMap((shelf) => shelf.contents ?? [])
        .forEach((item) =>
            addUniqueMedia(stations, shelfItemToMedia(item), seen, 6),
        );

    curatedShelves
        .filter(
            (shelf) =>
                !PERSONAL_SHELF_PATTERN.test(shelf.title ?? "") ||
                DISCOVERY_SHELF_PATTERN.test(shelf.title ?? ""),
        )
        .flatMap((shelf) => shelf.contents ?? [])
        .forEach((item) =>
            addUniqueMedia(discoveries, shelfItemToMedia(item), seen, 6),
        );

    chartPlaylists.forEach((item) => {
        addUniqueMedia(
            discoveries,
            {
                key: item.id,
                href: `/explore/yt-playlist/${encodeURIComponent(item.id)}`,
                title: item.title,
                subtitle: item.creator || item.description,
                imageUrl: item.imageUrl,
            },
            seen,
            6,
        );
    });

    return { stations, discoveries };
}

function HomeMediaCard({ item }: { item: HomeMediaItem }) {
    return (
        <Link
            href={item.href}
            className="group block min-w-0 snap-start rounded-[1.125rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
            <span className="relative mb-3 block aspect-square overflow-hidden rounded-[1.125rem] bg-surface-highlight shadow-lg shadow-black/25">
                {item.imageUrl ? (
                    <CachedImage
                        src={item.imageUrl}
                        alt=""
                        fill
                        sizes="(max-width: 640px) 44vw, 190px"
                        className="object-cover transition duration-300 group-hover:scale-[1.035] motion-reduce:transition-none"
                    />
                ) : (
                    <span className="absolute inset-0 grid place-items-center bg-surface-elevated">
                        <Music2
                            className="h-9 w-9 text-content-muted"
                            aria-hidden="true"
                        />
                    </span>
                )}
                <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-transparent" />
            </span>
            <span className="block truncate text-sm font-bold text-content sm:text-[0.9375rem]">
                {item.title}
            </span>
            {item.subtitle && (
                <span className="mt-1 line-clamp-2 block text-xs leading-5 text-content-muted">
                    {item.subtitle}
                </span>
            )}
        </Link>
    );
}

function HomeMediaRow({
    title,
    items,
}: {
    title: string;
    items: HomeMediaItem[];
}) {
    if (items.length === 0) return null;

    return (
        <section aria-label={title}>
            <SectionHeader title={title} />
            <div className="scrollbar-hide grid touch-pan-x snap-x snap-proximity grid-flow-col auto-cols-[44vw] gap-3 overflow-x-auto overscroll-x-contain pb-1 sm:auto-cols-[11rem] sm:gap-4 lg:grid-flow-row lg:grid-cols-4 lg:overflow-visible xl:grid-cols-6">
                {items.map((item) => (
                    <HomeMediaCard key={item.key} item={item} />
                ))}
            </div>
        </section>
    );
}

/** A compact merged Explore surface with no duplicate provider shelves. */
export function HomeOnlineDiscovery({
    enabled,
    homeShelves,
    chartPlaylists,
}: HomeOnlineDiscoveryProps) {
    const { stations, discoveries } = enabled
        ? buildHomeDiscoveryRows({
              homeShelves,
              chartPlaylists,
          })
        : { stations: [], discoveries: [] };

    return (
        <div className="space-y-8 sm:space-y-10">
            <HomeMediaRow title={ru.home.stations} items={stations} />
            <HomeMediaRow title={ru.home.newNoteworthy} items={discoveries} />
        </div>
    );
}
