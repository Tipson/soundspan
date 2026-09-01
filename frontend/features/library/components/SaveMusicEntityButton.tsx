"use client";

import { BookmarkPlus, Check, Loader2 } from "lucide-react";
import type { SavedMusicEntityInput } from "@/lib/api";
import { cn } from "@/utils/cn";
import { useSavedMusicEntity } from "../hooks/useSavedMusic";
import { ru } from "@/lib/i18n/ru";

interface SaveMusicEntityButtonProps {
    entity: SavedMusicEntityInput | null;
    className?: string;
}

/** Explicit account-synced Save/Remove control for albums and artists. */
export function SaveMusicEntityButton({
    entity,
    className,
}: SaveMusicEntityButtonProps) {
    const { isSaved, isLoading, isMutating, isError, toggle } =
        useSavedMusicEntity(entity);

    if (!entity) return null;

    const busy = isLoading || isMutating;
    const label = isError
        ? ru.library.unavailable
        : isLoading
          ? ru.library.checking
          : isSaved
            ? ru.library.remove
            : ru.library.save;

    return (
        <button
            type="button"
            aria-pressed={isSaved}
            aria-label={label}
            title={
                isSaved
                    ? `${ru.library.remove}: ${entity.title}`
                    : `${ru.library.save}: ${entity.title}`
            }
            disabled={busy || isError}
            onClick={() => void toggle()}
            className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                isSaved
                    ? "border-brand/35 bg-brand/15 text-brand-light hover:bg-brand/20"
                    : "border-white/15 bg-white/[0.07] text-content hover:border-white/25 hover:bg-white/10",
                (busy || isError) && "cursor-not-allowed opacity-60",
                className,
            )}
        >
            {busy ? (
                <Loader2
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                />
            ) : isSaved ? (
                <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
                <BookmarkPlus className="h-4 w-4" aria-hidden="true" />
            )}
            <span>{label}</span>
        </button>
    );
}
