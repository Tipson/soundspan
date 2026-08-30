"use client";

import { useState, useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { useTwoFactor } from "../../hooks/useTwoFactor";
import { Modal } from "@/components/ui/Modal";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import Image from "next/image";
import { UserSettings } from "../../types";
import { ru, userFacingError } from "@/lib/i18n/ru";

interface AccountSectionProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
}

const displayNamePattern = /^[A-Za-z0-9 .-]+$/;

/**
 * Renders the AccountSection component.
 */
export function AccountSection({ settings, onUpdate }: AccountSectionProps) {
    const { user } = useAuth();

    // Email change state
    const [email, setEmail] = useState(user?.email || "");
    const [emailStatus, setEmailStatus] = useState<StatusType>("idle");
    const [emailMessage, setEmailMessage] = useState("");
    const [savingEmail, setSavingEmail] = useState(false);

    // Password change state
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [changingPassword, setChangingPassword] = useState(false);
    const [showPasswordForm, setShowPasswordForm] = useState(false);
    const [passwordStatus, setPasswordStatus] = useState<StatusType>("idle");
    const [passwordMessage, setPasswordMessage] = useState("");

    // 2FA state
    const {
        twoFactorEnabled,
        settingUpTwoFactor,
        twoFactorQR,
        twoFactorSecret,
        recoveryCodes,
        showRecoveryCodes,
        load2FAStatus,
        setup2FA,
        enable2FA,
        disable2FA,
        cancel2FASetup,
        closeRecoveryCodes,
    } = useTwoFactor();

    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [disablePassword, setDisablePassword] = useState("");
    const [disableToken, setDisableToken] = useState("");
    const [showDisableFlow, setShowDisableFlow] = useState(false);
    const [tfaStatus, setTfaStatus] = useState<StatusType>("idle");
    const [tfaMessage, setTfaMessage] = useState("");

    const displayName = settings.displayName || "";
    const trimmedDisplayName = displayName.trim();
    const isDisplayNameValid =
        trimmedDisplayName.length === 0 ||
        displayNamePattern.test(trimmedDisplayName);

    // Load 2FA status on mount
    useEffect(() => {
        load2FAStatus();
    }, [load2FAStatus]);

    // Handle email change
    const handleChangeEmail = async () => {
        const trimmed = email.trim();
        if (!trimmed) {
            setEmailStatus("error");
            setEmailMessage("Укажите почту");
            return;
        }
        setSavingEmail(true);
        setEmailStatus("loading");
        try {
            await api.post("/auth/change-email", { email: trimmed });
            setEmailStatus("success");
            setEmailMessage("Обновлено");
        } catch (error: unknown) {
            setEmailStatus("error");
            setEmailMessage(userFacingError(error, "Не удалось сохранить"));
        } finally {
            setSavingEmail(false);
        }
    };

    // Handle password change
    const handleChangePassword = async () => {
        if (!currentPassword || !newPassword || !confirmPassword) {
            setPasswordStatus("error");
            setPasswordMessage("Заполните все поля");
            return;
        }
        if (newPassword.length < 6) {
            setPasswordStatus("error");
            setPasswordMessage("Не менее 6 символов");
            return;
        }
        if (newPassword !== confirmPassword) {
            setPasswordStatus("error");
            setPasswordMessage("Пароли не совпадают");
            return;
        }

        setChangingPassword(true);
        setPasswordStatus("loading");
        try {
            await api.post("/auth/change-password", {
                currentPassword,
                newPassword,
            });
            setPasswordStatus("success");
            setPasswordMessage("Пароль изменён");
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setTimeout(() => setShowPasswordForm(false), 1500);
        } catch (error: unknown) {
            setPasswordStatus("error");
            setPasswordMessage(
                userFacingError(error, "Не удалось изменить пароль"),
            );
        } finally {
            setChangingPassword(false);
        }
    };

    // Handle 2FA verification
    const handleVerify2FA = async () => {
        setTfaStatus("loading");
        try {
            await enable2FA(twoFactorToken);
            setTfaStatus("success");
            setTfaMessage("Включено");
            setTwoFactorToken("");
        } catch (error: unknown) {
            setTfaStatus("error");
            setTfaMessage(userFacingError(error, "Неверный код"));
        }
    };

    const handleSetup2FA = async () => {
        setTfaStatus("loading");
        setTfaMessage("");
        try {
            await setup2FA();
            setTfaStatus("idle");
        } catch (error: unknown) {
            setTfaStatus("error");
            setTfaMessage(userFacingError(error, "Не удалось включить"));
        }
    };

    // Handle 2FA disable
    const handleDisable2FA = async () => {
        setTfaStatus("loading");
        try {
            await disable2FA(disablePassword, disableToken);
            setTfaStatus("success");
            setTfaMessage("Выключено");
            setDisablePassword("");
            setDisableToken("");
            setShowDisableFlow(false);
        } catch (error: unknown) {
            setTfaStatus("error");
            setTfaMessage(userFacingError(error, "Не удалось выключить"));
        }
    };

    return (
        <>
            <SettingsSection id="account" title={ru.settings.account}>
                {/* Display Name */}
                <SettingsRow
                    label="Отображаемое имя"
                    description="Необязательное имя для интерфейса. Не более 80 символов."
                    htmlFor="display-name"
                >
                    <div className="w-64">
                        <SettingsInput
                            id="display-name"
                            name="displayName"
                            autoComplete="name"
                            type="text"
                            value={displayName}
                            onChange={(value) =>
                                onUpdate({ displayName: value })
                            }
                            placeholder="Например, Анна"
                        />
                        {!isDisplayNameValid && (
                            <p className="mt-1 text-xs text-red-400">
                                Используйте только латинские буквы, цифры,
                                пробелы, точки и дефисы.
                            </p>
                        )}
                    </div>
                </SettingsRow>

                {/* Username Display */}
                <SettingsRow
                    label="Имя пользователя"
                    description={`Вы вошли как ${user?.username}`}
                >
                    <span className="text-sm text-gray-400">{user?.role}</span>
                </SettingsRow>

                {/* Email */}
                <SettingsRow
                    label="Электронная почта"
                    description="Используется для входа и восстановления аккаунта"
                    htmlFor="email"
                >
                    <div className="flex items-center gap-3">
                        <div className="w-64">
                            <SettingsInput
                                id="email"
                                name="email"
                                autoComplete="email"
                                type="email"
                                value={email}
                                onChange={setEmail}
                                placeholder="you@example.com"
                            />
                        </div>
                        <button
                            onClick={handleChangeEmail}
                            disabled={
                                savingEmail ||
                                email.trim() === (user?.email || "")
                            }
                            className="px-4 py-2 bg-white text-black text-sm font-medium rounded-full
                                hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                        >
                            {savingEmail ? ru.settings.saving : ru.common.save}
                        </button>
                        <InlineStatus
                            status={emailStatus}
                            message={emailMessage}
                            onClear={() => setEmailStatus("idle")}
                        />
                    </div>
                </SettingsRow>

                {/* Change Password */}
                <SettingsRow
                    label="Пароль"
                    description="Измените пароль аккаунта"
                >
                    {!showPasswordForm ? (
                        <button
                            onClick={() => setShowPasswordForm(true)}
                            className="text-sm text-white hover:underline"
                        >
                            Изменить
                        </button>
                    ) : (
                        <button
                            onClick={() => setShowPasswordForm(false)}
                            className="text-sm text-gray-400 hover:text-white"
                        >
                            {ru.common.cancel}
                        </button>
                    )}
                </SettingsRow>

                {showPasswordForm && (
                    <div className="py-4 space-y-3 border-t border-b border-white/5">
                        <SettingsInput
                            id="current-password"
                            name="currentPassword"
                            autoComplete="current-password"
                            type="password"
                            value={currentPassword}
                            onChange={setCurrentPassword}
                            placeholder="Текущий пароль"
                        />
                        <SettingsInput
                            id="new-password"
                            name="newPassword"
                            autoComplete="new-password"
                            type="password"
                            value={newPassword}
                            onChange={setNewPassword}
                            placeholder="Новый пароль (не менее 6 символов)"
                        />
                        <SettingsInput
                            id="confirm-password"
                            name="confirmPassword"
                            autoComplete="new-password"
                            type="password"
                            value={confirmPassword}
                            onChange={setConfirmPassword}
                            placeholder="Повторите новый пароль"
                        />
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleChangePassword}
                                disabled={
                                    changingPassword ||
                                    !currentPassword ||
                                    !newPassword ||
                                    newPassword !== confirmPassword
                                }
                                className="px-4 py-2 bg-white text-black text-sm font-medium rounded-full
                                    hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                {changingPassword
                                    ? "Изменяем…"
                                    : "Изменить пароль"}
                            </button>
                            <InlineStatus
                                status={passwordStatus}
                                message={passwordMessage}
                                onClear={() => setPasswordStatus("idle")}
                            />
                        </div>
                    </div>
                )}

                {/* Two-Factor Authentication */}
                <SettingsRow
                    label="Двухфакторная аутентификация"
                    description={
                        twoFactorEnabled
                            ? "Включена"
                            : "Дополнительная защита аккаунта"
                    }
                >
                    {!settingUpTwoFactor &&
                        !showDisableFlow &&
                        (twoFactorEnabled ? (
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setShowDisableFlow(true)}
                                    className="text-sm text-red-400 hover:text-red-300"
                                >
                                    Выключить
                                </button>
                                <InlineStatus
                                    status={tfaStatus}
                                    message={tfaMessage}
                                    onClear={() => setTfaStatus("idle")}
                                />
                            </div>
                        ) : (
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={handleSetup2FA}
                                    disabled={tfaStatus === "loading"}
                                    className="text-sm text-white hover:underline disabled:opacity-50"
                                >
                                    {tfaStatus === "loading"
                                        ? "Запускаем…"
                                        : "Включить"}
                                </button>
                                <InlineStatus
                                    status={tfaStatus}
                                    message={tfaMessage}
                                    onClear={() => setTfaStatus("idle")}
                                />
                            </div>
                        ))}
                </SettingsRow>

                {/* 2FA Setup Flow */}
                {settingUpTwoFactor && (
                    <div className="py-4 space-y-4 border-t border-b border-white/5">
                        <p className="text-sm text-gray-400">
                            Отсканируйте QR-код в приложении-аутентификаторе и
                            введите полученный код ниже.
                        </p>

                        {twoFactorQR && (
                            <div className="flex justify-center">
                                <div className="bg-white p-3 rounded-lg">
                                    <Image
                                        src={twoFactorQR}
                                        alt="QR-код для двухфакторной аутентификации"
                                        width={160}
                                        height={160}
                                        sizes="160px"
                                        className="w-40 h-40"
                                        unoptimized
                                    />
                                </div>
                            </div>
                        )}

                        {twoFactorSecret && (
                            <div className="text-center">
                                <p className="text-xs text-gray-400 mb-1">
                                    Код для ручного ввода:
                                </p>
                                <code className="text-sm text-white bg-surface-highlight px-3 py-1 rounded font-mono">
                                    {twoFactorSecret}
                                </code>
                            </div>
                        )}

                        <SettingsInput
                            id="two-factor-token"
                            name="twoFactorToken"
                            autoComplete="one-time-code"
                            type="text"
                            value={twoFactorToken}
                            onChange={(v) =>
                                setTwoFactorToken(
                                    v.replace(/\D/g, "").slice(0, 6),
                                )
                            }
                            placeholder="Введите 6-значный код"
                        />

                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleVerify2FA}
                                disabled={twoFactorToken.length !== 6}
                                className="px-4 py-2 bg-white text-black text-sm font-medium rounded-full
                                    hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                Проверить
                            </button>
                            <button
                                onClick={() => {
                                    cancel2FASetup();
                                    setTwoFactorToken("");
                                }}
                                className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                            >
                                {ru.common.cancel}
                            </button>
                            <InlineStatus
                                status={tfaStatus}
                                message={tfaMessage}
                                onClear={() => setTfaStatus("idle")}
                            />
                        </div>
                    </div>
                )}

                {/* 2FA Disable Flow */}
                {showDisableFlow && (
                    <div className="py-4 space-y-3 border-t border-b border-white/5">
                        <p className="text-sm text-yellow-500">
                            Введите пароль и текущий код, чтобы выключить
                            двухфакторную аутентификацию.
                        </p>
                        <SettingsInput
                            id="disable-two-factor-password"
                            name="disableTwoFactorPassword"
                            autoComplete="current-password"
                            type="password"
                            value={disablePassword}
                            onChange={setDisablePassword}
                            placeholder="Пароль"
                        />
                        <SettingsInput
                            id="disable-two-factor-token"
                            name="disableTwoFactorToken"
                            autoComplete="one-time-code"
                            type="text"
                            value={disableToken}
                            onChange={(v) =>
                                setDisableToken(
                                    v.replace(/\D/g, "").slice(0, 6),
                                )
                            }
                            placeholder="6-значный код"
                        />
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleDisable2FA}
                                disabled={
                                    !disablePassword ||
                                    disableToken.length !== 6
                                }
                                className="px-4 py-2 bg-red-500 text-white text-sm font-medium rounded-full
                                    hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                Выключить 2FA
                            </button>
                            <button
                                onClick={() => {
                                    setShowDisableFlow(false);
                                    setDisablePassword("");
                                    setDisableToken("");
                                }}
                                className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                            >
                                {ru.common.cancel}
                            </button>
                            <InlineStatus
                                status={tfaStatus}
                                message={tfaMessage}
                                onClear={() => setTfaStatus("idle")}
                            />
                        </div>
                    </div>
                )}
            </SettingsSection>

            {/* Recovery Codes Modal */}
            <Modal
                isOpen={showRecoveryCodes}
                onClose={closeRecoveryCodes}
                title="Коды восстановления"
            >
                <div className="space-y-4">
                    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                        <p className="text-sm text-red-300">
                            Сохраните эти коды. Они понадобятся, если вы
                            потеряете доступ к приложению-аутентификатору.
                        </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {recoveryCodes.map((code, i) => (
                            <code
                                key={i}
                                className="text-sm text-white bg-surface-highlight px-3 py-2 rounded font-mono"
                            >
                                {code}
                            </code>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() =>
                                navigator.clipboard.writeText(
                                    recoveryCodes.join("\n"),
                                )
                            }
                            className="px-4 py-2 bg-line-strong text-white text-sm rounded-full hover:bg-line-muted"
                        >
                            Копировать
                        </button>
                        <button
                            onClick={closeRecoveryCodes}
                            className="px-4 py-2 bg-white text-black text-sm font-medium rounded-full hover:scale-105 transition-transform"
                        >
                            Готово
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
