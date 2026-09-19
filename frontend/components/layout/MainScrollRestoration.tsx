"use client";

import type { RefObject } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useMainScrollRestoration } from "@/hooks/useMainScrollRestoration";

/** Account-scoped adapter for pathname/query navigation of the shell scroll area. */
export function MainScrollRestoration({
    containerRef,
}: {
    containerRef: RefObject<HTMLElement | null>;
}) {
    const pathname = usePathname();
    const query = useSearchParams().toString();
    useMainScrollRestoration(
        containerRef,
        pathname + (query ? `?${query}` : ""),
    );
    return null;
}
