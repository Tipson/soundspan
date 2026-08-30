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
import { Card } from "@/components/ui/Card";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
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
        if (isAuthenticated) {
            loadDevices();
        }
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
        return (
            <div className="min-h-screen flex items-center justify-center">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <div className="min-h-screen relative pb-24">
            {/* Header gradient */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-gradient-to-b from-ai/10 via-transparent to-transparent"
                    style={{ height: "50vh" }}
                />
            </div>

            <div className="relative max-w-4xl mx-auto px-6 md:px-8 py-8">
                {/* Title */}
                <div className="mb-8">
                    <h1 className="text-3xl md:text-4xl font-black text-white mb-2">
                        {deviceRu.title}
                    </h1>
                    <p className="text-gray-400">{deviceRu.subtitle}</p>
                    <p className="text-gray-400 text-sm mt-2">
                        {deviceRu.pwaDirection}
                    </p>
                </div>

                <div className="grid md:grid-cols-2 gap-8">
                    {/* QR Code Section */}
                    <Card className="p-6 bg-white/[0.03] border border-white/5">
                        <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                            <Smartphone className="w-5 h-5" />
                            {deviceRu.linkCodeTitle}
                        </h2>

                        {error && (
                            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm flex items-center gap-2">
                                <AlertCircle className="w-4 h-4" />
                                {error}
                            </div>
                        )}

                        {!linkCode && !isGenerating && (
                            <div className="text-center py-8">
                                <p className="text-gray-400 mb-4">
                                    {deviceRu.generateHint}
                                </p>
                                <button
                                    onClick={generateCode}
                                    className="px-6 py-3 bg-brand-hover hover:bg-brand text-black font-medium rounded-full transition-all hover:scale-105"
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
                                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
                                            <Check className="w-8 h-8 text-green-400" />
                                        </div>
                                        <h3 className="text-xl font-bold text-white mb-2">
                                            {deviceRu.linkedTitle}
                                        </h3>
                                        <p className="text-gray-400 mb-4">
                                            {deviceRu.linkedDescription}
                                        </p>
                                        <button
                                            onClick={generateCode}
                                            className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-full transition-all text-sm"
                                        >
                                            {deviceRu.linkAnother}
                                        </button>
                                    </div>
                                ) : timeRemaining <= 0 ? (
                                    <div className="py-8">
                                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
                                            <Clock className="w-8 h-8 text-red-400" />
                                        </div>
                                        <h3 className="text-xl font-bold text-white mb-2">
                                            {deviceRu.expiredTitle}
                                        </h3>
                                        <p className="text-gray-400 mb-4">
                                            {deviceRu.expiredDescription}
                                        </p>
                                        <button
                                            onClick={generateCode}
                                            className="px-4 py-2 bg-brand-hover hover:bg-brand text-black font-medium rounded-full transition-all"
                                        >
                                            <RefreshCw className="w-4 h-4 inline mr-2" />
                                            {deviceRu.generateNewCode}
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <div className="mb-4">
                                            <p className="text-gray-400 text-sm mb-2">
                                                {deviceRu.uriScheme}
                                            </p>
                                            <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-1 gap-1">
                                                <span className="px-3 py-1.5 rounded-md text-xs font-medium bg-brand text-black">
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
                                            <p className="text-gray-400 text-sm mb-2">
                                                {deviceRu.manualCode}
                                            </p>
                                            <div className="flex items-center justify-center gap-2">
                                                <code className="text-3xl font-mono font-bold text-white tracking-widest bg-white/10 px-4 py-2 rounded-lg">
                                                    {linkCode.code}
                                                </code>
                                                <button
                                                    onClick={copyCode}
                                                    className={cn(
                                                        "p-2 rounded-lg transition-all",
                                                        copied
                                                            ? "bg-green-500/20 text-green-400"
                                                            : "bg-white/10 hover:bg-white/20 text-gray-400",
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
                                        <div className="flex items-center justify-center gap-2 text-gray-400">
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
                    </Card>

                    {/* Linked Devices Section */}
                    <Card className="p-6 bg-white/[0.03] border border-white/5">
                        <h2 className="text-xl font-bold text-white mb-4">
                            {deviceRu.linkedDevices}
                        </h2>

                        {deviceError && (
                            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm flex items-center gap-2">
                                <AlertCircle className="w-4 h-4" />
                                {deviceError}
                            </div>
                        )}

                        {isLoadingDevices ? (
                            <div className="flex items-center justify-center py-8">
                                <GradientSpinner size="sm" />
                            </div>
                        ) : devices.length === 0 ? (
                            <div className="text-center py-8 text-gray-400">
                                <Smartphone className="w-12 h-12 mx-auto mb-4 opacity-50" />
                                <p>{deviceRu.noDevices}</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {devices.map((device) => (
                                    <div
                                        key={device.id}
                                        className="flex items-center justify-between p-3 bg-white/5 rounded-lg"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-full bg-ai/20 flex items-center justify-center">
                                                <Smartphone className="w-5 h-5 text-ai-hover" />
                                            </div>
                                            <div>
                                                <p className="text-white font-medium">
                                                    {device.name}
                                                </p>
                                                <p className="text-gray-400 text-sm">
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
                                            className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                                            title={deviceRu.revokeDevice}
                                            aria-label={deviceRu.revokeDevice}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Card>
                </div>

                {/* Instructions */}
                <Card className="mt-8 p-6 bg-white/[0.03] border border-white/5">
                    <h2 className="text-xl font-bold text-white mb-4">
                        {deviceRu.instructionsTitle}
                    </h2>
                    <ol className="space-y-3 text-gray-400">
                        <li className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand/20 text-brand text-sm font-bold flex items-center justify-center">
                                1
                            </span>
                            <span>{deviceRu.instructionOpen}</span>
                        </li>
                        <li className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand/20 text-brand text-sm font-bold flex items-center justify-center">
                                2
                            </span>
                            <span>{deviceRu.instructionChoose}</span>
                        </li>
                        <li className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand/20 text-brand text-sm font-bold flex items-center justify-center">
                                3
                            </span>
                            <span>{deviceRu.instructionScan}</span>
                        </li>
                        <li className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand/20 text-brand text-sm font-bold flex items-center justify-center">
                                4
                            </span>
                            <span>{deviceRu.instructionVerify}</span>
                        </li>
                    </ol>
                </Card>
            </div>
        </div>
    );
}
