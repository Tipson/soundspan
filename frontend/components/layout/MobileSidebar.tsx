"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import {
    AudioWaveform,
    Download,
    Heart,
    Home,
    Inbox,
    Library,
    ListMusic,
    LogOut,
    Search,
    Settings,
    Shield,
    Upload,
    X,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { MOBILE_QUICK_LINKS } from "./socialNavigation";
import { BRAND_NAME } from "@/lib/brand";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface MobileSidebarProps {
    isOpen: boolean;
    onClose: () => void;
    hasActiveSessions: boolean;
}

const quickLinkIcons = {
    "/": Home,
    "/search": Search,
    "/vibe": AudioWaveform,
    "/library": Library,
} as const;

const personalLinks = [
    { name: "Liked songs", href: "/playlist/my-liked", icon: Heart },
    { name: "Playlists", href: "/playlists", icon: ListMusic },
    {
        name: "Downloads",
        href: "/library?tab=downloads",
        icon: Download,
    },
    { name: "Import playlist", href: "/import", icon: Upload },
] as const;

/**
 * Mobile account drawer. Primary playback navigation remains available in the
 * bottom bar; this drawer adds library shortcuts and account administration.
 */
export function MobileSidebar({ isOpen, onClose }: MobileSidebarProps) {
    const pathname = usePathname();
    const { user, logout } = useAuth();
    const { toast } = useToast();

    useEffect(() => {
        onClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname]);

    const handleLogout = async () => {
        try {
            await logout();
            toast.success("Logged out successfully");
            onClose();
        } catch (error) {
            sharedFrontendLogger.error("Logout error:", error);
            toast.error("Failed to logout");
        }
    };

    if (!isOpen) return null;

    const linkClassName = (active: boolean) =>
        cn(
            "flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light",
            active
                ? "bg-white/[0.09] text-white"
                : "text-content-secondary hover:bg-white/[0.055] hover:text-white",
        );

    return (
        <>
            <button
                type="button"
                className="fixed inset-0 z-50 cursor-default bg-black/70 backdrop-blur-[2px]"
                onClick={onClose}
                aria-label="Close menu backdrop"
            />

            <aside
                className="mobile-sidebar-sheet fixed inset-y-0 left-0 z-[60] flex w-[min(88vw,320px)] flex-col overflow-hidden"
                style={{
                    paddingTop: "var(--safe-area-top)",
                    paddingBottom: "var(--safe-area-bottom)",
                }}
                role="dialog"
                aria-modal="true"
                aria-label="Navigation menu"
            >
                <div className="flex min-h-16 items-center justify-between border-b border-white/[0.07] px-4">
                    <Link
                        href="/"
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        onClick={onClose}
                    >
                        <Image
                            src="/assets/images/soundspan.webp"
                            alt={BRAND_NAME}
                            width={36}
                            height={36}
                            sizes="36px"
                            className="flex-shrink-0"
                        />
                        <span className="brand-wordmark truncate text-[1.75rem] font-bold text-white">
                            {BRAND_NAME}
                        </span>
                    </Link>
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-11 w-11 items-center justify-center rounded-xl text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        aria-label="Close menu"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <nav
                    className="flex-1 overflow-y-auto px-3 py-4"
                    aria-label="Mobile menu"
                >
                    <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-content-muted">
                        Listen
                    </p>
                    <div className="space-y-1">
                        {MOBILE_QUICK_LINKS.map((link) => {
                            const Icon =
                                quickLinkIcons[
                                    link.href as keyof typeof quickLinkIcons
                                ];
                            const active =
                                link.href === "/"
                                    ? pathname === "/"
                                    : pathname.startsWith(link.href);
                            return (
                                <Link
                                    key={link.href}
                                    href={link.href}
                                    aria-current={active ? "page" : undefined}
                                    aria-label={link.name}
                                    className={linkClassName(active)}
                                >
                                    <Icon className="h-5 w-5" />
                                    <span>{link.name}</span>
                                </Link>
                            );
                        })}
                    </div>

                    <div className="my-4 border-t border-white/[0.07]" />
                    <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-content-muted">
                        Your music
                    </p>
                    <div className="space-y-1">
                        {personalLinks.map((link) => {
                            const active = pathname === link.href.split("?")[0];
                            const Icon = link.icon;
                            return (
                                <Link
                                    key={link.href}
                                    href={link.href}
                                    aria-current={active ? "page" : undefined}
                                    className={linkClassName(active)}
                                >
                                    <Icon className="h-5 w-5" />
                                    <span>{link.name}</span>
                                </Link>
                            );
                        })}
                    </div>

                    <div className="my-4 border-t border-white/[0.07]" />
                    <Link
                        href="/settings"
                        aria-current={
                            pathname === "/settings" ? "page" : undefined
                        }
                        className={linkClassName(pathname === "/settings")}
                    >
                        <Settings className="h-5 w-5" />
                        <span>Settings</span>
                    </Link>

                    {user?.role === "admin" ? (
                        <>
                            <Link
                                href="/requests"
                                aria-current={
                                    pathname === "/requests"
                                        ? "page"
                                        : undefined
                                }
                                className={linkClassName(
                                    pathname === "/requests",
                                )}
                            >
                                <Inbox className="h-5 w-5" />
                                <span>Requests</span>
                            </Link>
                            <Link
                                href="/admin"
                                aria-current={
                                    pathname === "/admin" ? "page" : undefined
                                }
                                className={linkClassName(pathname === "/admin")}
                            >
                                <Shield className="h-5 w-5" />
                                <span>Admin</span>
                            </Link>
                        </>
                    ) : null}
                </nav>

                <div className="border-t border-white/[0.07] p-3">
                    <button
                        type="button"
                        onClick={handleLogout}
                        className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
                    >
                        <LogOut className="h-5 w-5" />
                        <span className="text-[15px] font-medium">Logout</span>
                    </button>
                </div>
            </aside>
        </>
    );
}
