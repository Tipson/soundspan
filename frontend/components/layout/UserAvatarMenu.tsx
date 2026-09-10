"use client";

import { useState, useRef, useEffect, useId } from "react";
import Image from "next/image";
import Link from "next/link";
import { Settings, LogOut, RefreshCw, Shield, Inbox } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { useJobStatus } from "@/hooks/useJobStatus";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { queryKeys } from "@/lib/queryKeys";
import { ru } from "@/lib/i18n/ru";

/**
 * Renders the UserAvatarMenu component.
 */
export function UserAvatarMenu() {
    const { user, logout } = useAuth();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [isOpen, setIsOpen] = useState(false);
    const [imgError, setImgError] = useState(false);
    const [imgKey, setImgKey] = useState(0);
    const [scanJobId, setScanJobId] = useState<string | null>(null);
    const [lastScanTime, setLastScanTime] = useState(0);
    const menuRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const menuId = useId();
    const initialFocus = useRef<"first" | "last">("first");
    const itemClass =
        "grid min-h-11 w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50";

    const { isPolling: isScanPolling } = useJobStatus(scanJobId, "scan", {
        onComplete: () => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.notifications(),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.enrichmentProgress(),
            });
            setScanJobId(null);
        },
        onError: () => setScanJobId(null),
    });

    const displayName = user?.displayName || user?.username || "?";
    const initial = displayName.charAt(0).toUpperCase();

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (
                menuRef.current &&
                !menuRef.current.contains(e.target as Node)
            ) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [isOpen]);

    // Listen for profile picture changes from other components
    useEffect(() => {
        const handlePfpChange = () => {
            setImgError(false);
            setImgKey((k) => k + 1);
        };
        window.addEventListener("profile-picture-changed", handlePfpChange);
        return () =>
            window.removeEventListener(
                "profile-picture-changed",
                handlePfpChange,
            );
    }, []);

    // Close on Escape
    useEffect(() => {
        if (!isOpen) return;
        const items = dropdownRef.current?.querySelectorAll<HTMLElement>(
            '[role="menuitem"]:not(:disabled)',
        );
        const first =
            initialFocus.current === "last"
                ? items?.[items.length - 1]
                : items?.[0];
        first?.focus();
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                setIsOpen(false);
                triggerRef.current?.focus();
            }
        };
        document.addEventListener("keydown", handleKey);
        return () => document.removeEventListener("keydown", handleKey);
    }, [isOpen]);

    const handleSync = async () => {
        if (isScanPolling) return;
        const now = Date.now();
        if (now - lastScanTime < 5000) return;

        try {
            setLastScanTime(now);
            const response = await api.scanLibrary();
            setScanJobId(response.jobId);
            queryClient.invalidateQueries({
                queryKey: queryKeys.notifications(),
            });
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to trigger library scan:",
                error,
            );
        }
    };

    const handleLogout = async () => {
        setIsOpen(false);
        try {
            await logout();
            toast.success(ru.nav.logoutSuccess);
        } catch (error) {
            sharedFrontendLogger.error("Logout error:", error);
            toast.error(ru.nav.logoutFailed);
        }
    };

    return (
        <div ref={menuRef} className="relative">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => {
                    initialFocus.current = "first";
                    setIsOpen((v) => !v);
                }}
                onKeyDown={(event) => {
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                        return;
                    event.preventDefault();
                    initialFocus.current =
                        event.key === "ArrowUp" ? "last" : "first";
                    setIsOpen(true);
                }}
                className={cn(
                    "w-9 h-9 rounded-full flex items-center justify-center overflow-hidden transition-all ring-2",
                    isOpen
                        ? "ring-white/40"
                        : "ring-transparent hover:ring-white/20",
                )}
                aria-label={ru.nav.userMenu}
                aria-haspopup="menu"
                aria-controls={isOpen ? menuId : undefined}
                aria-expanded={isOpen}
                title={displayName}
            >
                {user && !imgError ? (
                    <Image
                        key={imgKey}
                        src={`${api.getProfilePictureUrl(user.id)}?_k=${imgKey}`}
                        alt={displayName}
                        width={36}
                        height={36}
                        className="w-full h-full object-cover"
                        onError={() => setImgError(true)}
                        unoptimized
                    />
                ) : (
                    <span className="w-full h-full bg-white/10 text-white/80 text-xs font-semibold flex items-center justify-center">
                        {initial}
                    </span>
                )}
            </button>

            {isOpen && (
                <div
                    ref={dropdownRef}
                    id={menuId}
                    role="menu"
                    tabIndex={-1}
                    aria-label={ru.nav.userMenu}
                    onBlur={(event) => {
                        if (event.relatedTarget === triggerRef.current) return;
                        if (
                            !event.currentTarget.contains(
                                event.relatedTarget as Node | null,
                            )
                        )
                            setIsOpen(false);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Tab") {
                            setIsOpen(false);
                            return;
                        }
                        const items = [
                            ...event.currentTarget.querySelectorAll<HTMLElement>(
                                '[role="menuitem"]:not(:disabled)',
                            ),
                        ];
                        const index = items.indexOf(
                            document.activeElement as HTMLElement,
                        );
                        const next =
                            event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? items.length - 1
                                  : event.key === "ArrowDown"
                                    ? (index + 1) % items.length
                                    : event.key === "ArrowUp"
                                      ? (index + items.length - 1) %
                                        items.length
                                      : null;
                        if (next === null) return;
                        event.preventDefault();
                        items[next]?.focus();
                    }}
                    className="absolute right-0 top-full z-[100] mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface-elevated p-1.5 shadow-xl shadow-black/40"
                >
                    <div className="px-3 py-2 border-b border-white/10">
                        <p className="text-sm font-medium text-white truncate">
                            {displayName}
                        </p>
                    </div>
                    <button
                        role="menuitem"
                        tabIndex={-1}
                        onClick={handleSync}
                        disabled={isScanPolling}
                        className={itemClass}
                    >
                        <RefreshCw
                            className={cn(
                                "w-4 h-4",
                                isScanPolling && "animate-spin",
                            )}
                        />
                        {isScanPolling ? ru.nav.scanning : ru.nav.scanLibrary}
                    </button>
                    <Link
                        role="menuitem"
                        tabIndex={-1}
                        href="/settings"
                        onClick={() => setIsOpen(false)}
                        className={itemClass}
                    >
                        <Settings className="w-4 h-4" />
                        {ru.nav.settings}
                    </Link>
                    {user?.role === "admin" && (
                        <Link
                            role="menuitem"
                            tabIndex={-1}
                            href="/requests"
                            onClick={() => setIsOpen(false)}
                            className={itemClass}
                        >
                            <Inbox className="w-4 h-4" />
                            {ru.nav.requests}
                        </Link>
                    )}
                    {user?.role === "admin" && (
                        <Link
                            role="menuitem"
                            tabIndex={-1}
                            href="/admin"
                            onClick={() => setIsOpen(false)}
                            className={itemClass}
                        >
                            <Shield className="w-4 h-4" />
                            {ru.nav.admin}
                        </Link>
                    )}
                    <button
                        role="menuitem"
                        tabIndex={-1}
                        onClick={handleLogout}
                        className={cn(
                            itemClass,
                            "mt-1 border-t border-line text-red-400 hover:bg-red-500/10 hover:text-red-300",
                        )}
                    >
                        <LogOut className="w-4 h-4" />
                        {ru.nav.logout}
                    </button>
                </div>
            )}
        </div>
    );
}
