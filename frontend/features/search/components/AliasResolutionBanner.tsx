import type { AliasInfo } from "../types";

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
            className="inline-flex min-h-10 items-center rounded-full border border-white/[0.08] bg-white/[0.035] px-4 text-sm text-content-secondary"
        >
            Showing results for{" "}
            <span className="font-semibold text-content">
                {aliasInfo.canonical}
            </span>{" "}
            (searched &quot;{aliasInfo.original}&quot;)
        </p>
    );
}
