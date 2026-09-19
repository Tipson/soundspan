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
    | "prompting"
    | "installing"
    | "installed";

function isStandaloneDisplayMode(): boolean {
    return (
        typeof window !== "undefined" &&
        (window.matchMedia("(display-mode: standalone)").matches ||
            (navigator as Navigator & { standalone?: boolean }).standalone ===
                true)
    );
}

function manualInstallView(): InstallPromptView {
    const isIOS =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    return isIOS ? "ios" : "unsupported";
}

/**
 * Renders the PWAInstallPrompt component.
 */
export function PWAInstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] =
        useState<BeforeInstallPromptEvent | null>(null);
    const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
    const installPendingRef = useRef(false);
    const acceptedAwaitingInstallRef = useRef(false);
    const installedRef = useRef(false);
    const [showPrompt, setShowPrompt] = useState(false);
    const [promptView, setPromptView] = useState<InstallPromptView>("install");

    useEffect(() => {
        // Capture the native browser prompt, but keep the persistent sidebar
        // action as the single entry point for installation.
        const handleBeforeInstallPrompt = (e: Event) => {
            e.preventDefault();
            const installPrompt = e as BeforeInstallPromptEvent;
            if (!installPendingRef.current)
                acceptedAwaitingInstallRef.current = false;
            deferredPromptRef.current = installPrompt;
            setDeferredPrompt(installPrompt);
            if (!installPendingRef.current && !installedRef.current)
                setPromptView("install");
        };

        const handleInstallRequest = () => {
            if (installedRef.current || isStandaloneDisplayMode()) {
                setPromptView("installed");
            } else if (installPendingRef.current) {
                setPromptView("prompting");
            } else if (acceptedAwaitingInstallRef.current) {
                setPromptView("installing");
            } else if (deferredPromptRef.current) {
                setPromptView("install");
            } else {
                setPromptView(manualInstallView());
            }
            setShowPrompt(true);
        };

        const handleAppInstalled = () => {
            deferredPromptRef.current = null;
            setDeferredPrompt(null);
            acceptedAwaitingInstallRef.current = false;
            installedRef.current = true;
            setPromptView("installed");
            setShowPrompt(false);
        };

        window.addEventListener(
            "beforeinstallprompt",
            handleBeforeInstallPrompt,
        );
        window.addEventListener("request-pwa-install", handleInstallRequest);
        window.addEventListener("appinstalled", handleAppInstalled);

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
        };
    }, []);

    const handleInstall = async () => {
        if (installPendingRef.current) return;
        const installPrompt = deferredPromptRef.current;
        if (!installPrompt) {
            setPromptView(
                installedRef.current || isStandaloneDisplayMode()
                    ? "installed"
                    : manualInstallView(),
            );
            setShowPrompt(true);
            return;
        }

        // A browser prompt event is single-use; consume it before yielding.
        installPendingRef.current = true;
        deferredPromptRef.current = null;
        setDeferredPrompt(null);
        setPromptView("prompting");
        try {
            await installPrompt.prompt();
            const { outcome } = await installPrompt.userChoice;
            if (installedRef.current) return;
            if (outcome === "accepted") {
                acceptedAwaitingInstallRef.current = true;
                setPromptView("installing");
            } else {
                acceptedAwaitingInstallRef.current = false;
                setShowPrompt(false);
            }
        } catch {
            acceptedAwaitingInstallRef.current = false;
            if (!installedRef.current) setPromptView(manualInstallView());
        } finally {
            installPendingRef.current = false;
        }
    };

    const handleDismiss = () => {
        setShowPrompt(false);
    };

    if (!showPrompt) return null;

    return (
        <div
            role="region"
            aria-label="Установка приложения"
            className="fixed bottom-[calc(var(--app-mini-player-height)+var(--app-bottom-nav-height)+var(--safe-area-bottom)+12px)] left-4 right-4 md:bottom-[calc(var(--app-player-height-desktop)+var(--safe-area-bottom)+12px)] md:left-auto md:right-4 md:w-80 z-50 animate-slide-up motion-reduce:animate-none"
        >
            <div className="bg-surface-hover border border-line-strong rounded-xl p-4 shadow-2xl">
                <button
                    onClick={handleDismiss}
                    type="button"
                    className="absolute top-1 right-1 flex h-11 w-11 items-center justify-center rounded-lg text-white/60 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                    aria-label="Закрыть"
                >
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>

                <div className="flex items-start gap-3">
                    <div className="p-2 bg-brand/20 rounded-lg">
                        <Smartphone
                            className="w-6 h-6 text-brand"
                            aria-hidden="true"
                        />
                    </div>
                    <div className="min-w-0 flex-1 pr-5">
                        <h3 className="text-white font-semibold text-sm mb-1">
                            {promptView === "installed"
                                ? `Приложение ${BRAND_NAME} уже установлено`
                                : promptView === "prompting"
                                  ? "Подтвердите установку"
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
                        ) : promptView === "prompting" ? (
                            <p
                                role="status"
                                aria-live="polite"
                                className="text-white/60 text-xs leading-relaxed"
                            >
                                Выберите действие в окне браузера.
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
                                Этот браузер не предложил установку. В меню
                                браузера выберите «Установить приложение» или
                                «Добавить на главный экран». Если вы открыли
                                сайт внутри Telegram или другого приложения,
                                откройте его в Chrome, Edge или Safari.
                            </p>
                        ) : promptView === "ios" ? (
                            <p className="text-white/60 text-xs leading-relaxed">
                                Откройте этот сайт в Safari. Нажмите{" "}
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
                        type="button"
                        onClick={handleInstall}
                        className="w-full min-h-11 mt-3 py-2 px-4 bg-brand text-black font-semibold text-sm rounded-lg hover:bg-brand-light transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                    >
                        <Download className="w-4 h-4" aria-hidden="true" />
                        Установить приложение
                    </button>
                )}
            </div>
        </div>
    );
}
