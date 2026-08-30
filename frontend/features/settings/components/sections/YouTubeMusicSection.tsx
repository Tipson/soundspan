"use client";

import { useState, useEffect, useCallback } from "react";
import {
    DeviceAuthLinkPanel,
    SettingsSection,
    SettingsRow,
    SettingsToggle,
    SettingsSelect,
    SettingsInput,
    IntegrationCard,
} from "../ui";
import { UserSettings, SystemSettings } from "../../types";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import { useDeviceAuthPolling } from "@/hooks/useDeviceAuthPolling";
// lucide-react 1.x removed brand icons (Youtube included); SquarePlay is the closest generic stand-in.
import {
    CheckCircle,
    XCircle,
    AlertTriangle,
    SquarePlay,
    ChevronDown,
    ChevronRight,
} from "lucide-react";
import { adminActivityRu } from "@/lib/i18n/adminActivityRu";

const logger = createFrontendLogger("Settings.YouTubeMusicSection");

// ── Admin Section: enable/disable toggle (system-wide) ─────────────

interface YouTubeMusicAdminSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

/**
 * Renders the YouTubeMusicAdminSection component.
 */
export function YouTubeMusicAdminSection({
    settings,
    onUpdate,
}: YouTubeMusicAdminSectionProps) {
    const [oauthExpanded, setOauthExpanded] = useState(
        !!(settings.ytMusicClientId || settings.ytMusicClientSecret),
    );

    return (
        <SettingsSection
            id="youtube-music-admin"
            title="YouTube Music"
            description={adminActivityRu.admin.youtubeMusic.adminDescription}
        >
            <div className="mx-4 mt-3 mb-1 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-200/80">
                    {adminActivityRu.admin.youtubeMusic.legal}
                </p>
            </div>
            <SettingsRow
                label={adminActivityRu.admin.youtubeMusic.enable}
                description={
                    adminActivityRu.admin.youtubeMusic.enableDescription
                }
            >
                <SettingsToggle
                    checked={settings.ytMusicEnabled}
                    onChange={(v) => onUpdate({ ytMusicEnabled: v })}
                />
            </SettingsRow>

            {settings.ytMusicEnabled && (
                <div className="mx-4 mb-2">
                    <button
                        onClick={() => setOauthExpanded(!oauthExpanded)}
                        className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors py-2"
                    >
                        {oauthExpanded ? (
                            <ChevronDown className="w-4 h-4" />
                        ) : (
                            <ChevronRight className="w-4 h-4" />
                        )}
                        <span>
                            {adminActivityRu.admin.youtubeMusic.accountLinking}
                        </span>
                    </button>
                    <p className="text-xs text-gray-400 ml-6 mb-2">
                        {
                            adminActivityRu.admin.youtubeMusic
                                .accountLinkingDescription
                        }
                    </p>
                    {oauthExpanded && (
                        <>
                            <SettingsRow
                                label="Client ID"
                                description={
                                    <>
                                        {
                                            adminActivityRu.admin.youtubeMusic
                                                .clientIdDescription
                                        }{" "}
                                        (
                                        <a
                                            href="https://console.cloud.google.com/apis/credentials"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-400 hover:underline"
                                        >
                                            {
                                                adminActivityRu.admin
                                                    .youtubeMusic.createHere
                                            }
                                        </a>
                                        )
                                    </>
                                }
                            >
                                <SettingsInput
                                    value={settings.ytMusicClientId || ""}
                                    onChange={(v) =>
                                        onUpdate({ ytMusicClientId: v })
                                    }
                                    placeholder={
                                        adminActivityRu.admin.youtubeMusic
                                            .clientIdPlaceholder
                                    }
                                    className="w-64"
                                />
                            </SettingsRow>

                            <SettingsRow
                                label="Client Secret"
                                description={
                                    adminActivityRu.admin.youtubeMusic
                                        .clientSecretDescription
                                }
                            >
                                <SettingsInput
                                    type="password"
                                    value={settings.ytMusicClientSecret || ""}
                                    onChange={(v) =>
                                        onUpdate({ ytMusicClientSecret: v })
                                    }
                                    placeholder={
                                        adminActivityRu.admin.youtubeMusic
                                            .clientSecretPlaceholder
                                    }
                                    className="w-64"
                                />
                            </SettingsRow>
                        </>
                    )}
                </div>
            )}
        </SettingsSection>
    );
}

// ── User Section: per-user OAuth + quality settings ────────────────

interface YouTubeMusicCardProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
}

/**
 * Renders the YouTubeMusicCard component.
 */
export function YouTubeMusicCard({
    settings,
    onUpdate,
}: YouTubeMusicCardProps) {
    const [status, setStatus] = useState<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
        oauthConfigured?: boolean;
    } | null>(null);
    const [statusLoading, setStatusLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const [copied, setCopied] = useState(false);

    const checkStatus = useCallback(async () => {
        setStatusLoading(true);
        try {
            const res = await api.getYtMusicStatus();
            setStatus(res);
        } catch {
            setStatus({
                enabled: false,
                available: false,
                authenticated: false,
                credentialsConfigured: false,
            });
        } finally {
            setStatusLoading(false);
        }
    }, []);

    // Check status on mount
    useEffect(() => {
        void checkStatus();
    }, [checkStatus]);

    const initiateAuth = useCallback(async () => {
        const r = await api.initiateYtMusicAuth();
        return {
            deviceCode: r.device_code,
            verificationUri: r.verification_url,
            userCode: r.user_code,
            pollIntervalMs: (r.interval || 5) * 1000,
            expiresAtMs: Date.now() + r.expires_in * 1000,
        };
    }, []);

    const pollAuth = useCallback(async (deviceCode: string) => {
        const r = await api.pollYtMusicAuth(deviceCode);
        if (r.status === "success") return { status: "success" } as const;
        if (r.status === "error") {
            logger.warn("YouTube Music authorization was rejected", {
                error: r.error,
            });
            return {
                status: "error",
                message: adminActivityRu.admin.youtubeMusic.authorizationFailed,
            } as const;
        }
        return { status: "pending" } as const;
    }, []);

    const handleSessionStarted = useCallback(
        async (session: { userCode?: string; verificationUri: string }) => {
            try {
                await navigator.clipboard.writeText(session.userCode || "");
                setCopied(true);
                setTimeout(() => setCopied(false), 3000);
            } catch {
                // Clipboard is optional.
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
        setSuccess(adminActivityRu.admin.youtubeMusic.connectedSuccess);
        setError(null);
        void checkStatus();
        window.dispatchEvent(new Event("ytmusic-auth-changed"));
    }, [checkStatus]);

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
        expiredMessage: adminActivityRu.admin.youtubeMusic.codeExpired,
        startErrorMessage: adminActivityRu.admin.youtubeMusic.authStartFailed,
    });
    const userCode = authSession?.userCode || "";
    const verificationUrl = authSession?.verificationUri || "";
    const polling = authState === "polling";

    const handleLinkAccount = useCallback(async () => {
        setError(null);
        setSuccess(null);
        await startAuthentication();
    }, [startAuthentication]);

    const handleCancelLink = useCallback(() => {
        cancelAuthentication();
        setError(null);
    }, [cancelAuthentication]);

    const handleClearAuth = async () => {
        try {
            await api.clearYtMusicAuth();
            setStatus((prev) =>
                prev ? { ...prev, authenticated: false } : prev,
            );
            setSuccess(null);
            setError(null);
            window.dispatchEvent(new Event("ytmusic-auth-changed"));
        } catch (err) {
            logger.error("Failed to clear YouTube Music auth", { error: err });
        }
    };

    const handleCopyCode = async () => {
        if (!userCode) return;
        try {
            await navigator.clipboard.writeText(userCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Fallback for non-secure contexts
            const textarea = document.createElement("textarea");
            textarea.value = userCode;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const qualityOptions = [
        { value: "LOW", label: adminActivityRu.admin.youtubeMusic.quality.low },
        {
            value: "MEDIUM",
            label: adminActivityRu.admin.youtubeMusic.quality.medium,
        },
        {
            value: "HIGH",
            label: adminActivityRu.admin.youtubeMusic.quality.high,
        },
        {
            value: "LOSSLESS",
            label: adminActivityRu.admin.youtubeMusic.quality.lossless,
        },
    ];

    // Derived card state
    const isConnected = !!status?.authenticated;
    const isActive = !!status?.enabled && !!status?.available;
    const canLinkAccount = !!(
        status?.oauthConfigured ?? status?.credentialsConfigured
    );
    const isDisabled = !!status && (!status.enabled || !status.available);
    const disabledReason =
        status && !status.enabled
            ? adminActivityRu.admin.youtubeMusic.disabled
            : status && !status.available
              ? adminActivityRu.admin.youtubeMusic.unavailable
              : undefined;
    // Always expanded so the Explore toggle remains accessible after disconnect
    const isExpanded = true;

    const statusText = statusLoading
        ? adminActivityRu.admin.youtubeMusic.checking
        : isConnected
          ? adminActivityRu.admin.youtubeMusic.connected
          : isActive
            ? adminActivityRu.admin.youtubeMusic.active
            : adminActivityRu.admin.youtubeMusic.notConnected;

    const statusColor: "green" | "red" | "gray" = statusLoading
        ? "gray"
        : isDisabled
          ? "red"
          : isConnected || isActive
            ? "green"
            : "red";

    const warningBanner = (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200/80">
                {adminActivityRu.admin.youtubeMusic.userLegal}
            </p>
        </div>
    );

    return (
        <IntegrationCard
            icon={<SquarePlay className="w-5 h-5 text-red-500" />}
            title="YouTube Music"
            statusText={statusText}
            statusColor={statusColor}
            connected={isConnected}
            onConnect={canLinkAccount ? handleLinkAccount : undefined}
            onDisconnect={handleClearAuth}
            isLoading={statusLoading || authState === "loading"}
            expanded={isExpanded}
            disabled={isDisabled}
            disabledReason={disabledReason}
            warning={warningBanner}
        >
            {/* Account linking hint when OAuth is available but not linked */}
            {!isConnected &&
                canLinkAccount &&
                status?.available &&
                !polling &&
                !authError &&
                !error &&
                !success && (
                    <p className="text-sm text-gray-400">
                        {adminActivityRu.admin.youtubeMusic.linkHint}
                    </p>
                )}

            {/* Device Code Auth Flow (not authenticated) */}
            {!isConnected && status?.available && canLinkAccount && (
                <div className="space-y-3">
                    {/* In linking flow — show device code + verification URL */}
                    {userCode && verificationUrl && polling && (
                        <DeviceAuthLinkPanel
                            userCode={userCode}
                            verificationUrl={verificationUrl}
                            timeLeftSeconds={timeLeft}
                            copied={copied}
                            onCopyCode={handleCopyCode}
                            onCancel={handleCancelLink}
                            introText={
                                adminActivityRu.admin.youtubeMusic.signInOpened
                            }
                            pasteInstruction={
                                adminActivityRu.admin.youtubeMusic.pasteCode
                            }
                            signInInstruction={
                                <>
                                    {
                                        adminActivityRu.admin.youtubeMusic
                                            .signInInstruction
                                    }{" "}
                                    <strong className="text-white">
                                        {
                                            adminActivityRu.admin.youtubeMusic
                                                .allow
                                        }
                                    </strong>
                                </>
                            }
                            openLinkLabel={
                                adminActivityRu.admin.youtubeMusic.openSignIn
                            }
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
            {isConnected && success && (
                <div className="flex items-center gap-2 text-sm text-green-400 mb-2">
                    <CheckCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{success}</span>
                </div>
            )}

            {/* Explore Page Toggle */}
            <SettingsRow
                label={adminActivityRu.admin.youtubeMusic.showExplore}
                description={
                    adminActivityRu.admin.youtubeMusic.showExploreDescription
                }
            >
                <SettingsToggle
                    checked={settings.showYtMusicExplore}
                    onChange={(v) => onUpdate({ showYtMusicExplore: v })}
                />
            </SettingsRow>

            {/* Quality Selection */}
            {isConnected && (
                <SettingsRow
                    label={adminActivityRu.admin.youtubeMusic.streamingQuality}
                    description={
                        adminActivityRu.admin.youtubeMusic
                            .streamingQualityDescription
                    }
                >
                    <SettingsSelect
                        value={settings.ytMusicQuality}
                        onChange={(v) =>
                            onUpdate({
                                ytMusicQuality:
                                    v as UserSettings["ytMusicQuality"],
                            })
                        }
                        options={qualityOptions}
                    />
                </SettingsRow>
            )}
        </IntegrationCard>
    );
}
