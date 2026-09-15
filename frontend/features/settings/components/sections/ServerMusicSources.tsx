"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type {
    MusicSourceCandidate,
    MusicSourceConnectionStatus,
    MusicSourceProvider,
    MusicSourceHealth,
} from "@/lib/api/musicSources";

const providers: Array<{ id: MusicSourceProvider; name: string }> = [
    { id: "yandex", name: "Яндекс Музыка" },
    { id: "vk", name: "VK Музыка" },
];
const control =
    "min-h-11 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-content disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
const failureLabels: Record<string, string> = {
    rate_limit: "Лимит запросов источника",
    provider_challenge: "Источник запросил дополнительную проверку",
    auth_required: "Нужно обновить авторизацию источника",
    entitlement_required: "Источник ограничил доступ аккаунта к музыке",
};

/** Admin-only connection editor and explicit playback diagnostic, with no persisted client secrets. */
export function ServerMusicSources() {
    const [connections, setConnections] = useState<
        MusicSourceConnectionStatus[]
    >([]);
    const [health, setHealth] = useState<MusicSourceHealth | null>(null);
    const [tokens, setTokens] = useState<Record<MusicSourceProvider, string>>({
        yandex: "",
        vk: "",
    });
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [query, setQuery] = useState("");
    const [tracks, setTracks] = useState<MusicSourceCandidate[]>([]);
    const [playback, setPlayback] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        api.getMusicSourceConnections()
            .then((r) => {
                if (active) {
                    setConnections(r.connections);
                    setHealth(r.health);
                }
            })
            .catch(() => {
                if (active)
                    setMessage(
                        "Не удалось загрузить подключения. Попробуйте обновить страницу.",
                    );
            });
        return () => {
            active = false;
        };
    }, []);
    async function refresh() {
        if (busy) return;
        setBusy(true);
        try {
            const result = await api.getMusicSourceConnections();
            setConnections(result.connections);
            setHealth(result.health);
            setMessage("Диагностика обновлена.");
        } catch {
            setMessage("Не удалось обновить диагностику. Попробуйте ещё раз.");
        } finally {
            setBusy(false);
        }
    }
    async function save(
        provider: MusicSourceProvider,
        enabled: boolean,
        replace = false,
    ) {
        if (busy) return;
        setBusy(true);
        setMessage("");
        try {
            await api.saveMusicSourceConnection(provider, {
                enabled,
                ...(replace && tokens[provider]
                    ? { token: tokens[provider].trim() }
                    : {}),
            });
            setTokens((current) => ({ ...current, [provider]: "" }));
            const result = await api.getMusicSourceConnections();
            setConnections(result.connections);
            setHealth(result.health);
            setPlayback(null);
            setMessage("Настройки подключения сохранены.");
        } catch {
            setMessage(
                "Подключение не сохранено. Проверьте авторизацию администратора и настройки источника.",
            );
        } finally {
            setBusy(false);
        }
    }
    async function search(provider: MusicSourceProvider) {
        setBusy(true);
        setMessage("");
        setPlayback(null);
        try {
            const r = await api.searchMusicSource(provider, query);
            setTracks(r.tracks);
            if (!r.tracks.length)
                setMessage("Источник не вернул подходящих записей.");
        } catch {
            setTracks([]);
            setMessage(
                "Источник недоступен. Проверьте разрешения, срок авторизации и доступ аккаунта к музыке.",
            );
        } finally {
            setBusy(false);
        }
    }
    async function play(track: MusicSourceCandidate) {
        setBusy(true);
        setMessage("");
        setPlayback(null);
        try {
            const r = await api.resolveMusicSource(track);
            if (
                r.playback &&
                /^\/api\/music-sources\/leases\/[a-f0-9]{48}\/stream$/.test(
                    r.playback.streamPath,
                )
            )
                setPlayback(r.playback.streamPath);
            else
                setMessage(
                    "Полный поток с точной версией записи не подтверждён.",
                );
        } catch {
            setMessage(
                "Не удалось подготовить воспроизведение. Источник может быть временно недоступен.",
            );
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="mt-6 space-y-5 border-t border-white/10 pt-6">
            <div>
                <h3 className="font-semibold text-content">
                    Общие музыкальные источники
                </h3>
                <p className="mt-1 text-sm leading-6 text-content-secondary">
                    Подключения для всей платформы. Слушатели пользуются только
                    своим аккаунтом Soundspan. Ключи доступа сохраняются на
                    сервере в зашифрованном виде.
                </p>
                <button
                    type="button"
                    className={`${control} mt-3`}
                    disabled={busy}
                    onClick={() => void refresh()}
                >
                    Обновить диагностику
                </button>
                {health?.usage ? (
                    <p className="mt-2 text-xs leading-5 text-content-secondary">
                        Статистика с запуска сервера. Запросы аудио включают
                        перемотки и повторы.
                    </p>
                ) : null}
            </div>
            {providers.map(({ id, name }) => {
                const state = connections.find((c) => c.provider === id);
                const usage = health?.usage?.providers[id];
                const circuit = health?.circuits.find(
                    (c) =>
                        c.connection === `${id}:${state?.version}` &&
                        c.until > Date.now(),
                );
                return (
                    <fieldset
                        key={id}
                        className="space-y-3 rounded-2xl border border-white/10 p-4"
                        disabled={busy}
                    >
                        <legend className="px-2 font-medium text-content">
                            {name}
                        </legend>
                        <p className="text-sm text-content-secondary">
                            {state?.configured
                                ? state.enabled
                                    ? "Настроен · включён"
                                    : "Настроен · выключен"
                                : "Не подключён"}
                        </p>
                        {state?.enabled && circuit ? (
                            <p className="text-sm text-content-secondary">
                                {failureLabels[circuit.code] ??
                                    "Источник временно приостановлен"}
                                . Повторные запросы отложены до{" "}
                                {new Date(circuit.until).toLocaleTimeString(
                                    "ru-RU",
                                    { hour: "2-digit", minute: "2-digit" },
                                )}
                                .
                            </p>
                        ) : null}
                        {usage ? (
                            <dl className="grid grid-cols-2 gap-3 text-xs text-content-secondary">
                                <div>
                                    <dt>Выбран для воспроизведения</dt>
                                    <dd className="mt-1 text-base text-content">
                                        {usage.selected}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Запросы аудио</dt>
                                    <dd className="mt-1 text-base text-content">
                                        {usage.streamRequests}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Ошибки источника</dt>
                                    <dd className="mt-1 text-base text-content">
                                        {usage.resolutionFailed +
                                            usage.streamFailed}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Отменённые запросы</dt>
                                    <dd className="mt-1 text-base text-content">
                                        {usage.resolutionCancelled +
                                            usage.streamCancelled}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Точная запись не найдена</dt>
                                    <dd className="mt-1 text-base text-content">
                                        {usage.noMatch}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Активные потоки</dt>
                                    <dd className="mt-1 text-base text-content">
                                        {health?.activeStreams[
                                            `${id}:${state?.version}`
                                        ] ?? 0}
                                    </dd>
                                </div>
                            </dl>
                        ) : null}
                        <label
                            className="block text-sm text-content-secondary"
                            htmlFor={`music-source-${id}`}
                        >
                            Токен выделенного аккаунта
                        </label>
                        <input
                            id={`music-source-${id}`}
                            type="password"
                            autoComplete="new-password"
                            spellCheck={false}
                            maxLength={8192}
                            className={`${control} w-full`}
                            value={tokens[id]}
                            onChange={(e) =>
                                setTokens((current) => ({
                                    ...current,
                                    [id]: e.target.value,
                                }))
                            }
                            placeholder={
                                state?.configured
                                    ? "Оставьте пустым, чтобы сохранить текущий"
                                    : "Введите ключ доступа для этого источника"
                            }
                        />
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                className={control}
                                disabled={!tokens[id].trim()}
                                onClick={() => void save(id, false, true)}
                            >
                                Сохранить подключение
                            </button>
                            {state?.configured ? (
                                <button
                                    type="button"
                                    className={control}
                                    onClick={() =>
                                        void save(id, !state.enabled)
                                    }
                                >
                                    {state.enabled ? "Отключить" : "Включить"}
                                </button>
                            ) : null}
                        </div>
                    </fieldset>
                );
            })}
            <div className="space-y-3">
                <label
                    htmlFor="music-source-test-query"
                    className="block text-sm text-content"
                >
                    Проверка записи
                </label>
                <input
                    id="music-source-test-query"
                    className={`${control} w-full`}
                    value={query}
                    maxLength={200}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Исполнитель и название трека"
                />
                <div className="flex flex-wrap gap-2">
                    {providers.map(({ id, name }) => (
                        <button
                            key={id}
                            type="button"
                            className={control}
                            disabled={
                                busy ||
                                !query.trim() ||
                                !connections.some(
                                    (c) => c.provider === id && c.enabled,
                                )
                            }
                            onClick={() => void search(id)}
                        >
                            Найти в {name}
                        </button>
                    ))}
                </div>
                <ul className="space-y-2">
                    {tracks.map((track) => (
                        <li
                            key={`${track.provider}:${track.id}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/5 p-3"
                        >
                            <span className="min-w-0 text-sm text-content">
                                {track.artists.join(", ")} — {track.title}
                            </span>
                            <button
                                type="button"
                                className={control}
                                disabled={busy}
                                onClick={() => void play(track)}
                            >
                                Проверить звук
                            </button>
                        </li>
                    ))}
                </ul>
                {playback ? (
                    <audio
                        key={playback}
                        controls
                        preload="metadata"
                        src={playback}
                        className="w-full"
                        onError={() =>
                            setMessage(
                                "Аудиопоток прервался. Проверка воспроизведения не пройдена.",
                            )
                        }
                    />
                ) : null}
            </div>
            <p
                role="status"
                aria-live="polite"
                className="text-sm text-content-secondary"
            >
                {busy ? "Проверяем…" : message}
            </p>
        </div>
    );
}
