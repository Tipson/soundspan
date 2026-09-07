"use client";

import { useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { Modal } from "@/components/ui/Modal";

/** Compact collection actions outside the hero's stacking context.
 * Call close before opening another dialog; async controls may stay visible.
 */
export function MusicDetailSecondaryActions({
    children,
}: {
    children: (close: () => void) => ReactNode;
}) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label="Ещё действия"
                onClick={() => setOpen(true)}
                className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
            >
                Ещё
            </button>
            {open &&
                createPortal(
                    <Modal
                        isOpen
                        onClose={() => setOpen(false)}
                        title="Действия"
                        contentClassName="flex flex-col gap-1 [&_button]:min-h-11 [&_button]:h-auto [&_button]:w-full [&_button]:justify-start [&_button]:rounded-xl [&_button]:px-3 [&_button]:py-3 [&_button]:gap-3 [&_button]:text-left [&_svg]:shrink-0"
                    >
                        <div
                            data-detail-action-tier="secondary"
                            className="flex flex-col gap-1"
                        >
                            {children(() => {
                                // Restore the trigger before the selected action
                                // opens/focuses its next dialog, not afterwards.
                                flushSync(() => setOpen(false));
                            })}
                        </div>
                    </Modal>,
                    document.body,
                )}
        </>
    );
}
