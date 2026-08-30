"use client";

import { useState, useRef, useCallback } from "react";
import {
    SettingsRow,
    SettingsInput,
    SettingsSelect,
    SettingsToggle,
    IntegrationCard,
} from "../ui";
import { SystemSettings } from "../../types";
import {
    ExternalLink,
    CheckCircle,
    XCircle,
    Loader2,
    AlertTriangle,
    Music2,
} from "lucide-react";
import { InlineStatus } from "@/components/ui/InlineStatus";
import { api } from "@/lib/api";
import { useDeviceAuthPolling } from "@/hooks/useDeviceAuthPolling";
import { useConnectionTest } from "@/features/settings/hooks/useConnectionTest";

interface TidalCardProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (
        service: string,
    ) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
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
 * Renders the TidalCard component.
 */
export function TidalCard({
    settings,
    onUpdate,
    onTest,
    isTesting,
}: TidalCardProps) {
    const {
        status: testStatus,
        message: testMessage,
        runTest,
        reset,
    } = useConnectionTest({
        loadingMessage: "Проверяем TIDAL…",
        successMessage: "TIDAL подключён",
    });

    const [authMessage, setAuthMessage] = useState("");
    const authResultRef = useRef<Awaited<
        ReturnType<typeof api.tidalPollAuth>
    > | null>(null);

    const handleTest = () => runTest(() => onTest("tidal"));

    const initiateAuth = useCallback(async () => {
        const deviceAuth = await api.tidalDeviceAuth();
        let authLink = deviceAuth.verification_uri_complete;
        if (authLink && !authLink.startsWith("http"))
            authLink = `https://${authLink}`;
        return {
            deviceCode: deviceAuth.device_code,
            verificationUri: authLink,
            userCode: deviceAuth.user_code,
            pollIntervalMs: (deviceAuth.interval || 5) * 1000,
            expiresAtMs: Date.now() + (deviceAuth.expires_in || 300) * 1000,
        };
    }, []);

    const pollAuth = useCallback(async (deviceCode: string) => {
        const result = await api.tidalPollAuth(deviceCode);
        if (!result.success) return { status: "pending" } as const;
        authResultRef.current = result;
        return { status: "success" } as const;
    }, []);

    const handleAuthSuccess = useCallback(() => {
        const result = authResultRef.current;
        if (!result) return;
        setAuthMessage(`Выполнен вход: ${result.username || result.user_id}`);
        onUpdate({
            tidalEnabled: true,
            tidalConnected: true,
            tidalUserId: result.user_id || "",
            tidalCountryCode: result.country_code || "US",
        });
    }, [onUpdate]);

    const {
        phase: authState,
        session: authSession,
        error: authError,
        start: startAuthentication,
    } = useDeviceAuthPolling({
        initiate: initiateAuth,
        poll: pollAuth,
        onSessionStarted: (session) => {
            setAuthMessage("Ожидаем подтверждения…");
            window.open(
                session.verificationUri,
                "_blank",
                "noopener,noreferrer",
            );
        },
        onSuccess: handleAuthSuccess,
        expiredMessage: "Код устройства истёк. Попробуйте ещё раз.",
        startErrorMessage: "Не удалось начать вход с устройства",
    });
    const authUrl = authSession?.verificationUri || "";
    const handleAuthenticate = useCallback(async () => {
        setAuthMessage("Получаем код устройства…");
        await startAuthentication();
    }, [startAuthentication]);

    const isAuthenticated = !!(
        settings.tidalConnected && settings.tidalEnabled
    );

    const statusText = settings.tidalEnabled
        ? isAuthenticated
            ? `Включено (пользователь: ${settings.tidalUserId})`
            : "Включено — вход не выполнен"
        : "Выключено";

    const statusColor: "green" | "gray" =
        settings.tidalEnabled && isAuthenticated ? "green" : "gray";

    const warningBanner = (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200/80">
                Интеграция не связана с TIDAL и не одобрена им. Она
                предназначена для личного использования с вашей подпиской. Вы
                отвечаете за соблюдение условий TIDAL и применимых законов об
                авторском праве.
            </p>
        </div>
    );

    return (
        <IntegrationCard
            icon={<Music2 className="w-5 h-5 text-cyan-400" />}
            title="TIDAL"
            statusText={statusText}
            statusColor={statusColor}
            connected={false}
            expanded={settings.tidalEnabled}
            warning={warningBanner}
            headerAction={
                <SettingsToggle
                    id="tidal-enabled"
                    checked={settings.tidalEnabled}
                    onChange={(checked) => onUpdate({ tidalEnabled: checked })}
                />
            }
        >
            <div className="space-y-1">
                {/* Authentication */}
                <SettingsRow
                    label="Аккаунт TIDAL"
                    description={
                        isAuthenticated ? (
                            <span className="flex items-center gap-1.5 text-green-400">
                                <CheckCircle className="w-3 h-3" />
                                Выполнен вход (пользователь:{" "}
                                {settings.tidalUserId})
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5">
                                Войдите в аккаунт TIDAL с помощью кода
                                устройства
                                <a
                                    href="https://tidal.com"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-brand hover:underline"
                                >
                                    <ExternalLink className="w-3 h-3" />
                                    TIDAL
                                </a>
                            </span>
                        )
                    }
                >
                    <div className="flex flex-col gap-2">
                        <button
                            onClick={handleAuthenticate}
                            disabled={
                                authState === "loading" ||
                                authState === "polling"
                            }
                            className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                                hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                        >
                            {authState === "loading" && (
                                <span className="inline-flex items-center gap-2">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Запуск…
                                </span>
                            )}
                            {authState === "polling" && (
                                <span className="inline-flex items-center gap-2">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Ожидание подтверждения…
                                </span>
                            )}
                            {authState !== "loading" &&
                                authState !== "polling" &&
                                (isAuthenticated
                                    ? "Войти заново"
                                    : "Войти через TIDAL")}
                        </button>

                        {authState === "polling" && authUrl && (
                            <p className="text-xs text-white/60">
                                Если страница не открылась, перейдите по ссылке:{" "}
                                <a
                                    href={authUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-brand hover:underline break-all"
                                >
                                    {authUrl}
                                </a>
                            </p>
                        )}

                        {authState === "success" && (
                            <p className="text-xs text-green-400 flex items-center gap-1">
                                <CheckCircle className="w-3 h-3" />{" "}
                                {authMessage}
                            </p>
                        )}

                        {authState === "error" && (
                            <p className="text-xs text-red-400 flex items-center gap-1">
                                <XCircle className="w-3 h-3" /> {authError}
                            </p>
                        )}
                    </div>
                </SettingsRow>

                {/* Quality */}
                <SettingsRow
                    label="Качество скачивания"
                    description="Качество звука при скачивании из TIDAL (нужен соответствующий тариф)"
                >
                    <SettingsSelect
                        value={settings.tidalQuality || "HIGH"}
                        onChange={(v) =>
                            onUpdate({
                                tidalQuality:
                                    v as SystemSettings["tidalQuality"],
                            })
                        }
                        options={QUALITY_OPTIONS}
                    />
                </SettingsRow>

                {/* Country code */}
                <SettingsRow
                    label="Код страны"
                    description="Регион аккаунта TIDAL (определяется автоматически при входе)"
                >
                    <SettingsInput
                        value={settings.tidalCountryCode || "US"}
                        onChange={(v) => onUpdate({ tidalCountryCode: v })}
                        placeholder="US"
                        className="w-24"
                    />
                </SettingsRow>

                {/* File template */}
                <SettingsRow
                    label="Шаблон имён файлов"
                    description={
                        <div className="space-y-2">
                            <span>
                                Как будут организованы скачанные файлы.
                                Используйте{" "}
                                <code className="text-xs text-white/60">/</code>{" "}
                                для создания папок.
                            </span>
                            <details className="text-xs">
                                <summary className="cursor-pointer text-brand hover:underline select-none">
                                    Показать доступные переменные
                                </summary>
                                <div className="mt-2 space-y-2 text-white/60">
                                    <div>
                                        <p className="text-white/80 font-medium mb-1">
                                            Трек / элемент
                                        </p>
                                        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                                            <code>{"{item.number}"}</code>
                                            <span>
                                                Номер трека (используйте{" "}
                                                <code>{":02d"}</code> для
                                                дополнения нулём)
                                            </span>
                                            <code>{"{item.volume}"}</code>
                                            <span>Номер диска / тома</span>
                                            <code>{"{item.title}"}</code>
                                            <span>Название трека</span>
                                            <code>
                                                {"{item.title_version}"}
                                            </code>
                                            <span>
                                                Название и версия, например
                                                &quot;One More Time (Radio
                                                Edit)&quot;
                                            </span>
                                            <code>{"{item.artist}"}</code>
                                            <span>Основной исполнитель</span>
                                            <code>{"{item.artists}"}</code>
                                            <span>
                                                Все основные исполнители
                                            </span>
                                            <code>{"{item.features}"}</code>
                                            <span>
                                                Приглашённые исполнители
                                            </span>
                                            <code>{"{item.version}"}</code>
                                            <span>
                                                Версия записи (например,
                                                &quot;Remastered&quot;)
                                            </span>
                                            <code>{"{item.quality}"}</code>
                                            <span>Качество звука</span>
                                            <code>{"{item.isrc}"}</code>
                                            <span>Код ISRC</span>
                                            <code>{"{item.bpm}"}</code>
                                            <span>BPM (если доступно)</span>
                                            <code>{"{item.explicit}"}</code>
                                            <span>
                                                &quot;E&quot; для треков с
                                                ненормативной лексикой
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-white/80 font-medium mb-1">
                                            Альбом
                                        </p>
                                        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                                            <code>{"{album.artist}"}</code>
                                            <span>Исполнитель альбома</span>
                                            <code>{"{album.artists}"}</code>
                                            <span>Все исполнители альбома</span>
                                            <code>{"{album.title}"}</code>
                                            <span>Название альбома</span>
                                            <code>{"{album.date:%Y}"}</code>
                                            <span>
                                                Год выпуска (формат даты можно
                                                менять)
                                            </span>
                                            <code>{"{album.release}"}</code>
                                            <span>
                                                Тип: ALBUM, EP или SINGLE
                                            </span>
                                            <code>{"{album.explicit}"}</code>
                                            <span>
                                                &quot;E&quot; для релизов с
                                                ненормативной лексикой
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-white/80 font-medium mb-1">
                                            Примеры
                                        </p>
                                        <div className="space-y-1">
                                            <div>
                                                <code className="text-white/50">
                                                    {
                                                        "{album.artist}/{album.title}/{item.volume}-{item.number:02d} {item.title}"
                                                    }
                                                </code>
                                            </div>
                                            <div className="pl-3 text-white/40">
                                                → Pink Floyd/The Wall/1-04 The
                                                Happiest Days of Our Lives
                                            </div>
                                            <div>
                                                <code className="text-white/50">
                                                    {
                                                        "{album.artist}/{album.title} ({album.date:%Y})/{item.number:02d}. {item.title}"
                                                    }
                                                </code>
                                            </div>
                                            <div className="pl-3 text-white/40">
                                                → Pink Floyd/The Dark Side of
                                                the Moon (1973)/04. Time
                                            </div>
                                            <div>
                                                <code className="text-white/50">
                                                    {
                                                        "{item.artist} - {item.title}"
                                                    }
                                                </code>
                                            </div>
                                            <div className="pl-3 text-white/40">
                                                → Pink Floyd - Time (без
                                                вложенных папок)
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </details>
                        </div>
                    }
                >
                    <SettingsInput
                        value={
                            settings.tidalFileTemplate ||
                            "{album.artist}/{album.title}/{item.number:02d}. {item.title}"
                        }
                        onChange={(v) => onUpdate({ tidalFileTemplate: v })}
                        placeholder="{album.artist}/{album.title}/{item.number:02d}. {item.title}"
                        className="w-full max-w-md font-mono text-xs"
                    />
                </SettingsRow>

                {/* Test connection */}
                <div className="pt-2 space-y-2">
                    <div className="inline-flex items-center gap-3">
                        <button
                            onClick={handleTest}
                            disabled={isTesting || !isAuthenticated}
                            className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                                hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                        >
                            {testStatus === "loading"
                                ? "Проверка…"
                                : "Проверить подключение"}
                        </button>
                        <InlineStatus
                            status={testStatus}
                            message={testMessage}
                            onClear={reset}
                        />
                    </div>
                    <p className="text-xs text-white/40">
                        Скачанные файлы будут сохранены по выбранному шаблону
                    </p>
                </div>
            </div>
        </IntegrationCard>
    );
}
