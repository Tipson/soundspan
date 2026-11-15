"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { SettingsSection } from "../ui/SettingsSection";

const buttonClass =
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line px-4 py-2 text-sm font-semibold text-content transition-colors hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none";

interface DashboardWindow {
    opener: unknown;
    readonly closed: boolean;
    readonly location: { replace(url: string): void };
    close(): void;
}

interface QueueDashboardSectionProps {
    openWindow?: () => DashboardWindow | null;
}

/** Opens a short administrator-only dashboard session without URL credentials. */
export function QueueDashboardSection({
    openWindow = () => window.open("about:blank", "_blank"),
}: QueueDashboardSectionProps) {
    const { user } = useAuth();
    const [busy, setBusy] = useState<"open" | "end" | null>(null);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const openingWindow = useRef<DashboardWindow | null>(null);
    const openingRequest = useRef<AbortController | null>(null);

    useEffect(
        () => () => {
            openingRequest.current?.abort();
            openingRequest.current = null;
            openingWindow.current?.close();
            openingWindow.current = null;
        },
        [],
    );

    if (user?.role !== "admin") return null;

    async function openDashboard() {
        setError("");
        setStatus("");
        const popup = openWindow();
        if (!popup) {
            setError("Разрешите открытие вкладок для этого сайта и повторите.");
            return;
        }
        popup.opener = null;
        openingWindow.current = popup;
        const controller = new AbortController();
        openingRequest.current = controller;
        setBusy("open");
        try {
            await api.createQueueDashboardSession(controller.signal);
            if (openingWindow.current !== popup || popup.closed) return;
            popup.location.replace(api.getQueueDashboardUrl());
            openingWindow.current = null;
            setStatus("Панель открыта. Доступ действует 15 минут.");
        } catch {
            popup.close();
            openingWindow.current = null;
            setError(
                "Не удалось открыть панель. Проверьте подключение и повторите.",
            );
        } finally {
            if (openingRequest.current === controller)
                openingRequest.current = null;
            setBusy(null);
        }
    }

    async function endAccess() {
        setBusy("end");
        setError("");
        setStatus("");
        try {
            await api.endQueueDashboardSession();
            setStatus("Доступ завершён. Вкладку панели можно закрыть.");
        } catch {
            setError("Не удалось завершить доступ. Повторите попытку.");
        } finally {
            setBusy(null);
        }
    }

    return (
        <SettingsSection
            id="queue-dashboard"
            title="Фоновые задачи"
            description="Состояние очередей, ошибки и повторный запуск задач. Панель открывается в отдельной вкладке с доступом администратора на 15 минут."
        >
            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    className={buttonClass}
                    disabled={busy !== null}
                    onClick={() => void openDashboard()}
                >
                    <ExternalLink aria-hidden="true" size={16} />
                    {busy === "open" ? "Открываем панель…" : "Открыть панель"}
                </button>
                <button
                    type="button"
                    className={buttonClass}
                    disabled={busy !== null}
                    onClick={() => void endAccess()}
                >
                    {busy === "end" ? "Завершаем доступ…" : "Завершить доступ"}
                </button>
            </div>
            {error && (
                <p role="alert" className="pt-3 text-sm text-red-300">
                    {error}
                </p>
            )}
            {status && (
                <p
                    role="status"
                    className="pt-3 text-sm text-content-secondary"
                >
                    {status}
                </p>
            )}
        </SettingsSection>
    );
}
