import React, { useEffect, useState } from "react";
import { useAPIKeys } from "@/features/settings/hooks/useAPIKeys";
import { Modal } from "@/components/ui/Modal";
import { Copy, Trash2 } from "lucide-react";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { SettingsSection } from "../ui";
import { formatDate } from "@/utils/formatTime";
import {
    SETTINGS_DANGER_BUTTON,
    SETTINGS_PRIMARY_BUTTON,
    SETTINGS_SECONDARY_BUTTON,
    SETTINGS_FIELD_FOCUS_RING,
} from "../ui/settingsFieldStyles";

const EXPIRING_SOON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function getExpiryBadge(
    expiresAt: string,
): { label: string; variant: BadgeProps["variant"] } | null {
    const remainingMs = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remainingMs)) return null;
    if (remainingMs <= 0) return { label: "Истёк", variant: "error" };
    if (remainingMs <= EXPIRING_SOON_WINDOW_MS) {
        return { label: "Скоро истечёт", variant: "warning" };
    }
    return null;
}

function ApiKeyExpiry({ expiresAt }: { expiresAt: string }) {
    const badge = getExpiryBadge(expiresAt);
    return (
        <div className="flex items-center gap-2 whitespace-nowrap">
            <span>{formatDate(expiresAt)}</span>
            {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
        </div>
    );
}

/** Manages personal API keys with expiry feedback and explicit revoke confirmation. */
export const APIKeysSection: React.FC = () => {
    const {
        apiKeys,
        loadingApiKeys,
        generatedApiKey,
        showCreateApiKeyDialog,
        setShowCreateApiKeyDialog,
        loadApiKeys,
        createApiKey,
        revokeApiKey,
        clearGeneratedKey,
    } = useAPIKeys();

    const [newApiKeyName, setNewApiKeyName] = useState("");
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [copied, setCopied] = useState(false);
    const [createStatus, setCreateStatus] = useState<StatusType>("idle");
    const [createMessage, setCreateMessage] = useState("");
    const [revokeStatus, setRevokeStatus] = useState<StatusType>("idle");
    const [revokeMessage, setRevokeMessage] = useState("");

    useEffect(() => {
        loadApiKeys();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: API keys should only be loaded once on initial render
    }, []);

    const handleCreateApiKey = async () => {
        if (!newApiKeyName.trim()) {
            setCreateStatus("error");
            setCreateMessage("Укажите название");
            return;
        }

        setCreating(true);
        setCreateStatus("loading");
        const result = await createApiKey(newApiKeyName);
        if (result.success) {
            setCreateStatus("success");
            setCreateMessage("Создано");
            setNewApiKeyName("");
            setShowCreateApiKeyDialog(false);
        } else {
            setCreateStatus("error");
            setCreateMessage(result.error || "Не удалось создать ключ");
        }
        setCreating(false);
    };

    const handleRevokeApiKey = async () => {
        if (!confirmRevoke) return;

        setRevokeStatus("loading");
        const result = await revokeApiKey(confirmRevoke);
        if (result.success) {
            setRevokeStatus("success");
            setRevokeMessage("Отозван");
            setConfirmRevoke(null);
        } else {
            setRevokeStatus("error");
            setRevokeMessage(result.error || "Не удалось отозвать ключ");
        }
    };

    const handleCopyKey = () => {
        if (generatedApiKey) {
            navigator.clipboard.writeText(generatedApiKey);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const handleDismissKey = () => {
        clearGeneratedKey();
        setCopied(false);
    };

    return (
        <SettingsSection
            id="api-keys"
            title="Ключи API"
            description="Ключи для программного доступа к вашему аккаунту"
        >
            {/* Generated Key Display */}
            {generatedApiKey && (
                <div className="rounded-[10px] border border-warning/25 bg-warning/10 p-4 space-y-3">
                    <div className="flex items-start justify-between">
                        <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-medium text-yellow-200 mb-2">
                                Новый ключ API
                            </h3>
                            <div className="flex flex-wrap items-center gap-3">
                                <input
                                    type="text"
                                    readOnly
                                    value={generatedApiKey}
                                    aria-label="Созданный ключ API"
                                    className={`min-h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-surface-elevated px-3 py-2 text-base text-content font-mono ${SETTINGS_FIELD_FOCUS_RING}`}
                                />
                                <button
                                    onClick={handleCopyKey}
                                    className={SETTINGS_SECONDARY_BUTTON}
                                >
                                    <Copy className="w-4 h-4" />
                                    {copied ? "Скопировано" : "Копировать"}
                                </button>
                            </div>
                            <p className="text-xs text-yellow-200 mt-2">
                                Сохраните ключ сейчас: повторно он не
                                отображается
                            </p>
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <button
                            onClick={handleDismissKey}
                            className={SETTINGS_SECONDARY_BUTTON}
                        >
                            Скрыть
                        </button>
                    </div>
                </div>
            )}

            {/* Create Button */}
            <div>
                <button
                    onClick={() => setShowCreateApiKeyDialog(true)}
                    className={SETTINGS_PRIMARY_BUTTON}
                >
                    Создать ключ API
                </button>
            </div>

            {/* API Keys Table */}
            <div className="min-w-0 overflow-x-auto">
                <table className="block w-full md:table">
                    <thead className="hidden md:table-header-group">
                        <tr className="border-b border-surface-active">
                            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                                Название устройства
                            </th>
                            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                                Фрагмент ключа
                            </th>
                            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                                Создан
                            </th>
                            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                                Использован
                            </th>
                            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                                Истекает
                            </th>
                            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                                Действия
                            </th>
                        </tr>
                    </thead>
                    <tbody className="block md:table-row-group">
                        {loadingApiKeys ? (
                            <tr>
                                <td
                                    colSpan={6}
                                    className="py-8 text-center text-sm text-gray-400"
                                >
                                    Загружаем ключи API…
                                </td>
                            </tr>
                        ) : apiKeys.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={6}
                                    className="py-8 text-center text-sm text-gray-400"
                                >
                                    Ключей API пока нет
                                </td>
                            </tr>
                        ) : (
                            apiKeys.map((key) => (
                                <tr
                                    key={key.id}
                                    className="grid grid-cols-2 gap-3 border-b border-line py-4 md:table-row md:py-0 md:hover:bg-surface-hover"
                                >
                                    <td
                                        data-label="Название устройства"
                                        className="col-span-2 break-words text-sm text-content before:mb-1 before:block before:text-xs before:text-content-muted before:content-[attr(data-label)] md:px-3 md:py-3 md:before:hidden"
                                    >
                                        {key.name}
                                    </td>
                                    <td
                                        data-label="Фрагмент ключа"
                                        className="col-span-2 break-all text-sm font-mono text-content-muted before:mb-1 before:block before:font-sans before:text-xs before:content-[attr(data-label)] md:px-3 md:py-3 md:before:hidden"
                                    >
                                        {key.keyPreview}
                                    </td>
                                    <td
                                        data-label="Создан"
                                        className="text-sm tabular-nums text-content-muted before:mb-1 before:block before:text-xs before:content-[attr(data-label)] md:px-3 md:py-3 md:before:hidden"
                                    >
                                        {formatDate(key.createdAt)}
                                    </td>
                                    <td
                                        data-label="Использован"
                                        className="text-sm tabular-nums text-content-muted before:mb-1 before:block before:text-xs before:content-[attr(data-label)] md:px-3 md:py-3 md:before:hidden"
                                    >
                                        {key.lastUsedAt
                                            ? formatDate(key.lastUsedAt)
                                            : "Никогда"}
                                    </td>
                                    <td
                                        data-label="Истекает"
                                        className="col-span-2 text-sm tabular-nums text-content-muted before:mb-1 before:block before:text-xs before:content-[attr(data-label)] md:px-3 md:py-3 md:before:hidden"
                                    >
                                        <ApiKeyExpiry
                                            expiresAt={key.expiresAt}
                                        />
                                    </td>
                                    <td className="col-span-2 text-sm md:px-3 md:py-3">
                                        <button
                                            onClick={() =>
                                                setConfirmRevoke(key.id)
                                            }
                                            className={`${SETTINGS_SECONDARY_BUTTON} text-red-300 hover:text-red-200`}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                            Отозвать
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {/* Create API Key Dialog */}
            {showCreateApiKeyDialog && (
                <Modal
                    isOpen={true}
                    onClose={() => {
                        setShowCreateApiKeyDialog(false);
                        setNewApiKeyName("");
                        setCreateStatus("idle");
                    }}
                    title="Создать ключ API"
                >
                    <div className="space-y-4">
                        <div>
                            <label
                                htmlFor="api-key-device-name"
                                className="block text-sm font-medium text-content mb-2"
                            >
                                Название устройства
                            </label>
                            <input
                                id="api-key-device-name"
                                type="text"
                                value={newApiKeyName}
                                onChange={(e) =>
                                    setNewApiKeyName(e.target.value)
                                }
                                placeholder="Например, ноутбук или домашний сервер"
                                className={`min-h-11 w-full rounded-[10px] border border-line bg-surface-elevated px-3 py-2 text-base text-content placeholder:text-content-muted ${SETTINGS_FIELD_FOCUS_RING}`}
                            />
                        </div>
                        <div className="flex flex-wrap justify-end items-center gap-3">
                            <InlineStatus
                                status={createStatus}
                                message={createMessage}
                                onClear={() => setCreateStatus("idle")}
                            />
                            <button
                                onClick={() => {
                                    setShowCreateApiKeyDialog(false);
                                    setNewApiKeyName("");
                                    setCreateStatus("idle");
                                }}
                                disabled={creating}
                                className={SETTINGS_SECONDARY_BUTTON}
                            >
                                Отмена
                            </button>
                            <button
                                onClick={handleCreateApiKey}
                                disabled={!newApiKeyName.trim() || creating}
                                className={SETTINGS_PRIMARY_BUTTON}
                            >
                                {creating ? "Создаём…" : "Создать"}
                            </button>
                        </div>
                    </div>
                </Modal>
            )}

            {/* Revoke Confirmation Modal */}
            {confirmRevoke && (
                <Modal
                    isOpen={true}
                    onClose={() => {
                        setConfirmRevoke(null);
                        setRevokeStatus("idle");
                    }}
                    title="Отозвать ключ API"
                >
                    <div className="space-y-4">
                        <p className="text-sm text-gray-300">
                            Отозвать этот ключ API? Это действие нельзя
                            отменить.
                        </p>
                        <div className="flex flex-wrap justify-end items-center gap-3">
                            <InlineStatus
                                status={revokeStatus}
                                message={revokeMessage}
                                onClear={() => setRevokeStatus("idle")}
                            />
                            <button
                                onClick={() => {
                                    setConfirmRevoke(null);
                                    setRevokeStatus("idle");
                                }}
                                className={SETTINGS_SECONDARY_BUTTON}
                            >
                                Отмена
                            </button>
                            <button
                                onClick={handleRevokeApiKey}
                                className={SETTINGS_DANGER_BUTTON}
                            >
                                Отозвать
                            </button>
                        </div>
                    </div>
                </Modal>
            )}
        </SettingsSection>
    );
};
