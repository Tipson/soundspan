"use client";

import { useRef, useState, useEffect, useMemo, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";
import { ru } from "@/lib/i18n/ru";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

interface PagedGridCarouselProps<T> {
    items: T[];
    renderItem: (item: T, index: number) => ReactNode;
    keyExtractor: (item: T) => string;
    itemsPerPage?: number;
    columns?: number;
    rows?: number;
    gap?: string;
    className?: string;
}

export function PagedGridCarousel<T>({
    items,
    renderItem,
    keyExtractor,
    itemsPerPage = 6,
    columns = 3,
    rows = 2,
    gap = "gap-2",
    className,
}: PagedGridCarouselProps<T>) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const [currentPage, setCurrentPage] = useState(0);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    // Group items into pages
    const pages = useMemo(() => {
        const result: T[][] = [];
        for (let i = 0; i < items.length; i += itemsPerPage) {
            result.push(items.slice(i, i + itemsPerPage));
        }
        return result;
    }, [items, itemsPerPage]);

    // Check scroll state
    const checkScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 0);
        setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);

        // Update current page based on scroll position
        const pageWidth = el.clientWidth;
        const newPage = Math.round(el.scrollLeft / pageWidth);
        setCurrentPage(newPage);
    };

    useEffect(() => {
        checkScroll();
        const el = scrollRef.current;
        if (el) {
            el.addEventListener("scroll", checkScroll);
            window.addEventListener("resize", checkScroll);
        }
        return () => {
            if (el) el.removeEventListener("scroll", checkScroll);
            window.removeEventListener("resize", checkScroll);
        };
    }, [pages]);

    const scroll = (direction: "left" | "right") => {
        const el = scrollRef.current;
        if (!el) return;
        const scrollAmount = el.clientWidth;
        el.scrollBy({
            left: direction === "left" ? -scrollAmount : scrollAmount,
            behavior: "smooth",
        });
    };

    const goToPage = (pageIndex: number) => {
        const el = scrollRef.current;
        if (el) {
            el.scrollTo({
                left: pageIndex * el.clientWidth,
                behavior: "smooth",
            });
        }
    };

    if (items.length === 0) return null;

    return (
        <div className={cn("relative group/carousel", className)}>
            {/* Left Arrow (desktop only) */}
            {!isMobileOrTablet && canScrollLeft && (
                <button
                    type="button"
                    onClick={() => scroll("left")}
                    className="absolute left-0 top-1/2 z-10 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-xl border border-line bg-surface-overlay text-content opacity-0 shadow-xl transition-[opacity,background-color,border-color,transform] duration-150 group-hover/carousel:opacity-100 hover:border-line-muted hover:bg-surface-elevated focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light active:scale-[0.98] motion-reduce:transition-none"
                    aria-label={ru.common.scrollLeft}
                >
                    <ChevronLeft className="size-5" />
                </button>
            )}

            {/* Scrollable Container */}
            <div
                ref={scrollRef}
                className="flex touch-pan-x snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain scroll-smooth scrollbar-hide motion-reduce:scroll-auto"
            >
                {pages.map((page, pageIndex) => (
                    <div
                        key={pageIndex}
                        className={cn(
                            "flex-shrink-0 snap-start w-full grid",
                            gap,
                        )}
                        style={{
                            gridTemplateColumns: `repeat(${columns}, 1fr)`,
                            gridTemplateRows: `repeat(${rows}, 1fr)`,
                        }}
                    >
                        {page.map((item, itemIndex) => (
                            <div key={keyExtractor(item)}>
                                {renderItem(
                                    item,
                                    pageIndex * itemsPerPage + itemIndex,
                                )}
                            </div>
                        ))}
                        {/* Fill empty slots */}
                        {page.length < itemsPerPage &&
                            Array.from({
                                length: itemsPerPage - page.length,
                            }).map((_, i) => <div key={`empty-${i}`} />)}
                    </div>
                ))}
            </div>

            {/* Right Arrow (desktop only) */}
            {!isMobileOrTablet && canScrollRight && (
                <button
                    type="button"
                    onClick={() => scroll("right")}
                    className="absolute right-0 top-1/2 z-10 flex size-11 translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-xl border border-line bg-surface-overlay text-content opacity-0 shadow-xl transition-[opacity,background-color,border-color,transform] duration-150 group-hover/carousel:opacity-100 hover:border-line-muted hover:bg-surface-elevated focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light active:scale-[0.98] motion-reduce:transition-none"
                    aria-label={ru.common.scrollRight}
                >
                    <ChevronRight className="size-5" />
                </button>
            )}

            {/* Page indicators */}
            {pages.length > 1 && (
                <div className="mt-1 flex justify-center">
                    {pages.map((_, index) => (
                        <button
                            key={index}
                            type="button"
                            onClick={() => goToPage(index)}
                            className="flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                            aria-label={`${ru.common.goToPage} ${index + 1}`}
                            aria-current={
                                index === currentPage ? "page" : undefined
                            }
                        >
                            <span
                                className={cn(
                                    "size-1.5 rounded-full transition-[width,background-color] duration-150 motion-reduce:transition-none",
                                    index === currentPage
                                        ? "w-5 bg-brand"
                                        : "bg-content-disabled",
                                )}
                            />
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
