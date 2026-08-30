"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
    DeviceAuthLinkPanel,
    SettingsRow,
    SettingsSelect,
    SettingsToggle,
    IntegrationCard,
} from "../ui";
import { UserSettings } from "../../types";
import { CheckCircle, XCircle, AlertTriangle, Music2 } from "lucide-react";
import { api } from "@/lib/api";
import { useDeviceAuthPolling } from "@/hooks/useDeviceAuthPolling";
import { userFacingError } from "@/lib/i18n/ru";

interface TidalStreamingCardProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
}

const QUALITY_OPTIONS = [
    { value: "LOW", label: "Низкое (AAC 96 кбит/с)" },
    { value: "HIGH", label: "Высокое (AAC 320 кбит/с)" },
    { value: "LOSSLESS", label: "Без потерь (FLAC 16 бит / 44,1 кГц)" },
    {
        value: "HI_RES_LOSSLESS",
        label: "Максимальное / Hi-Res (FLAC до 24 бит / 192 кГц)",
    },
];

/**
 * Renders the TidalStreamingCard component.
 */
export function TidalStreamingCard({
    settings,
    onUpdate,
}: TidalStreamingCardProps) {
    // Service status
    const [tidalEnabled, setTidalEnabled] = useState(false);
    const [tidalAvailable, setTidalAvailable] = useState(false);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [statusLoading, setStatusLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const [copied, setCopied] = useState(false);
    const authResultRef = useRef<Awaited<
        ReturnType<typeof api.pollTidalAuth>
    > | null>(null);

    // Check TIDAL streaming status on mount
    useEffect(() => {
        checkStatus();
    }, []);

    const checkStatus = useCallback(async () => {
        setStatusLoading(true);
        try {
            const status = await api.getTidalStreamingStatus();
            setTidalEnabled(status.enabled);
            setTidalAvailable(status.available);
            setIsAuthenticated(status.authenticated);
        } catch {
            // TIDAL streaming not available
        }
        setStatusLoading(false);
    }, []);

    const initiateAuth = useCallback(async () => {
        const deviceAuth = await api.initiateTidalAuth();
        let authLink =
            deviceAuth.verification_uri_complete || deviceAuth.verification_uri;
        if (authLink && !authLink.startsWith("http"))
            authLink = `https://${authLink}`;
        return {
            deviceCode: deviceAuth.device_code,
            verificationUri: authLink,
            userCode: deviceAuth.user_code || "",
            pollIntervalMs: (deviceAuth.interval || 5) * 1000,
            expiresAtMs: Date.now() + (deviceAuth.expires_in || 300) * 1000,
        };
    }, []);

    const pollAuth = useCallback(async (deviceCode: string) => {
        const result = await api.pollTidalAuth(deviceCode);
        if (result.status === "pending") return { status: "pending" } as const;
        if (result.status === "error") {
            return {
                status: "error",
                message: userFacingError(
                    result.error,
                    "Не удалось войти в аккаунт",
                ),
            } as const;
        }
        authResultRef.current = result;
        return { status: "success" } as const;
    }, []);

    const handleSessionStarted = useCallback(
        async (session: { userCode?: string; verificationUri: string }) => {
            try {
                await navigator.clipboard.writeText(session.userCode || "");
                setCopied(true);
                setTimeout(() => setCopied(false), 3000);
            } catch {
                // Clipboard may not be available
            }
            window.open(
                session.verificationUri,
                "_blank",
                "noopener,noreferrer",
            );
        },
        [],
    );

    const handleAuthSuccess = useCallback(() => {
        const result = authResultRef.current;
        if (!result) return;
        setSuccess(`Подключён аккаунт ${result.username || "TIDAL"}`);
        setError(null);
        setIsAuthenticated(true);
    }, []);

    const {
        phase: authState,
        session: authSession,
        error: authError,
        timeLeftSeconds: timeLeft,
        start: startAuthentication,
        cancel: cancelAuthentication,
    } = useDeviceAuthPolling({
        initiate: initiateAuth,
        poll: pollAuth,
        onSessionStarted: handleSessionStarted,
        onSuccess: handleAuthSuccess,
        expiredMessage: "Код входа истёк. Попробуйте ещё раз.",
        startErrorMessage: "Не удалось начать вход в TIDAL",
    });
    const authUrl = authSession?.verificationUri || "";
    const userCode = authSession?.userCode || "";

    const handleLinkAccount = useCallback(async () => {
        setError(null);
        setSuccess(null);
        await startAuthentication();
    }, [startAuthentication]);

    const handleCancelLink = useCallback(() => {
        cancelAuthentication();
        setError(null);
    }, [cancelAuthentication]);

    const handleDisconnect = useCallback(async () => {
        try {
            await api.clearTidalStreamingAuth();
            setIsAuthenticated(false);
            cancelAuthentication();
            setSuccess(null);
            setError(null);
        } catch (err: unknown) {
            setError(userFacingError(err, "Не удалось отключиться"));
        }
    }, [cancelAuthentication]);

    const handleCopyCode = useCallback(async () => {
        if (!userCode) return;
        try {
            await navigator.clipboard.writeText(userCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            const textarea = document.createElement("textarea");
            textarea.value = userCode;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }, [userCode]);

    // Derived card state
    const isDisabled = !statusLoading && (!tidalEnabled || !tidalAvailable);
    const disabledReason = !tidalEnabled
        ? "Интеграция не включена. Обратитесь к администратору."
        : !tidalAvailable
          ? "Сервис TIDAL не запущен"
          : undefined;
    const isExpanded =
        isAuthenticated || authState === "polling" || authState === "loading";

    const statusText = statusLoading
        ? "Проверка…"
        : isAuthenticated
          ? "Подключено"
          : "Не подключено";

    const statusColor: "green" | "red" | "gray" = statusLoading
        ? "gray"
        : isAuthenticated
          ? "green"
          : "red";

    const warningBanner = (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200/80">
                Интеграция не связана с TIDAL и не одобрена им. Требуется
                активная подписка TIDAL. Вы отвечаете за соблюдение условий
                использования TIDAL.
            </p>
        </div>
    );

    return (
        <IntegrationCard
            icon={<Music2 className="w-5 h-5 text-cyan-400" />}
            title="TIDAL"
            statusText={statusText}
            statusColor={statusColor}
            connected={isAuthenticated}
            onConnect={handleLinkAccount}
            onDisconnect={handleDisconnect}
            isLoading={statusLoading || authState === "loading"}
            expanded={isExpanded}
            disabled={isDisabled}
            disabledReason={disabledReason}
            warning={warningBanner}
        >
            {/* Device Code Auth Flow (not authenticated) */}
            {!isAuthenticated && tidalAvailable && (
                <div className="space-y-3">
                    {/* In linking flow — show device code + verification URL */}
                    {userCode && authState === "polling" && (
                        <DeviceAuthLinkPanel
                            userCode={userCode}
                            verificationUrl={authUrl}
                            timeLeftSeconds={timeLeft}
                            copied={copied}
                            onCopyCode={handleCopyCode}
                            onCancel={handleCancelLink}
                            introText="Страница авторизации TIDAL должна была открыться. Если этого не произошло, нажмите ссылку ниже."
                            pasteInstruction="Введите этот код на странице TIDAL"
                            signInInstruction={
                                <>
                                    Войдите в аккаунт TIDAL и нажмите{" "}
                                    <strong className="text-white">
                                        «Разрешить»
                                    </strong>
                                </>
                            }
                            openLinkLabel="Открыть страницу авторизации TIDAL"
                        />
                    )}

                    {(authError || error) && (
                        <div className="flex items-start gap-2 text-sm text-red-400">
                            <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>{authError || error}</span>
                        </div>
                    )}

                    {success && (
                        <div className="flex items-center gap-2 text-sm text-green-400">
                            <CheckCircle className="w-4 h-4 flex-shrink-0" />
                            <span>{success}</span>
                        </div>
                    )}
                </div>
            )}

            {/* Success message (shown when already authenticated) */}
            {isAuthenticated && success && (
                <div className="flex items-center gap-2 text-sm text-green-400 mb-2">
                    <CheckCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{success}</span>
                </div>
            )}

            {/* Explore Page Toggle — only when connected (TIDAL requires auth) */}
            {isAuthenticated && (
                <SettingsRow
                    label="Показывать на главной"
                    description="Показывать миксы, настроения и подборки TIDAL на главной странице"
                >
                    <SettingsToggle
                        checked={settings.showTidalExplore}
                        onChange={(v) => onUpdate({ showTidalExplore: v })}
                    />
                </SettingsRow>
            )}

            {/* Streaming Quality */}
            {isAuthenticated && (
                <SettingsRow
                    label="Качество воспроизведения"
                    description="Качество звука при воспроизведении из TIDAL (нужен соответствующий тариф)"
                >
                    <SettingsSelect
                        value={settings.tidalStreamingQuality || "HIGH"}
                        onChange={(v) =>
                            onUpdate({
                                tidalStreamingQuality:
                                    v as UserSettings["tidalStreamingQuality"],
                            })
                        }
                        options={QUALITY_OPTIONS}
                    />
                </SettingsRow>
            )}
        </IntegrationCard>
    );
}
