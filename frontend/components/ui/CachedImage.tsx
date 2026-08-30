"use client";

import Image, { ImageProps } from "next/image";
import { memo, useState, type ReactNode } from "react";

interface CachedImageProps extends Omit<ImageProps, "src"> {
    src: string | null | undefined;
    fill?: boolean;
    fallback?: ReactNode;
}

function DefaultArtworkFallback({
    alt,
    fill,
    width,
    height,
}: Pick<CachedImageProps, "alt" | "fill" | "width" | "height">) {
    const label = alt?.trim()
        ? `Обложка для «${alt}» недоступна`
        : "Обложка недоступна";
    return (
        <span
            role="img"
            aria-label={label}
            className={
                fill
                    ? "absolute inset-0 flex items-center justify-center bg-surface-highlight text-content-muted"
                    : "inline-flex items-center justify-center bg-surface-highlight text-content-muted"
            }
            style={fill ? undefined : { width, height }}
        >
            <span aria-hidden="true" className="text-lg leading-none">
                ♪
            </span>
        </span>
    );
}

/**
 * Image component with Service Worker caching
 * The SW handles cache-first fetching for /api/library/cover-art/* routes
 */
const CachedImage = memo(function CachedImage({
    src,
    alt = "",
    fallback,
    onError,
    ...props
}: CachedImageProps) {
    const [failedSrc, setFailedSrc] = useState<string | null>(null);

    if (!src || failedSrc === src) {
        return fallback === undefined ? (
            <DefaultArtworkFallback
                alt={alt}
                fill={props.fill}
                width={props.width}
                height={props.height}
            />
        ) : (
            fallback
        );
    }

    // Add lazy loading by default for better performance
    const imageProps = {
        ...props,
        loading: props.loading || "lazy",
    };

    return (
        <Image
            src={src}
            alt={alt}
            unoptimized
            {...imageProps}
            onError={(event) => {
                setFailedSrc(src);
                onError?.(event);
            }}
        />
    );
});

export { CachedImage };
export type { CachedImageProps };
