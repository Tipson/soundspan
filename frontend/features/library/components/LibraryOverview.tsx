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
}

function AccountCollectionCard({ card }: { card: CollectionCard }) {
    const Icon = card.icon;
    return (
        <Link
            href={card.href}
            className="group flex min-h-14 items-center gap-3 px-1 py-3 transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-light motion-reduce:transition-none"
        >
            <span className="grid h-11 w-11 shrink-0 place-items-center text-brand-light">
                <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold leading-tight text-content sm:text-base">
                    {card.label}
                </span>
                <span className="mt-1 block text-xs text-content-muted">
                    {card.detail}
                </span>
            </span>
            <ArrowRight
                className="h-4 w-4 shrink-0 text-content-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                aria-hidden="true"
            />
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
            label: "Лайкнутые",
            detail: `${likedTotal} ${pluralRu(likedTotal, ["трек", "трека", "треков"])}`,
            icon: Heart,
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
            data-library-overview="split"
            className="grid border-y border-white/[0.08] lg:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.75fr)]"
        >
            <div data-library-scope="account" className="py-6 lg:pr-8">
                <div className="mb-3">
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
                <div className="grid divide-y divide-white/[0.07] sm:grid-cols-2 sm:gap-x-6 sm:[&>*:nth-child(2)]:border-t-0">
                    {accountCards.map((card) => (
                        <AccountCollectionCard key={card.href} card={card} />
                    ))}
                </div>
            </div>

            <div
                data-library-scope="device"
                className="border-t border-white/[0.08] py-6 lg:border-l lg:border-t-0 lg:pl-8"
            >
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-light">
                    {ru.library.deviceOnly}
                </p>
                <h3 className="mt-2 text-xl font-black tracking-tight text-content">
                    {ru.library.deviceDownloads}
                </h3>
                <p className="mt-2 max-w-xl text-sm leading-6 text-content-muted">
                    {ru.library.deviceDescription}
                </p>
                <Link
                    href="/library?tab=downloads"
                    className="group mt-5 flex min-h-14 items-center gap-3 border-t border-white/[0.08] py-3 text-content transition-colors hover:text-brand-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-light motion-reduce:transition-none"
                >
                    <span className="grid h-11 w-11 shrink-0 place-items-center text-brand-light">
                        <Download className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-bold">
                        {downloadTotal}{" "}
                        {pluralRu(downloadTotal, [
                            "офлайн-трек",
                            "офлайн-трека",
                            "офлайн-треков",
                        ])}
                    </span>
                    <ArrowRight
                        className="h-4 w-4 shrink-0 text-content-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                        aria-hidden="true"
                    />
                </Link>
            </div>
        </section>
    );
}
