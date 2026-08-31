"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useVisibilityGatedInterval } from "@/hooks/useVisibilityGatedInterval";
import { api } from "@/lib/api";
import { BRAND_DEEP_LINK_SCHEME } from "@/lib/brand";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { QRCodeSVG } from "qrcode.react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import {
    Smartphone,
    RefreshCw,
    Check,
    Clock,
    Copy,
    Trash2,
    AlertCircle,
} from "lucide-react";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { deviceRu } from "@/lib/i18n/listenDeviceRu";
import { userFacingError } from "@/lib/i18n/ru";

interface DeviceLinkCode {
    code: string;
    expiresAt: string;
    expiresIn: number;
}

interface LinkedDevice {
    id: string;
    name: string;
    lastUsed: string;
    createdAt: string;
}

/**
 * Renders the DeviceLinkPage component.
 */
export default function DeviceLinkPage() {
    const router = useRouter();
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const [linkCode, setLinkCode] = useState<DeviceLinkCode | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [timeRemaining, setTimeRemaining] = useState(0);
    const [codeUsed, setCodeUsed] = useState(false);
    const [devices, setDevices] = useState<LinkedDevice[]>([]);
    const [isLoadingDevices, setIsLoadingDevices] = useState(true);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deviceError, setDeviceError] = useState<string | null>(null);

    // Redirect if not authenticated
    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, authLoading, router]);

    // Load linked devices
    const loadDevices = useCallback(async () => {
        try {
            const response = await api.request<LinkedDevice[]>(
                "/device-link/devices",
            );
            setDevices(response);
        } catch (err) {
            sharedFrontendLogger.error("Failed to load devices:", err);
            setDeviceError(userFacingError(err, deviceRu.loadFailed));
        } finally {
            setIsLoadingDevices(false);
        }
    }, []);

    useEffect(() => {
        if (!isAuthenticated) {
            return;
        }

        const loadTimer = window.setTimeout(() => {
            void loadDevices();
        }, 0);

        return () => window.clearTimeout(loadTimer);
    }, [isAuthenticated, loadDevices]);

    // Generate a new link code
    const generateCode = async () => {
        setIsGenerating(true);
        setError(null);
        setCodeUsed(false);

        try {
            const response = await api.request<DeviceLinkCode>(
                "/device-link/generate",
                {
                    method: "POST",
                },
            );
            setLinkCode(response);
            setTimeRemaining(response.expiresIn);
        } catch (err) {
            setError(userFacingError(err, deviceRu.generateFailed));
        } finally {
            setIsGenerating(false);
        }
    };

    // Countdown timer
    useEffect(() => {
        if (timeRemaining <= 0 || codeUsed) return;

        const timer = setInterval(() => {
            setTimeRemaining((prev) => {
                if (prev <= 1) {
                    clearInterval(timer);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);

        return () => clearInterval(timer);
    }, [timeRemaining, codeUsed]);

    // Poll for code usage
    const checkCodeStatus = useCallback(async () => {
        if (!linkCode) return;

        try {
            const status = await api.request<{
                status: string;
                deviceName?: string;
            }>(`/device-link/status/${linkCode.code}`);

            if (status.status === "used") {
                setCodeUsed(true);
                loadDevices(); // Refresh devices list
            }
        } catch (err) {
            sharedFrontendLogger.error("Failed to check code status:", err);
        }
    }, [linkCode, loadDevices]);

    useVisibilityGatedInterval(checkCodeStatus, 2000, {
        enabled: Boolean(linkCode) && timeRemaining > 0 && !codeUsed,
    });

    // Copy code to clipboard
    const copyCode = () => {
        if (linkCode) {
            navigator.clipboard.writeText(linkCode.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    // Revoke a device
    const revokeDevice = async (deviceId: string) => {
        setDeviceError(null);
        try {
            await api.request(`/device-link/devices/${deviceId}`, {
                method: "DELETE",
            });
            setDevices((prev) => prev.filter((d) => d.id !== deviceId));
        } catch (err) {
            sharedFrontendLogger.error("Failed to revoke device:", err);
            setDeviceError(userFacingError(err, deviceRu.revokeFailed));
        }
    };

    // Build QR code URL (contains code and server URL)
    const getQRValue = () => {
        if (!linkCode) return "";
        const serverUrl =
            typeof window !== "undefined" ? window.location.origin : "";
        return `${BRAND_DEEP_LINK_SCHEME}://link?code=${linkCode.code}&server=${encodeURIComponent(serverUrl)}`;
    };

    if (authLoading) {
        return <LoadingScreen message="Проверяем устройства…" />;
    }

    return (
        <div data-consumer-surface="device" className="min-h-screen bg-surface">
            <div className="relative mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
                <PageHeader
                    title={deviceRu.title}
                    subtitle={`${deviceRu.subtitle} ${deviceRu.pwaDirection}`}
                    icon={Smartphone}
                />

                <div className="grid gap-10 md:grid-cols-2">
                    {/* QR Code Section */}
                    <section className="border-y border-line py-6">
                        <h2 className="mb-4 flex items-center gap-2 text-2xl font-black tracking-[-0.03em] text-content">
                            <Smartphone className="w-5 h-5" />
                            {deviceRu.linkCodeTitle}
                        </h2>

                        {error && (
                            <div
                                role="alert"
                                className="mb-4 flex items-center gap-2 rounded-xl border border-error/25 bg-error/10 p-3 text-sm text-error"
                            >
                                <AlertCircle className="w-4 h-4" />
                                {error}
                            </div>
                        )}

                        {!linkCode && !isGenerating && (
                            <div className="py-8 text-center">
                                <p className="mb-4 text-content-muted">
                                    {deviceRu.generateHint}
                                </p>
                                <button
                                    onClick={generateCode}
                                    className="min-h-11 rounded-xl bg-brand px-6 py-3 font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                >
                                    {deviceRu.generateCode}
                                </button>
                            </div>
                        )}

                        {isGenerating && (
                            <div className="flex items-center justify-center py-16">
                                <GradientSpinner size="md" />
                            </div>
                        )}

                        {linkCode && !isGenerating && (
                            <div className="text-center">
                                {codeUsed ? (
                                    <div className="py-8">
                                        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-success/15">
                                            <Check className="h-8 w-8 text-success" />
                                        </div>
                                        <h3 className="mb-2 text-xl font-bold text-content">
                                            {deviceRu.linkedTitle}
                                        </h3>
                                        <p className="mb-4 text-content-muted">
                                            {deviceRu.linkedDescription}
                                        </p>
                                        <button
                                            onClick={generateCode}
                                            className="min-h-11 rounded-xl border border-line bg-surface-elevated px-4 py-2 text-sm font-semibold text-content transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                        >
                                            {deviceRu.linkAnother}
                                        </button>
                                    </div>
                                ) : timeRemaining <= 0 ? (
                                    <div className="py-8">
                                        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-error/15">
                                            <Clock className="h-8 w-8 text-error" />
                                        </div>
                                        <h3 className="mb-2 text-xl font-bold text-content">
                                            {deviceRu.expiredTitle}
                                        </h3>
                                        <p className="mb-4 text-content-muted">
                                            {deviceRu.expiredDescription}
                                        </p>
                                        <button
                                            onClick={generateCode}
                                            className="min-h-11 rounded-xl bg-brand px-4 py-2 font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                        >
                                            <RefreshCw className="w-4 h-4 inline mr-2" />
                                            {deviceRu.generateNewCode}
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <div className="mb-4">
                                            <p className="mb-2 text-sm text-content-muted">
                                                {deviceRu.uriScheme}
                                            </p>
                                            <div className="inline-flex gap-1 rounded-xl border border-line bg-surface-elevated p-1">
                                                <span className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-surface">
                                                    {BRAND_DEEP_LINK_SCHEME}://
                                                </span>
                                            </div>
                                        </div>

                                        {/* QR Code */}
                                        <div className="bg-white p-4 rounded-xl inline-block mb-4">
                                            <QRCodeSVG
                                                value={getQRValue()}
                                                size={180}
                                                level="M"
                                                includeMargin={false}
                                            />
                                        </div>

                                        {/* Code Display */}
                                        <div className="mb-4">
                                            <p className="mb-2 text-sm text-content-muted">
                                                {deviceRu.manualCode}
                                            </p>
                                            <div className="flex items-center justify-center gap-2">
                                                <code className="rounded-xl bg-surface-elevated px-4 py-2 font-mono text-3xl font-bold tracking-widest text-content">
                                                    {linkCode.code}
                                                </code>
                                                <button
                                                    onClick={copyCode}
                                                    className={cn(
                                                        "flex h-11 w-11 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                                        copied
                                                            ? "bg-success/15 text-success"
                                                            : "bg-surface-elevated text-content-muted hover:bg-surface-hover hover:text-content",
                                                    )}
                                                    title={deviceRu.copyCode}
                                                    aria-label={
                                                        deviceRu.copyCode
                                                    }
                                                >
                                                    {copied ? (
                                                        <Check className="w-5 h-5" />
                                                    ) : (
                                                        <Copy className="w-5 h-5" />
                                                    )}
                                                </button>
                                            </div>
                                        </div>

                                        {/* Timer */}
                                        <div className="flex items-center justify-center gap-2 text-content-muted">
                                            <Clock className="w-4 h-4" />
                                            <span>
                                                {deviceRu.expiresIn}{" "}
                                                {formatTime(timeRemaining)}
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </section>

                    {/* Linked Devices Section */}
                    <section className="border-y border-line py-6">
                        <h2 className="mb-4 text-2xl font-black tracking-[-0.03em] text-content">
                            {deviceRu.linkedDevices}
                        </h2>

                        {deviceError && (
                            <div
                                role="alert"
                                className="mb-4 flex items-center gap-2 rounded-xl border border-error/25 bg-error/10 p-3 text-sm text-error"
                            >
                                <AlertCircle className="w-4 h-4" />
                                {deviceError}
                            </div>
                        )}

                        {isLoadingDevices ? (
                            <div className="flex items-center justify-center py-8">
                                <GradientSpinner size="sm" />
                            </div>
                        ) : devices.length === 0 ? (
                            <EmptyState
                                icon={<Smartphone />}
                                title={deviceRu.noDevices}
                                description={deviceRu.generateHint}
                            />
                        ) : (
                            <div className="divide-y divide-line border-y border-line">
                                {devices.map((device) => (
                                    <div
                                        key={device.id}
                                        className="flex items-center justify-between gap-3 px-1 py-3 transition-colors hover:bg-surface-elevated/60 motion-reduce:transition-none"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand/15">
                                                <Smartphone className="h-5 w-5 text-brand-light" />
                                            </div>
                                            <div>
                                                <p className="font-medium text-content">
                                                    {device.name}
                                                </p>
                                                <p className="text-sm text-content-muted">
                                                    {deviceRu.lastUsed}{" "}
                                                    {new Date(
                                                        device.lastUsed,
                                                    ).toLocaleDateString(
                                                        "ru-RU",
                                                    )}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() =>
                                                revokeDevice(device.id)
                                            }
                                            className="flex h-11 w-11 items-center justify-center rounded-xl text-content-muted transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error motion-reduce:transition-none"
                                            title={deviceRu.revokeDevice}
                                            aria-label={deviceRu.revokeDevice}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                </div>

                {/* Instructions */}
                <section className="mt-10 border-t border-line pt-7">
                    <h2 className="mb-4 text-2xl font-black tracking-[-0.03em] text-content">
                        {deviceRu.instructionsTitle}
                    </h2>
                    <ol className="max-w-3xl space-y-3 text-content-muted">
                        <li className="flex gap-3">
                            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand/20 text-sm font-bold text-brand-light">
                                1
                            </span>
                            <span>{deviceRu.instructionOpen}</span>
                        </li>
                        <li className="flex gap-3">
                            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand/20 text-sm font-bold text-brand-light">
                                2
                            </span>
                            <span>{deviceRu.instructionChoose}</span>
                        </li>
                        <li className="flex gap-3">
                            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand/20 text-sm font-bold text-brand-light">
                                3
                            </span>
                            <span>{deviceRu.instructionScan}</span>
                        </li>
                        <li className="flex gap-3">
                            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand/20 text-sm font-bold text-brand-light">
                                4
                            </span>
                            <span>{deviceRu.instructionVerify}</span>
                        </li>
                    </ol>
                </section>
            </div>
        </div>
    );
}
