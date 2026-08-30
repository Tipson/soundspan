import type {
    ChangeEventHandler,
    FocusEventHandler,
    KeyboardEventHandler,
    ReactNode,
    RefObject,
} from "react";
import { Pencil } from "lucide-react";
import { CoverMosaic } from "@/components/ui/CoverMosaic";
import { MusicDetailHero } from "@/components/music-detail";

interface PlaylistDetailHeroProps {
    name: string;
    coverUrls: string[];
    kindLabel: string;
    ownerName?: string | null;
    trackCount: number;
    durationLabel?: string | null;
    isOwner: boolean;
    actions?: ReactNode;
    isRenaming?: boolean;
    renameValue?: string;
    isSavingName?: boolean;
    renameInputRef?: RefObject<HTMLInputElement | null>;
    renameTriggerRef?: RefObject<HTMLButtonElement | null>;
    onRenameChange?: ChangeEventHandler<HTMLInputElement>;
    onRenameBlur?: FocusEventHandler<HTMLInputElement>;
    onRenameKeyDown?: KeyboardEventHandler<HTMLInputElement>;
    onStartRename?: () => void;
}

/** Playlist identity header using the same artwork and action hierarchy as catalog details. */
export function PlaylistDetailHero({
    name,
    coverUrls,
    kindLabel,
    ownerName,
    trackCount,
    durationLabel,
    isOwner,
    actions,
    isRenaming = false,
    renameValue = "",
    isSavingName = false,
    renameInputRef,
    renameTriggerRef,
    onRenameChange,
    onRenameBlur,
    onRenameKeyDown,
    onStartRename,
}: PlaylistDetailHeroProps) {
    const title = isRenaming ? (
        <input
            ref={renameInputRef}
            aria-label="Playlist name"
            value={renameValue}
            onChange={onRenameChange}
            onBlur={onRenameBlur}
            onKeyDown={onRenameKeyDown}
            disabled={isSavingName}
            maxLength={200}
            className="w-full min-w-0 rounded-xl border border-white/15 bg-black/25 px-3 py-2 text-[clamp(2rem,8vw,4.75rem)] font-black leading-none tracking-[-0.05em] text-white outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/30"
        />
    ) : (
        name
    );

    const titleAfter =
        isOwner && !isRenaming && onStartRename ? (
            <button
                ref={renameTriggerRef}
                type="button"
                onClick={onStartRename}
                aria-label="Rename playlist"
                className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light active:scale-[0.97] motion-reduce:transition-none"
            >
                <Pencil className="h-4 w-4" aria-hidden="true" />
            </button>
        ) : null;

    const metadata = (
        <>
            {ownerName && (
                <span className="font-bold text-white">{ownerName}</span>
            )}
            {ownerName && <span aria-hidden="true">•</span>}
            <span>
                {trackCount} {trackCount === 1 ? "song" : "songs"}
            </span>
            {durationLabel && (
                <>
                    <span aria-hidden="true">•</span>
                    <span>{durationLabel}</span>
                </>
            )}
        </>
    );

    return (
        <MusicDetailHero
            eyebrow={kindLabel}
            title={title}
            artworkShape="square"
            backgroundImage={coverUrls[0] ?? null}
            metadata={metadata}
            titleAfter={titleAfter}
            actions={actions}
            artwork={
                <CoverMosaic
                    coverUrls={coverUrls}
                    imageSizes="(max-width: 640px) 88px, 112px"
                />
            }
        />
    );
}
