import type { AliasInfo } from "../types";
import {
    formatAliasResolution,
    searchExtrasRu,
} from "@/lib/i18n/searchExtrasRu";

interface AliasResolutionBannerProps {
    aliasInfo: AliasInfo;
}

/**
 * Renders the AliasResolutionBanner component.
 */
export function AliasResolutionBanner({
    aliasInfo,
}: AliasResolutionBannerProps) {
    return (
        <p
            role="status"
            aria-label={formatAliasResolution(
                aliasInfo.canonical,
                aliasInfo.original,
            )}
            className="inline-flex min-h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.035] px-4 text-sm text-content-secondary"
        >
            {searchExtrasRu.alias.showing}{" "}
            <span className="font-semibold text-content">
                {aliasInfo.canonical}
            </span>{" "}
            ({searchExtrasRu.alias.query} «{aliasInfo.original}»)
        </p>
    );
}
