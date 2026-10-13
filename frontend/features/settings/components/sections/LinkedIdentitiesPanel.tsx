"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import type { ExternalIdentity } from "@/lib/api/auth";
import { createFrontendLogger } from "@/lib/logger";
import { formatDate } from "@/utils/formatTime";
import { ru, userFacingError } from "@/lib/i18n/ru";
import {
    SETTINGS_DANGER_BUTTON,
    SETTINGS_PRIMARY_BUTTON,
    SETTINGS_SECONDARY_BUTTON,
} from "../ui/settingsFieldStyles";

const logger = createFrontendLogger("Settings.LinkedIdentitiesPanel");

interface IdentityCardProps {
    identity: ExternalIdentity;
    providerName: string;
    onUnlink: (identity: ExternalIdentity) => void;
}

function IdentityCard({ identity, providerName, onUnlink }: IdentityCardProps) {
    return (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line py-4 last:border-0">
            <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                    <p className="break-words text-sm font-medium text-content">
                        {identity.displayName || identity.email || providerName}
                    </p>
                    <Badge variant="info" title={identity.provider}>
                        {providerName}
                    </Badge>
                </div>
                {identity.email && (
                    <p className="break-all text-sm text-content-muted">
                        {identity.email}
                    </p>
                )}
                <p className="text-xs text-gray-400">
                    Идентификатор {identity.subjectHint} · Подключено{" "}
                    {formatDate(identity.createdAt)}
                </p>
            </div>
            <button
                type="button"
                onClick={() => onUnlink(identity)}
                className={`${SETTINGS_SECONDARY_BUTTON} text-red-300 hover:text-red-200`}
            >
                Отвязать
            </button>
        </div>
    );
}

interface UnlinkIdentityModalProps {
    identity: ExternalIdentity | null;
    error: string;
    unlinking: boolean;
    onClose: () => void;
    onConfirm: () => void;
}

function UnlinkIdentityModal({
    identity,
    error,
    unlinking,
    onClose,
    onConfirm,
}: UnlinkIdentityModalProps) {
    return (
        <Modal
            isOpen={identity !== null}
            onClose={onClose}
            title="Отвязать аккаунт SSO"
        >
            <div className="space-y-4">
                <p className="text-sm text-gray-300">
                    Отвязать эту учётную запись от вашего аккаунта Soundspan?
                </p>
                {error && (
                    <p role="alert" className="text-sm text-red-400">
                        {error}
                    </p>
                )}
                <div className="flex flex-wrap justify-end gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className={SETTINGS_SECONDARY_BUTTON}
                    >
                        {ru.common.cancel}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={unlinking}
                        className={SETTINGS_DANGER_BUTTON}
                    >
                        {unlinking ? "Отключаем…" : "Отвязать"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

interface LinkedIdentitiesPanelProps {
    providerName: string;
}

interface IdentityListProps extends LinkedIdentitiesPanelProps {
    identities: ExternalIdentity[];
    loading: boolean;
    onUnlink: (identity: ExternalIdentity) => void;
}

function IdentityList({
    identities,
    loading,
    providerName,
    onUnlink,
}: IdentityListProps) {
    if (loading) {
        return <p className="text-sm text-gray-400">Загружаем аккаунты…</p>;
    }
    if (identities.length === 0) {
        return (
            <p className="text-sm text-gray-400">
                Подключённых аккаунтов SSO нет.
            </p>
        );
    }
    return identities.map((identity) => (
        <IdentityCard
            key={identity.id}
            identity={identity}
            providerName={providerName}
            onUnlink={onUnlink}
        />
    ));
}

function useIdentityData() {
    const [identities, setIdentities] = useState<ExternalIdentity[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    useEffect(() => {
        let active = true;
        const load = async () => {
            try {
                const result = await api.getExternalIdentities();
                if (active) setIdentities(result.identities);
            } catch (error) {
                logger.error("Failed to load linked identities", { error });
                if (active)
                    setLoadError("Не удалось загрузить связанные аккаунты");
            } finally {
                if (active) setLoading(false);
            }
        };
        void load();
        return () => {
            active = false;
        };
    }, []);
    return { identities, setIdentities, loading, loadError };
}

function useIdentityLink() {
    const [linking, setLinking] = useState(false);
    const [error, setError] = useState("");
    const link = async () => {
        setLinking(true);
        setError("");
        try {
            const { redirectUrl } = await api.startOidcLink();
            window.location.assign(redirectUrl);
        } catch (linkError) {
            logger.error("Failed to start OIDC link", { error: linkError });
            setError(
                userFacingError(linkError, "Не удалось начать подключение SSO"),
            );
            setLinking(false);
        }
    };
    return { linking, error, link };
}

function useIdentityUnlink(
    setIdentities: Dispatch<SetStateAction<ExternalIdentity[]>>,
) {
    const [unlinking, setUnlinking] = useState(false);
    const [error, setError] = useState("");
    const [credential, setCredential] = useState<ExternalIdentity | null>(null);
    const unlink = async () => {
        if (!credential) return;
        setUnlinking(true);
        setError("");
        try {
            await api.unlinkExternalIdentity(credential.id);
            setIdentities((current) =>
                current.filter((item) => item.id !== credential.id),
            );
            setCredential(null);
        } catch (unlinkError) {
            setError(
                userFacingError(unlinkError, "Не удалось отвязать аккаунт"),
            );
        } finally {
            setUnlinking(false);
        }
    };
    const close = () => {
        setCredential(null);
        setError("");
    };
    return { unlinking, error, credential, setCredential, unlink, close };
}

/** Renders linked OIDC identity controls for the current user. */
export function LinkedIdentitiesPanel({
    providerName,
}: LinkedIdentitiesPanelProps) {
    const { identities, setIdentities, loading, loadError } = useIdentityData();
    const link = useIdentityLink();
    const unlink = useIdentityUnlink(setIdentities);
    const visibleError = link.error || loadError;

    return (
        <div className="space-y-3">
            <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
                <div>
                    <h3 className="text-sm font-medium text-white">
                        Связанные аккаунты
                    </h3>
                    <p className="mt-1 text-sm leading-5 text-content-muted">
                        Аккаунты SSO, с помощью которых можно войти в ваш
                        профиль.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void link.link()}
                    disabled={link.linking}
                    className={`${SETTINGS_PRIMARY_BUTTON} shrink-0`}
                >
                    {link.linking
                        ? "Открываем SSO…"
                        : `Подключить аккаунт ${providerName}`}
                </button>
            </div>
            {visibleError && !unlink.credential && (
                <p role="alert" className="text-sm text-red-400">
                    {visibleError}
                </p>
            )}
            <IdentityList
                identities={identities}
                loading={loading}
                providerName={providerName}
                onUnlink={unlink.setCredential}
            />
            <UnlinkIdentityModal
                identity={unlink.credential}
                error={unlink.error}
                unlinking={unlink.unlinking}
                onClose={unlink.close}
                onConfirm={() => void unlink.unlink()}
            />
        </div>
    );
}
