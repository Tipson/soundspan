"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
    SettingsSection,
    SettingsRow,
    SettingsInput,
    SettingsToggle,
} from "../ui";
import { api } from "@/lib/api";
import type { ScrobblingStatus } from "@/lib/api/scrobbling";
import { lastFmDescription } from "@/features/settings/lastFmScrobblingCopy";
import { queryKeys } from "@/lib/queryKeys";
import { GradientSpinner } from "@/components/ui/GradientSpinner";

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

function ConnectionPill({ connected }: { connected: boolean }) {
    return connected ? (
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
            Подключено
        </span>
    ) : (
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-gray-400">
            Не подключено
        </span>
    );
}

const BUTTON_CLASS =
    "px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform";
const SUBTLE_BUTTON_CLASS =
    "px-3 py-1.5 text-sm rounded-full border border-white/15 text-gray-300 hover:bg-white/10 disabled:opacity-50 transition-colors";

interface ServiceMutations {
    disconnect: () => void;
    disconnectPending: boolean;
    setEnabled: (enabled: boolean) => void;
}

function useServiceMutations(
    service: "Last.fm" | "ListenBrainz",
    onChanged: () => void,
): ServiceMutations {
    const disconnect = useMutation({
        mutationFn: () =>
            service === "Last.fm"
                ? api.disconnectLastFm()
                : api.disconnectListenBrainz(),
        onSuccess: () => {
            toast.success(`${service} отключён`);
            onChanged();
        },
        onError: (error) =>
            toast.error(errorMessage(error, "Не удалось отключить сервис")),
    });
    const setEnabled = useMutation({
        mutationFn: (enabled: boolean) =>
            service === "Last.fm"
                ? api.setLastFmScrobblingEnabled(enabled)
                : api.setListenBrainzScrobblingEnabled(enabled),
        onSuccess: onChanged,
        onError: (error) =>
            toast.error(errorMessage(error, "Не удалось обновить настройку")),
    });
    return {
        disconnect: () => disconnect.mutate(),
        disconnectPending: disconnect.isPending,
        setEnabled: (enabled) => setEnabled.mutate(enabled),
    };
}

function ConnectedControls({
    toggleId,
    enabled,
    mutations,
}: {
    toggleId: string;
    enabled: boolean;
    mutations: ServiceMutations;
}) {
    return (
        <div className="flex items-center gap-3">
            <SettingsToggle
                id={toggleId}
                checked={enabled}
                onChange={mutations.setEnabled}
            />
            <button
                type="button"
                onClick={mutations.disconnect}
                disabled={mutations.disconnectPending}
                className={SUBTLE_BUTTON_CLASS}
            >
                Отключить
            </button>
        </div>
    );
}

function ListenBrainzConnectForm({ onChanged }: { onChanged: () => void }) {
    const [token, setToken] = useState("");
    const connect = useMutation({
        mutationFn: () => api.connectListenBrainz(token.trim()),
        onSuccess: () => {
            setToken("");
            toast.success("ListenBrainz подключён");
            onChanged();
        },
        onError: (error) =>
            toast.error(
                errorMessage(
                    error,
                    "ListenBrainz отклонил токен. Скопируйте его заново на listenbrainz.org/settings.",
                ),
            ),
    });
    return (
        <div className="flex items-center gap-3">
            <SettingsInput
                type="password"
                value={token}
                onChange={setToken}
                placeholder="Токен пользователя"
                className="w-56"
            />
            <button
                type="button"
                onClick={() => connect.mutate()}
                disabled={connect.isPending || token.trim() === ""}
                className={BUTTON_CLASS}
            >
                {connect.isPending ? "Проверяем…" : "Подключить"}
            </button>
        </div>
    );
}

function ListenBrainzRow({
    status,
    onChanged,
}: {
    status: ScrobblingStatus["listenbrainz"];
    onChanged: () => void;
}) {
    const mutations = useServiceMutations("ListenBrainz", onChanged);
    return (
        <SettingsRow
            label={
                <span className="inline-flex items-center gap-2">
                    ListenBrainz <ConnectionPill connected={status.connected} />
                </span>
            }
            description="Вставьте токен пользователя со страницы listenbrainz.org/settings"
        >
            {status.connected ? (
                <ConnectedControls
                    toggleId="listenbrainz-enabled"
                    enabled={status.enabled}
                    mutations={mutations}
                />
            ) : (
                <ListenBrainzConnectForm onChanged={onChanged} />
            )}
        </SettingsRow>
    );
}

function LastFmConnectFlow({ onChanged }: { onChanged: () => void }) {
    const [awaitingApproval, setAwaitingApproval] = useState(false);
    const startAuth = useMutation({
        mutationFn: () => api.startLastFmAuth(),
        onSuccess: ({ approvalUrl }) => {
            window.open(approvalUrl, "_blank", "noopener,noreferrer");
            setAwaitingApproval(true);
        },
        onError: (error) =>
            toast.error(
                errorMessage(error, "Не удалось начать вход в Last.fm"),
            ),
    });
    const completeAuth = useMutation({
        mutationFn: () => api.completeLastFmAuth(),
        onSuccess: () => {
            setAwaitingApproval(false);
            toast.success("Last.fm подключён");
            onChanged();
        },
        onError: (error) =>
            toast.error(
                errorMessage(
                    error,
                    "Last.fm ещё не подтвердил доступ. Разрешите доступ во вкладке Last.fm и повторите попытку.",
                ),
            ),
    });

    if (!awaitingApproval) {
        return (
            <button
                type="button"
                onClick={() => startAuth.mutate()}
                disabled={startAuth.isPending}
                className={BUTTON_CLASS}
            >
                {startAuth.isPending ? "Запускаем…" : "Подключить Last.fm"}
            </button>
        );
    }
    return (
        <div className="flex items-center gap-3">
            <button
                type="button"
                onClick={() => completeAuth.mutate()}
                disabled={completeAuth.isPending}
                className={BUTTON_CLASS}
            >
                {completeAuth.isPending
                    ? "Завершаем…"
                    : "Доступ подтверждён — завершить"}
            </button>
            <button
                type="button"
                onClick={() => setAwaitingApproval(false)}
                className={SUBTLE_BUTTON_CLASS}
            >
                Отмена
            </button>
        </div>
    );
}

function LastFmRow({
    status,
    onChanged,
}: {
    status: ScrobblingStatus["lastfm"];
    onChanged: () => void;
}) {
    const mutations = useServiceMutations("Last.fm", onChanged);
    return (
        <SettingsRow
            label={
                <span className="inline-flex items-center gap-2">
                    Last.fm <ConnectionPill connected={status.connected} />
                    {status.username && (
                        <span className="text-xs text-gray-400">
                            как {status.username}
                        </span>
                    )}
                </span>
            }
            description={lastFmDescription(status)}
        >
            {status.connected ? (
                <ConnectedControls
                    toggleId="lastfm-enabled"
                    enabled={status.enabled}
                    mutations={mutations}
                />
            ) : status.serverConfigured ? (
                <LastFmConnectFlow onChanged={onChanged} />
            ) : (
                <span className="text-sm text-gray-500">Недоступно</span>
            )}
        </SettingsRow>
    );
}

/**
 * Per-user scrobbling connections (GH #761): Last.fm and ListenBrainz.
 * Owns its own status fetch; tokens never round-trip to the client.
 */
export function ScrobblingSection() {
    const queryClient = useQueryClient();
    const { data: status, isLoading } = useQuery({
        queryKey: queryKeys.scrobblingStatus(),
        queryFn: () => api.getScrobblingStatus(),
        staleTime: 30 * 1000,
    });

    const refresh = () =>
        queryClient.invalidateQueries({
            queryKey: queryKeys.scrobblingStatus(),
        });

    return (
        <SettingsSection
            id="scrobbling"
            title="Скробблинг"
            description="Отправляйте прослушивания в сервисы музыкальной истории"
        >
            {isLoading || !status ? (
                <div className="flex items-center justify-center py-6">
                    <GradientSpinner size="sm" />
                </div>
            ) : (
                <>
                    <ListenBrainzRow
                        status={status.listenbrainz}
                        onChanged={refresh}
                    />
                    <LastFmRow status={status.lastfm} onChanged={refresh} />
                </>
            )}
        </SettingsSection>
    );
}
