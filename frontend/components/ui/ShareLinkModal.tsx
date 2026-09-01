"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Link2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type ShareLinkRecord } from "@/lib/api";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    buildAbsoluteShareUrl,
    type ShareResourceType,
} from "@/lib/shareLinks";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { ru } from "@/lib/i18n/ru";

interface ShareLinkModalProps {
    isOpen: boolean;
    onClose: () => void;
    resourceType: ShareResourceType;
    resourceId: string;
    resourceName: string;
}

export function ShareLinkModal({
    isOpen,
    onClose,
    resourceType,
    resourceId,
    resourceName,
}: ShareLinkModalProps) {
    const [expiresAt, setExpiresAt] = useState("");
    const [maxPlays, setMaxPlays] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [createdLink, setCreatedLink] = useState<string | null>(null);
    const [existingLinks, setExistingLinks] = useState<ShareLinkRecord[]>([]);
    const [isLoadingLinks, setIsLoadingLinks] = useState(false);
    const [revokingId, setRevokingId] = useState<string | null>(null);

    const loadExistingLinks = useCallback(async () => {
        if (!resourceId) return;
        try {
            setIsLoadingLinks(true);
            const links = await api.listShareLinks();
            setExistingLinks(
                links.filter(
                    (link) =>
                        link.resourceType === resourceType &&
                        link.resourceId === resourceId &&
                        !link.revoked,
                ),
            );
        } catch (error) {
            sharedFrontendLogger.error("Failed to load share links", error);
            toast.error(ru.shareLink.loadFailed);
        } finally {
            setIsLoadingLinks(false);
        }
    }, [resourceId, resourceType]);

    useEffect(() => {
        if (isOpen) {
            void loadExistingLinks();
        } else {
            setExpiresAt("");
            setMaxPlays("");
            setIsSubmitting(false);
            setCreatedLink(null);
            setExistingLinks([]);
            setIsLoadingLinks(false);
            setRevokingId(null);
        }
    }, [isOpen, loadExistingLinks]);

    const resourceLabel = useMemo(
        () =>
            resourceType === "album"
                ? ru.shareLink.album
                : resourceType === "playlist"
                  ? ru.shareLink.playlist
                  : ru.shareLink.track,
        [resourceType],
    );

    const handleCreate = async () => {
        try {
            setIsSubmitting(true);
            const response = await api.createShareLink({
                resourceType,
                resourceId,
                expiresAt: expiresAt
                    ? new Date(expiresAt).toISOString()
                    : undefined,
                maxPlays: maxPlays ? Number(maxPlays) : undefined,
            });
            setCreatedLink(
                buildAbsoluteShareUrl(
                    response.accessPath,
                    window.location.origin,
                ),
            );
            await loadExistingLinks();
            toast.success(ru.shareLink.created);
        } catch (error) {
            sharedFrontendLogger.error("Failed to create share link", error);
            toast.error(ru.shareLink.createFailed);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCopy = async () => {
        if (!createdLink) return;
        await copyLinkToClipboard(createdLink);
    };

    const copyLinkToClipboard = async (url: string) => {
        try {
            await navigator.clipboard.writeText(url);
            toast.success(ru.shareLink.copied);
        } catch (error) {
            sharedFrontendLogger.error("Failed to copy share link", error);
            toast.error(ru.shareLink.copyFailed);
        }
    };

    const handleRevoke = async (id: string) => {
        try {
            setRevokingId(id);
            await api.revokeShareLink(id);
            setExistingLinks((current) =>
                current.filter((link) => link.id !== id),
            );
            toast.success(ru.shareLink.revoked);
        } catch (error) {
            sharedFrontendLogger.error("Failed to revoke share link", error);
            toast.error(ru.shareLink.revokeFailed);
        } finally {
            setRevokingId(null);
        }
    };

    const formatLinkMeta = (link: ShareLinkRecord) => {
        const meta: string[] = [];
        if (link.expiresAt) {
            meta.push(
                `${ru.shareLink.expires} ${new Date(link.expiresAt).toLocaleString("ru-RU")}`,
            );
        } else {
            meta.push(ru.shareLink.noExpiry);
        }

        if (link.maxPlays !== null) {
            meta.push(
                `${link.playCount}/${link.maxPlays} ${ru.shareLink.plays}`,
            );
        } else {
            meta.push(`${link.playCount} ${ru.shareLink.plays}`);
        }

        return meta.join(" • ");
    };

    const createDisabled =
        isSubmitting ||
        !resourceId ||
        (maxPlays.trim().length > 0 && Number(maxPlays) <= 0);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={`${ru.shareLink.title}: ${resourceLabel}`}
            className="max-w-lg"
        >
            <div className="space-y-4">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-start gap-3">
                        <div className="mt-0.5 rounded-full bg-brand/15 p-2 text-brand">
                            <Link2 className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-white">
                                {resourceName}
                            </p>
                            <p className="mt-1 text-sm text-gray-400">
                                {ru.shareLink.description}
                            </p>
                        </div>
                    </div>
                </div>

                {!createdLink ? (
                    <div className="space-y-4">
                        <div>
                            <label
                                htmlFor="share-link-expires-at"
                                className="mb-2 block text-sm font-medium text-gray-300"
                            >
                                {ru.shareLink.expiresAt}
                            </label>
                            <input
                                id="share-link-expires-at"
                                type="datetime-local"
                                value={expiresAt}
                                onChange={(event) =>
                                    setExpiresAt(event.target.value)
                                }
                                className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-brand/50"
                                style={{ colorScheme: "dark" }}
                            />
                            <p className="mt-2 text-xs text-gray-400">
                                {ru.shareLink.expiresHint}
                            </p>
                        </div>

                        <div>
                            <label
                                htmlFor="share-link-max-plays"
                                className="mb-2 block text-sm font-medium text-gray-300"
                            >
                                {ru.shareLink.maxPlays}
                            </label>
                            <input
                                id="share-link-max-plays"
                                type="number"
                                min="1"
                                step="1"
                                inputMode="numeric"
                                value={maxPlays}
                                onChange={(event) =>
                                    setMaxPlays(event.target.value)
                                }
                                placeholder={ru.shareLink.unlimited}
                                className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/50"
                            />
                            <p className="mt-2 text-xs text-gray-400">
                                {ru.shareLink.maxHint}
                            </p>
                        </div>

                        <div className="flex justify-end gap-3">
                            <Button variant="ghost" onClick={onClose}>
                                {ru.common.cancel}
                            </Button>
                            <Button
                                variant="primary"
                                onClick={() => void handleCreate()}
                                isLoading={isSubmitting}
                                disabled={createDisabled}
                            >
                                {ru.shareLink.create}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-200">
                            {ru.shareLink.ready}
                        </div>
                        <div>
                            <label
                                htmlFor="share-link-output"
                                className="mb-2 block text-sm font-medium text-gray-300"
                            >
                                {ru.shareLink.link}
                            </label>
                            <div className="flex gap-2">
                                <input
                                    id="share-link-output"
                                    readOnly
                                    value={createdLink}
                                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white focus:outline-none"
                                />
                                <Button
                                    variant="secondary"
                                    onClick={() => void handleCopy()}
                                >
                                    <Copy className="mr-2 h-4 w-4" />
                                    {ru.shareLink.copy}
                                </Button>
                            </div>
                        </div>
                        <div className="flex justify-end gap-3">
                            <Button variant="ghost" onClick={onClose}>
                                {ru.common.close}
                            </Button>
                        </div>
                    </div>
                )}

                <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-sm font-medium text-white">
                                {ru.shareLink.existing}
                            </h3>
                            <p className="mt-1 text-xs text-gray-400">
                                {ru.shareLink.existingHint}
                            </p>
                        </div>
                        <Button
                            variant="ghost"
                            onClick={() => void loadExistingLinks()}
                            disabled={isLoadingLinks}
                        >
                            {ru.shareLink.refresh}
                        </Button>
                    </div>

                    {isLoadingLinks ? (
                        <div className="flex items-center gap-2 text-sm text-gray-400">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {ru.shareLink.loading}
                        </div>
                    ) : existingLinks.length === 0 ? (
                        <p className="text-sm text-gray-400">
                            {ru.shareLink.none}
                        </p>
                    ) : (
                        <div className="space-y-3">
                            {existingLinks.map((link) => {
                                const absoluteUrl = buildAbsoluteShareUrl(
                                    link.accessPath,
                                    window.location.origin,
                                );
                                return (
                                    <div
                                        key={link.id}
                                        className="rounded-lg border border-white/10 bg-black/20 p-3"
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm text-white">
                                                    {absoluteUrl}
                                                </p>
                                                <p className="mt-1 text-xs text-gray-400">
                                                    {formatLinkMeta(link)}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    variant="secondary"
                                                    onClick={() =>
                                                        void copyLinkToClipboard(
                                                            absoluteUrl,
                                                        )
                                                    }
                                                >
                                                    <Copy className="mr-2 h-4 w-4" />
                                                    {ru.shareLink.copy}
                                                </Button>
                                                <Button
                                                    variant="danger"
                                                    onClick={() =>
                                                        void handleRevoke(
                                                            link.id,
                                                        )
                                                    }
                                                    disabled={
                                                        revokingId === link.id
                                                    }
                                                >
                                                    {revokingId === link.id ? (
                                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <Trash2 className="mr-2 h-4 w-4" />
                                                    )}
                                                    {ru.shareLink.revoke}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
}
