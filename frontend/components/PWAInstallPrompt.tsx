"use client";

import { useEffect, useRef, useState } from "react";
import { X, Download, Smartphone } from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type InstallPromptView =
    | "install"
    | "ios"
    | "unsupported"
    | "installing"
    | "installed";

function isStandaloneDisplayMode(): boolean {
    return (
        typeof window !== "undefined" &&
        window.matchMedia("(display-mode: standalone)").matches
    );
}

function isDismissedRecently(): boolean {
    const dismissedAt = localStorage.getItem("pwa-prompt-dismissed");
    if (!dismissedAt) return false;
    const dismissedTime = parseInt(dismissedAt, 10);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return Date.now() - dismissedTime < sevenDays;
}

/**
 * Renders the PWAInstallPrompt component.
 */
export function PWAInstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] =
        useState<BeforeInstallPromptEvent | null>(null);
    const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
    const [showPrompt, setShowPrompt] = useState(false);
    const [isIOS] = useState(() => {
        if (typeof window === "undefined") return false;
        return (
            /iPad|iPhone|iPod/.test(navigator.userAgent) &&
            !(window as unknown as Record<string, unknown>).MSStream
        );
    });
    const [isInstalled, setIsInstalled] = useState(isStandaloneDisplayMode);
    const [promptView, setPromptView] = useState<InstallPromptView>(() =>
        isStandaloneDisplayMode() ? "installed" : isIOS ? "ios" : "install",
    );

    useEffect(() => {
        const revealTimeouts: number[] = [];
        const revealLater = (delay: number) => {
            revealTimeouts.push(
                window.setTimeout(() => {
                    if (!isDismissedRecently()) setShowPrompt(true);
                }, delay),
            );
        };

        // Listen for beforeinstallprompt (Chrome, Edge, etc.)
        const handleBeforeInstallPrompt = (e: Event) => {
            e.preventDefault();
            const installPrompt = e as BeforeInstallPromptEvent;
            deferredPromptRef.current = installPrompt;
            setDeferredPrompt(installPrompt);
            setPromptView("install");
            if (!isDismissedRecently()) revealLater(3000);
        };

        const handleInstallRequest = () => {
            if (isInstalled || isStandaloneDisplayMode()) {
                setPromptView("installed");
            } else if (isIOS) {
                setPromptView("ios");
            } else if (deferredPromptRef.current) {
                setPromptView("install");
            } else {
                setPromptView("unsupported");
            }
            setShowPrompt(true);
        };

        const handleAppInstalled = () => {
            deferredPromptRef.current = null;
            setDeferredPrompt(null);
            setIsInstalled(true);
            setPromptView("installed");
            setShowPrompt(false);
        };

        window.addEventListener(
            "beforeinstallprompt",
            handleBeforeInstallPrompt,
        );
        window.addEventListener("request-pwa-install", handleInstallRequest);
        window.addEventListener("appinstalled", handleAppInstalled);

        // For iOS, show instructions after delay if on mobile
        if (isIOS && !isInstalled && !isDismissedRecently()) {
            revealLater(5000);
        }

        return () => {
            window.removeEventListener(
                "beforeinstallprompt",
                handleBeforeInstallPrompt,
            );
            window.removeEventListener(
                "request-pwa-install",
                handleInstallRequest,
            );
            window.removeEventListener("appinstalled", handleAppInstalled);
            revealTimeouts.forEach((timeout) => window.clearTimeout(timeout));
        };
    }, [isIOS, isInstalled]);

    const handleInstall = async () => {
        if (!deferredPrompt) {
            setPromptView(
                isInstalled || isStandaloneDisplayMode()
                    ? "installed"
                    : isIOS
                      ? "ios"
                      : "unsupported",
            );
            setShowPrompt(true);
            return;
        }

        await deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;

        if (outcome === "accepted") {
            setPromptView("installing");
            setShowPrompt(true);
        }

        deferredPromptRef.current = null;
        setDeferredPrompt(null);
    };

    const handleDismiss = () => {
        setShowPrompt(false);
        localStorage.setItem("pwa-prompt-dismissed", Date.now().toString());
    };

    if (!showPrompt) return null;

    return (
        <div className="fixed bottom-[calc(var(--app-mini-player-height)+var(--app-bottom-nav-height)+var(--safe-area-bottom)+12px)] left-4 right-4 md:bottom-[calc(var(--app-player-height-desktop)+var(--safe-area-bottom)+12px)] md:left-auto md:right-4 md:w-80 z-50 animate-slide-up">
            <div className="bg-surface-hover border border-line-strong rounded-xl p-4 shadow-2xl">
                <button
                    onClick={handleDismiss}
                    className="absolute top-2 right-2 p-1 text-white/50 hover:text-white/80 transition-colors"
                    aria-label="Закрыть"
                >
                    <X className="w-4 h-4" />
                </button>

                <div className="flex items-start gap-3">
                    <div className="p-2 bg-brand/20 rounded-lg">
                        <Smartphone className="w-6 h-6 text-brand" />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-white font-semibold text-sm mb-1">
                            {promptView === "installed"
                                ? `Приложение ${BRAND_NAME} уже установлено`
                                : promptView === "installing"
                                  ? "Завершаем установку"
                                  : promptView === "unsupported"
                                    ? "Установка недоступна"
                                    : `Установить ${BRAND_NAME}`}
                        </h3>
                        {promptView === "installed" ? (
                            <p className="text-white/60 text-xs leading-relaxed">
                                Приложение уже добавлено на это устройство и
                                готово к запуску.
                            </p>
                        ) : promptView === "installing" ? (
                            <p
                                role="status"
                                aria-live="polite"
                                className="text-white/60 text-xs leading-relaxed"
                            >
                                Подтверждение установки получено. Ждём, пока
                                браузер завершит добавление приложения.
                            </p>
                        ) : promptView === "unsupported" ? (
                            <p className="text-white/60 text-xs leading-relaxed">
                                Этот браузер не предложил установку. Проверьте
                                меню браузера или откройте {BRAND_NAME} в
                                Chrome, Edge или Safari.
                            </p>
                        ) : promptView === "ios" ? (
                            <p className="text-white/60 text-xs leading-relaxed">
                                Нажмите{" "}
                                <span className="text-white">«Поделиться»</span>
                                , затем выберите{" "}
                                <span className="text-white">
                                    «На экран “Домой”»
                                </span>{" "}
                                — так приложение будет всегда под рукой.
                            </p>
                        ) : (
                            <p className="text-white/60 text-xs leading-relaxed">
                                Добавьте {BRAND_NAME} на главный экран для
                                быстрого доступа и фонового воспроизведения.
                            </p>
                        )}
                    </div>
                </div>

                {promptView === "install" && deferredPrompt && (
                    <button
                        onClick={handleInstall}
                        className="w-full mt-3 py-2 px-4 bg-brand text-black font-semibold text-sm rounded-lg hover:bg-brand-light transition-colors flex items-center justify-center gap-2"
                    >
                        <Download className="w-4 h-4" />
                        Установить приложение
                    </button>
                )}
            </div>
        </div>
    );
}
