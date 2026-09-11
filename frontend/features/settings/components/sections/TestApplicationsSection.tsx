"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { queryKeys } from "@/lib/queryKeys";
import { SettingsSection } from "../ui/SettingsSection";

interface Application {
    id: string;
    telegram: string;
    device: string;
    createdAt: string;
    status: "pending" | "approved" | "registered" | "revoked";
    username: string | null;
    registrationPath: string | null;
}
interface ApplicationPage {
    items: Application[];
    nextCursor: string | null;
}
const labels = {
    pending: "Ожидает решения",
    approved: "Приглашение готово",
    registered: "Доступ активирован",
    revoked: "Приглашение отозвано",
};
const devices: Record<string, string> = {
    android: "Android",
    iphone: "iPhone / iPad",
    desktop: "Компьютер",
    multiple: "Несколько устройств",
};
const buttonClass =
    "inline-flex min-h-11 items-center justify-center rounded-xl border border-line px-4 py-2 text-sm font-semibold text-content hover:bg-surface-elevated disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

/** Administrator queue backed by persisted applications and single-use invitations. */
export function TestApplicationsSection() {
    const { user } = useAuth();
    const [cursor, setCursor] = useState<string | null>(null);
    const [approved, setApproved] = useState<Record<string, Application>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const query = useQuery({
        queryKey: queryKeys.testApplications(cursor),
        queryFn: () =>
            api.get<ApplicationPage>(
                `/auth/test-applications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
            ),
        enabled: user?.role === "admin",
        staleTime: 0,
    });
    if (user?.role !== "admin") return null;

    async function approve(id: string) {
        setBusy(id);
        setError("");
        setMessage("");
        try {
            const result = await api.post<Application>(
                `/auth/test-applications/${encodeURIComponent(id)}/approve`,
            );
            setApproved((previous) => ({ ...previous, [id]: result }));
            setMessage(
                "Приглашение готово. Скопируйте ссылку и отправьте её в Telegram заявителю.",
            );
        } catch {
            setError(
                "Не удалось одобрить заявку. Повторите попытку — второе приглашение не создастся.",
            );
        } finally {
            setBusy(null);
        }
    }
    async function refresh() {
        setError("");
        setMessage("");
        const result = await query.refetch();
        if (!result.isError) setApproved({});
    }
    async function copy(link: string) {
        try {
            await navigator.clipboard.writeText(link);
            setMessage(
                "Ссылка скопирована. Отправьте её заявителю в Telegram.",
            );
        } catch {
            setError(
                "Не удалось скопировать автоматически. Выделите ссылку в поле и скопируйте её вручную.",
            );
        }
    }
    return (
        <SettingsSection
            id="test-applications"
            title="Заявки на тестирование"
            description="Одобрите заявку и отправьте личную ссылку в Telegram. По ней участник один раз создаст аккаунт, а дальше будет входить с именем или почтой и паролем."
        >
            <div className="mb-4 flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    className={buttonClass}
                    disabled={query.isFetching}
                    onClick={() => void refresh()}
                >
                    Обновить
                </button>
                <a
                    className={buttonClass}
                    href="/welcome"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Открыть лендинг ↗
                </a>
            </div>
            {(query.isError || error) && (
                <p role="alert" className="py-3 text-sm text-red-300">
                    {error ||
                        "Не удалось загрузить заявки. Нажмите «Обновить»."}
                </p>
            )}
            {message && (
                <p
                    role="status"
                    className="py-3 text-sm text-content-secondary"
                >
                    {message}
                </p>
            )}
            {query.isPending && <p role="status">Загружаем заявки…</p>}
            {query.data?.items.length === 0 && (
                <p className="py-5 text-content-secondary">
                    Пока заявок нет. Новые заявки с лендинга появятся здесь.
                </p>
            )}
            <div className="space-y-3">
                {query.data?.items.map((original) => {
                    const item = approved[original.id] ?? original;
                    const link = item.registrationPath
                        ? new URL(item.registrationPath, window.location.origin)
                              .href
                        : null;
                    return (
                        <article
                            key={item.id}
                            className="rounded-2xl border border-line p-4"
                        >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <a
                                        href={`https://t.me/${encodeURIComponent(item.telegram)}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex min-h-11 items-center font-semibold text-brand-light"
                                    >
                                        @{item.telegram} ↗
                                    </a>
                                    <p className="text-sm text-content-muted">
                                        {new Date(
                                            item.createdAt,
                                        ).toLocaleString("ru-RU")}{" "}
                                        ·{" "}
                                        {devices[item.device] ||
                                            "Устройство не указано"}
                                    </p>
                                </div>
                                <span className="rounded-full bg-surface-elevated px-3 py-2 text-xs text-content-secondary">
                                    {labels[item.status]}
                                </span>
                            </div>
                            {item.status === "pending" && (
                                <button
                                    type="button"
                                    className={`${buttonClass} mt-4 bg-brand text-black`}
                                    disabled={busy !== null}
                                    onClick={() => void approve(item.id)}
                                >
                                    {busy === item.id
                                        ? "Одобряем…"
                                        : "Одобрить"}
                                </button>
                            )}
                            {link && (
                                <div className="mt-4 flex flex-wrap gap-2">
                                    <input
                                        aria-label={`Ссылка-приглашение для @${item.telegram}`}
                                        value={link}
                                        readOnly
                                        onFocus={(event) =>
                                            event.currentTarget.select()
                                        }
                                        className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-sm text-content"
                                    />
                                    <button
                                        type="button"
                                        className={buttonClass}
                                        onClick={() => void copy(link)}
                                    >
                                        Скопировать
                                    </button>
                                </div>
                            )}
                            {item.username && (
                                <p className="mt-3 text-sm text-content-secondary">
                                    Аккаунт: {item.username}
                                </p>
                            )}
                        </article>
                    );
                })}
            </div>
            <div className="mt-4 flex gap-3">
                {cursor && (
                    <button
                        className={buttonClass}
                        onClick={() => {
                            setCursor(null);
                            setApproved({});
                        }}
                    >
                        К новым заявкам
                    </button>
                )}
                {query.data?.nextCursor && (
                    <button
                        className={buttonClass}
                        onClick={() => {
                            setCursor(query.data!.nextCursor);
                            setApproved({});
                        }}
                    >
                        Следующие заявки
                    </button>
                )}
            </div>
        </SettingsSection>
    );
}
