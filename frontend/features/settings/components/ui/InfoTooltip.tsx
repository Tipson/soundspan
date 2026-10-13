"use client";

import { Info } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface InfoTooltipProps {
    text: string;
}

/**
 * Renders the InfoTooltip component.
 */
export function InfoTooltip({ text }: InfoTooltipProps) {
    const [showTooltip, setShowTooltip] = useState(false);
    const [position, setPosition] = useState({ left: 12, top: 12, width: 288 });
    const trigger = useRef<HTMLButtonElement>(null);
    const tooltip = useRef<HTMLSpanElement>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tooltipId = useId();
    const updatePosition = useCallback(() => {
        const bounds = trigger.current?.getBoundingClientRect();
        if (!bounds) return;
        const width = Math.min(288, window.innerWidth - 24);
        setPosition({
            width,
            left: Math.max(
                12,
                Math.min(bounds.left, window.innerWidth - width - 12),
            ),
            top: Math.max(
                12,
                Math.min(bounds.bottom + 8, window.innerHeight - 152),
            ),
        });
    }, []);
    const openTooltip = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        updatePosition();
        setShowTooltip(true);
    };
    const delayClose = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => {
            if (document.activeElement !== trigger.current)
                setShowTooltip(false);
        }, 200);
    };

    useEffect(
        () => () => {
            if (closeTimer.current) clearTimeout(closeTimer.current);
        },
        [],
    );

    useEffect(() => {
        if (!showTooltip) return;
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setShowTooltip(false);
        };
        const onOutsidePointer = (event: PointerEvent) => {
            if (!(event.target instanceof Node)) return;
            if (
                !trigger.current?.contains(event.target) &&
                !tooltip.current?.contains(event.target)
            ) {
                setShowTooltip(false);
            }
        };
        window.addEventListener("keydown", onEscape);
        window.addEventListener("pointerdown", onOutsidePointer);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        return () => {
            window.removeEventListener("keydown", onEscape);
            window.removeEventListener("pointerdown", onOutsidePointer);
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [showTooltip, updatePosition]);

    return (
        <span className="relative inline-flex">
            <button
                ref={trigger}
                type="button"
                onMouseEnter={openTooltip}
                onMouseLeave={delayClose}
                onFocus={openTooltip}
                onBlur={() => setShowTooltip(false)}
                onClick={openTooltip}
                aria-expanded={showTooltip}
                aria-describedby={showTooltip ? tooltipId : undefined}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[10px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                aria-label="Подробнее"
                title="Подробнее"
            >
                <Info className="h-4 w-4" />
            </button>
            {showTooltip &&
                createPortal(
                    <span
                        ref={tooltip}
                        id={tooltipId}
                        role="tooltip"
                        onMouseEnter={openTooltip}
                        onMouseLeave={delayClose}
                        className="fixed z-[1300] overflow-y-auto rounded-[10px] border border-line bg-surface-overlay p-3 text-sm leading-5 text-content-secondary"
                        style={{
                            ...position,
                            maxHeight: `calc(100dvh - ${position.top + 12}px)`,
                        }}
                    >
                        {text}
                    </span>,
                    document.body,
                )}
        </span>
    );
}
