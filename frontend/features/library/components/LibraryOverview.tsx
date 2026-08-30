import Link from "next/link";
import {
    Album,
    ArrowRight,
    Download,
    Heart,
    ListMusic,
    UserRound,
    type LucideIcon,
} from "lucide-react";
import { pluralRu, ru } from "@/lib/i18n/ru";

interface LibraryOverviewProps {
    likedTotal: number;
    playlistTotal: number;
    albumTotal: number;
    artistTotal: number;
    downloadTotal: number;
}

interface CollectionCard {
    href: string;
    label: string;
    detail: string;
    icon: LucideIcon;
    featured?: boolean;
}

function AccountCollectionCard({ card }: { card: CollectionCard }) {
    const Icon = card.icon;
    return (
        <Link
            href={card.href}
            className={`group relative flex min-h-28 flex-col justify-between overflow-hidden rounded-[20px] border p-4 transition-[transform,background-color,border-color] hover:-translate-y-0.5 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none ${
                card.featured
                    ? "col-span-2 border-brand/25 bg-gradient-to-br from-brand/30 via-ai/10 to-surface-raised hover:border-brand/40"
                    : "border-white/8 bg-surface-raised hover:border-white/15 hover:bg-surface-elevated"
            }`}
        >
            <span className="flex items-start justify-between gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-black/20 text-brand-light">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <ArrowRight
                    className="h-4 w-4 text-content-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                    aria-hidden="true"
                />
            </span>
            <span>
                <span className="block text-sm font-bold leading-tight text-content sm:text-base">
                    {card.label}
                </span>
                <span className="mt-1 block text-xs text-content-muted">
                    {card.detail}
                </span>
            </span>
        </Link>
    );
}

/** High-signal entry points into one user's account and device collection. */
export function LibraryOverview({
    likedTotal,
    playlistTotal,
    albumTotal,
    artistTotal,
    downloadTotal,
}: LibraryOverviewProps) {
    const accountCards: CollectionCard[] = [
        {
            href: "/playlist/my-liked",
            label: ru.library.likedSongs,
            detail: `${likedTotal} ${pluralRu(likedTotal, ["трек", "трека", "треков"])}`,
            icon: Heart,
            featured: true,
        },
        {
            href: "/library?tab=playlists",
            label: ru.library.playlists,
            detail: `${playlistTotal} ${pluralRu(playlistTotal, ["плейлист", "плейлиста", "плейлистов"])}`,
            icon: ListMusic,
        },
        {
            href: "/library?tab=albums",
            label: ru.library.savedAlbums,
            detail: `${albumTotal} ${pluralRu(albumTotal, ["альбом", "альбома", "альбомов"])}`,
            icon: Album,
        },
        {
            href: "/library?tab=artists",
            label: ru.library.savedArtists,
            detail: `${artistTotal} ${pluralRu(artistTotal, ["исполнитель", "исполнителя", "исполнителей"])}`,
            icon: UserRound,
        },
    ];

    return (
        <section
            aria-labelledby="account-collection-title"
            className="space-y-4"
        >
            <div>
                <h2
                    id="account-collection-title"
                    className="text-sm font-bold uppercase tracking-[0.16em] text-content-secondary"
                >
                    {ru.library.savedAccount}
                </h2>
                <p className="mt-1 text-xs leading-5 text-content-muted">
                    {ru.library.signedInDevices}
                </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {accountCards.map((card) => (
                    <AccountCollectionCard key={card.href} card={card} />
                ))}
            </div>

            <div className="rounded-2xl border border-white/8 bg-surface-sunken p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h3 className="text-sm font-bold text-content">
                            {ru.library.deviceOnly}
                        </h3>
                        <p className="mt-1 max-w-2xl text-xs leading-5 text-content-muted sm:text-sm">
                            {ru.library.deviceDescription}
                        </p>
                    </div>
                    <Link
                        href="/library?tab=downloads"
                        className="group inline-flex min-h-14 shrink-0 items-center gap-3 rounded-xl border border-white/8 bg-surface-raised px-4 py-2 text-content transition-colors hover:border-brand/30 hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    >
                        <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/15 text-brand-light">
                            <Download className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <span>
                            <span className="block text-sm font-bold">
                                {ru.library.deviceDownloads}
                            </span>
                            <span className="mt-0.5 block text-xs text-content-muted">
                                {downloadTotal}{" "}
                                {pluralRu(downloadTotal, [
                                    "офлайн-трек",
                                    "офлайн-трека",
                                    "офлайн-треков",
                                ])}
                            </span>
                        </span>
                        <ArrowRight
                            className="h-4 w-4 text-content-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                            aria-hidden="true"
                        />
                    </Link>
                </div>
            </div>
        </section>
    );
}
