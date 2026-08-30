"use client";

import { useState, useEffect, useCallback } from "react";
import { Trash2, Copy, Check } from "lucide-react";
import { SettingsSection, SettingsInput, SettingsSelect } from "../ui";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { Badge } from "@/components/ui/Badge";
import { useAdminConnectedUsers } from "@/hooks/useSocialPresence";
import {
    adminManagementRu,
    formatInviteExpiry,
    inviteStatusLabel,
    localizeUserManagementError,
} from "@/lib/i18n/adminManagementRu";
import { pluralRu } from "@/lib/i18n/ru";
import type { User } from "../../types";

const logger = createFrontendLogger("Settings.UserManagementSection");

interface InviteCode {
    id: string;
    code: string;
    status: "active" | "expired" | "exhausted" | "revoked";
    maxUses: number;
    useCount: number;
    expiresAt: string | null;
    createdAt: string;
    createdBy: string;
}

function UserSsoBadge({ user }: { user: User }) {
    const label = !user.hasPassword
        ? adminManagementRu.users.ssoOnly
        : user.linkedProviders.length > 0
          ? "SSO"
          : null;
    if (!label) return null;
    return (
        <Badge
            variant={user.hasPassword ? "info" : "warning"}
            title={
                user.linkedProviders.length > 0
                    ? user.linkedProviders.join(", ")
                    : adminManagementRu.users.noLocalPassword
            }
            className="ml-2"
        >
            {label}
        </Badge>
    );
}

/**
 * Renders the UserManagementSection component.
 */
export function UserManagementSection() {
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === "admin";
    const [users, setUsers] = useState<User[]>([]);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newRole, setNewRole] = useState<"user" | "admin">("user");
    const [creating, setCreating] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [createStatus, setCreateStatus] = useState<StatusType>("idle");
    const [createMessage, setCreateMessage] = useState("");
    const [deleteStatus, setDeleteStatus] = useState<StatusType>("idle");
    const [deleteMessage, setDeleteMessage] = useState("");
    const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
    const [inviteTtl, setInviteTtl] = useState("24h");
    const [inviteMaxUses, setInviteMaxUses] = useState("1");
    const [generatingInvite, setGeneratingInvite] = useState(false);
    const [inviteStatus, setInviteStatus] = useState<StatusType>("idle");
    const [inviteMessage, setInviteMessage] = useState("");
    const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
    const [editingUser, setEditingUser] = useState<User | null>(null);
    const [editUsername, setEditUsername] = useState("");
    const [editEmail, setEditEmail] = useState("");
    const [editPassword, setEditPassword] = useState("");
    const [editRole, setEditRole] = useState<"user" | "admin">("user");
    const [editStatus, setEditStatus] = useState<StatusType>("idle");
    const [editMessage, setEditMessage] = useState("");
    const [savingEdit, setSavingEdit] = useState(false);
    const { users: connectedUsers, isLoading: connectedLoading } =
        useAdminConnectedUsers(Boolean(isAdmin));

    const loadInviteCodes = useCallback(async () => {
        try {
            const data = await api.getInviteCodes();
            setInviteCodes(data);
        } catch (error) {
            logger.error("Failed to load invite codes", { error });
        }
    }, []);

    useEffect(() => {
        loadUsers();
        loadInviteCodes();
    }, [loadInviteCodes]);

    const loadUsers = async () => {
        try {
            setLoading(true);
            const data = await api.get<User[]>("/auth/users");
            setUsers(data);
        } catch (error) {
            logger.error("Failed to load users", { error });
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async () => {
        if (!newUsername.trim() || newPassword.length < 6) {
            setCreateStatus("error");
            setCreateMessage(adminManagementRu.users.invalidCredentials);
            return;
        }

        setCreating(true);
        setCreateStatus("loading");
        try {
            await api.post("/auth/create-user", {
                username: newUsername,
                password: newPassword,
                role: newRole,
            });
            setCreateStatus("success");
            setCreateMessage(adminManagementRu.users.created);
            setNewUsername("");
            setNewPassword("");
            setNewRole("user");
            loadUsers();
        } catch (error: unknown) {
            setCreateStatus("error");
            setCreateMessage(localizeUserManagementError(error));
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async (userId: string) => {
        setDeleteStatus("loading");
        try {
            await api.delete(`/auth/users/${userId}`);
            setDeleteStatus("success");
            setDeleteMessage(adminManagementRu.users.deleted);
            setConfirmDelete(null);
            loadUsers();
        } catch (error: unknown) {
            setDeleteStatus("error");
            setDeleteMessage(localizeUserManagementError(error));
        }
    };

    const handleGenerateInvite = async () => {
        setGeneratingInvite(true);
        setInviteStatus("loading");
        try {
            const maxUses = parseInt(inviteMaxUses, 10) || 1;
            await api.createInviteCode(inviteTtl, maxUses);
            setInviteStatus("success");
            setInviteMessage(adminManagementRu.users.inviteGenerated);
            loadInviteCodes();
        } catch (error: unknown) {
            setInviteStatus("error");
            setInviteMessage(localizeUserManagementError(error));
        } finally {
            setGeneratingInvite(false);
        }
    };

    const handleRevokeInvite = async (id: string) => {
        try {
            await api.revokeInviteCode(id);
            loadInviteCodes();
        } catch (error) {
            logger.error("Failed to revoke invite code", { error });
        }
    };

    const handleCopyInviteLink = (code: string, id: string) => {
        const url = `${window.location.origin}/register?code=${code}`;
        navigator.clipboard.writeText(url);
        setCopiedCodeId(id);
        setTimeout(() => setCopiedCodeId(null), 2000);
    };

    const statusColor = (status: string) => {
        switch (status) {
            case "active":
                return "text-green-400 bg-green-400/10 border-green-400/20";
            case "expired":
                return "text-yellow-400 bg-yellow-400/10 border-yellow-400/20";
            case "exhausted":
                return "text-blue-400 bg-blue-400/10 border-blue-400/20";
            case "revoked":
                return "text-red-400 bg-red-400/10 border-red-400/20";
            default:
                return "text-gray-400 bg-gray-400/10 border-gray-400/20";
        }
    };

    const openEditModal = (user: User) => {
        setEditingUser(user);
        setEditUsername(user.username);
        setEditEmail(user.email || "");
        setEditPassword("");
        setEditRole(user.role);
        setEditStatus("idle");
        setEditMessage("");
    };

    const closeEditModal = () => {
        setEditingUser(null);
        setEditPassword("");
        setEditStatus("idle");
    };

    const handleEditUser = async () => {
        if (!editingUser) return;

        const payload: Record<string, string> = {};
        if (editUsername.trim() && editUsername !== editingUser.username) {
            payload.username = editUsername.trim();
        }
        if (editEmail.trim() !== (editingUser.email || "")) {
            payload.email = editEmail.trim();
        }
        if (editPassword) {
            if (editPassword.length < 6) {
                setEditStatus("error");
                setEditMessage(adminManagementRu.users.passwordTooShort);
                return;
            }
            payload.password = editPassword;
        }
        if (editRole !== editingUser.role) {
            payload.role = editRole;
        }

        if (Object.keys(payload).length === 0) {
            setEditStatus("error");
            setEditMessage(adminManagementRu.users.noChanges);
            return;
        }

        setSavingEdit(true);
        setEditStatus("loading");
        try {
            await api.patch(`/auth/users/${editingUser.id}`, payload);
            setEditStatus("success");
            setEditMessage(adminManagementRu.users.saved);
            loadUsers();
            setTimeout(closeEditModal, 1000);
        } catch (error: unknown) {
            setEditStatus("error");
            setEditMessage(localizeUserManagementError(error));
        } finally {
            setSavingEdit(false);
        }
    };

    if (!isAdmin) {
        return null;
    }

    return (
        <>
            <SettingsSection
                id="users"
                title={adminManagementRu.users.title}
                description={adminManagementRu.users.description}
                showSeparator={false}
            >
                {/* Create User Form */}
                <div className="py-4 px-4 bg-surface-hover rounded-lg mb-4">
                    <h3 className="text-sm font-medium text-white mb-3">
                        {adminManagementRu.users.createTitle}
                    </h3>
                    <div className="space-y-3">
                        <div className="flex gap-3">
                            <SettingsInput
                                value={newUsername}
                                onChange={setNewUsername}
                                placeholder={adminManagementRu.users.username}
                                className="flex-1"
                            />
                            <SettingsInput
                                type="password"
                                value={newPassword}
                                onChange={setNewPassword}
                                placeholder={adminManagementRu.users.password}
                                className="flex-1"
                            />
                        </div>
                        <div className="inline-flex gap-3 items-center">
                            <SettingsSelect
                                value={newRole}
                                onChange={(v) =>
                                    setNewRole(v as "user" | "admin")
                                }
                                options={[
                                    {
                                        value: "user",
                                        label: adminManagementRu.users.user,
                                    },
                                    {
                                        value: "admin",
                                        label: adminManagementRu.users.admin,
                                    },
                                ]}
                            />
                            <button
                                onClick={handleCreate}
                                disabled={
                                    creating ||
                                    !newUsername.trim() ||
                                    newPassword.length < 6
                                }
                                className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                                    hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                {creating
                                    ? adminManagementRu.users.creating
                                    : adminManagementRu.users.create}
                            </button>
                            <InlineStatus
                                status={createStatus}
                                message={createMessage}
                                onClear={() => setCreateStatus("idle")}
                            />
                        </div>
                    </div>
                </div>

                {/* Invite Codes */}
                <div className="py-4 px-4 bg-surface-hover rounded-lg mb-4">
                    <h3 className="text-sm font-medium text-white mb-3">
                        {adminManagementRu.users.invites}
                    </h3>
                    <div className="space-y-3">
                        <div className="flex gap-3 items-center flex-wrap">
                            <SettingsSelect
                                value={inviteTtl}
                                onChange={setInviteTtl}
                                options={[
                                    {
                                        value: "1h",
                                        label: adminManagementRu.users.oneHour,
                                    },
                                    {
                                        value: "6h",
                                        label: adminManagementRu.users.sixHours,
                                    },
                                    {
                                        value: "24h",
                                        label: adminManagementRu.users.oneDay,
                                    },
                                    {
                                        value: "7d",
                                        label: adminManagementRu.users
                                            .sevenDays,
                                    },
                                    {
                                        value: "30d",
                                        label: adminManagementRu.users
                                            .thirtyDays,
                                    },
                                    {
                                        value: "never",
                                        label: adminManagementRu.users
                                            .neverExpires,
                                    },
                                ]}
                            />
                            <SettingsInput
                                type="number"
                                value={inviteMaxUses}
                                onChange={setInviteMaxUses}
                                placeholder={adminManagementRu.users.maxUses}
                                className="w-24"
                            />
                            <button
                                onClick={handleGenerateInvite}
                                disabled={generatingInvite}
                                className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                                    hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                {generatingInvite
                                    ? adminManagementRu.users.generating
                                    : adminManagementRu.users.generateInvite}
                            </button>
                            <InlineStatus
                                status={inviteStatus}
                                message={inviteMessage}
                                onClear={() => setInviteStatus("idle")}
                            />
                        </div>

                        {inviteCodes.length > 0 && (
                            <div className="space-y-2 mt-3">
                                {inviteCodes.map((code) => (
                                    <div
                                        key={code.id}
                                        className="flex items-center justify-between px-3 py-2 rounded-md bg-white/[0.03] border border-white/5"
                                    >
                                        <div className="flex items-center gap-3 min-w-0">
                                            <code className="text-sm font-mono text-white tracking-wider">
                                                {code.code}
                                            </code>
                                            <span
                                                className={`text-[11px] px-2 py-0.5 rounded-full border capitalize ${statusColor(code.status)}`}
                                            >
                                                {inviteStatusLabel(code.status)}
                                            </span>
                                            <span className="text-xs text-white/40">
                                                {code.useCount}/{code.maxUses}{" "}
                                                {adminManagementRu.users.uses}
                                            </span>
                                            <span className="text-xs text-white/40">
                                                {formatInviteExpiry(
                                                    code.expiresAt,
                                                )}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            {code.status === "active" && (
                                                <>
                                                    <button
                                                        onClick={() =>
                                                            handleCopyInviteLink(
                                                                code.code,
                                                                code.id,
                                                            )
                                                        }
                                                        className="p-1.5 text-gray-400 hover:text-white transition-colors"
                                                        title={
                                                            adminManagementRu
                                                                .users
                                                                .copyInvite
                                                        }
                                                    >
                                                        {copiedCodeId ===
                                                        code.id ? (
                                                            <Check className="w-3.5 h-3.5 text-green-400" />
                                                        ) : (
                                                            <Copy className="w-3.5 h-3.5" />
                                                        )}
                                                    </button>
                                                    <button
                                                        onClick={() =>
                                                            handleRevokeInvite(
                                                                code.id,
                                                            )
                                                        }
                                                        className="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
                                                        title={
                                                            adminManagementRu
                                                                .users
                                                                .revokeInvite
                                                        }
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Connected Users */}
                <div className="py-4 px-4 bg-[#151515] rounded-lg mb-4 border border-white/5">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-medium text-white">
                            {adminManagementRu.users.connectedNow}
                        </h3>
                        <span className="text-xs text-green-400 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                            {connectedUsers.length}{" "}
                            {pluralRu(connectedUsers.length, [
                                "пользователь",
                                "пользователя",
                                "пользователей",
                            ])}{" "}
                            {adminManagementRu.users.online}
                        </span>
                    </div>

                    {connectedLoading ? (
                        <div className="py-2 text-sm text-gray-400">
                            {adminManagementRu.users.checkingConnected}
                        </div>
                    ) : connectedUsers.length === 0 ? (
                        <div className="py-2 text-sm text-gray-400">
                            {adminManagementRu.users.noConnected}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {connectedUsers.map((connectedUser) => (
                                <div
                                    key={connectedUser.id}
                                    className="flex items-center justify-between px-2 py-2 rounded-md bg-white/[0.03]"
                                >
                                    <div className="min-w-0">
                                        <p className="text-sm text-white truncate">
                                            {connectedUser.displayName}
                                            {currentUser?.id ===
                                                connectedUser.id && (
                                                <span className="text-xs text-gray-400 ml-2">
                                                    {`(${adminManagementRu.users.you})`}
                                                </span>
                                            )}
                                        </p>
                                        <p className="text-xs text-gray-400 truncate">
                                            @{connectedUser.username}
                                        </p>
                                    </div>
                                    <span className="text-[11px] text-white/40 capitalize">
                                        {connectedUser.role === "admin"
                                            ? adminManagementRu.users.admin
                                            : adminManagementRu.users.user}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Users List */}
                <div className="space-y-1">
                    {loading ? (
                        <div className="py-4 text-sm text-gray-400">
                            {adminManagementRu.users.loading}
                        </div>
                    ) : users.length === 0 ? (
                        <div className="py-4 text-sm text-gray-400">
                            {adminManagementRu.users.empty}
                        </div>
                    ) : (
                        users.map((user) => (
                            <div
                                key={user.id}
                                className="flex items-center justify-between py-3 px-3 rounded-md hover:bg-white/5 cursor-pointer"
                                onClick={() => openEditModal(user)}
                            >
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-full bg-line-strong flex items-center justify-center text-sm text-white">
                                        {user.username[0].toUpperCase()}
                                    </div>
                                    <div>
                                        <div className="text-sm text-white">
                                            {user.username}
                                            <UserSsoBadge user={user} />
                                            {currentUser?.id === user.id && (
                                                <span className="text-xs text-gray-400 ml-2">
                                                    {`(${adminManagementRu.users.you})`}
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-xs text-gray-400">
                                            {user.role === "admin"
                                                ? adminManagementRu.users.admin
                                                : adminManagementRu.users.user}
                                            {user.email && (
                                                <span className="ml-2">
                                                    {user.email}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {currentUser?.id !== user.id && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setConfirmDelete(user.id);
                                        }}
                                        className="p-2 text-gray-400 hover:text-red-400 transition-colors"
                                        title={adminManagementRu.users.delete}
                                        aria-label={
                                            adminManagementRu.users.delete
                                        }
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </SettingsSection>

            {/* Edit User Modal */}
            <Modal
                isOpen={!!editingUser}
                onClose={closeEditModal}
                title={`${adminManagementRu.users.editTitle} — ${editingUser?.username}`}
            >
                <div className="space-y-4">
                    <div>
                        <label
                            htmlFor="edit-user-role"
                            className="block text-sm font-medium text-white/90 mb-1.5"
                        >
                            {adminManagementRu.users.role}
                        </label>
                        <SettingsSelect
                            id="edit-user-role"
                            value={editRole}
                            onChange={(value) =>
                                setEditRole(value as "user" | "admin")
                            }
                            options={[
                                {
                                    value: "user",
                                    label: adminManagementRu.users.user,
                                },
                                {
                                    value: "admin",
                                    label: adminManagementRu.users.admin,
                                },
                            ]}
                        />
                        {editingUser?.linkedProviders.length ? (
                            <p className="mt-1.5 text-xs text-gray-400">
                                {adminManagementRu.users.oidcRoleWarning}
                            </p>
                        ) : null}
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-white/90 mb-1.5">
                            {adminManagementRu.users.username}
                        </label>
                        <SettingsInput
                            value={editUsername}
                            onChange={setEditUsername}
                            placeholder={adminManagementRu.users.username}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-white/90 mb-1.5">
                            {adminManagementRu.users.email}
                        </label>
                        <SettingsInput
                            type="email"
                            value={editEmail}
                            onChange={setEditEmail}
                            placeholder="user@example.com"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-white/90 mb-1.5">
                            {editingUser?.hasPassword
                                ? adminManagementRu.users.newPassword
                                : adminManagementRu.users.setPassword}
                        </label>
                        <SettingsInput
                            type="password"
                            value={editPassword}
                            onChange={setEditPassword}
                            placeholder={
                                editingUser?.hasPassword
                                    ? adminManagementRu.users.keepPassword
                                    : adminManagementRu.users.remainSsoOnly
                            }
                        />
                    </div>
                    <div className="flex gap-2 justify-end items-center">
                        <InlineStatus
                            status={editStatus}
                            message={editMessage}
                            onClear={() => setEditStatus("idle")}
                        />
                        <button
                            onClick={closeEditModal}
                            className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                        >
                            {adminManagementRu.users.cancel}
                        </button>
                        <button
                            onClick={handleEditUser}
                            disabled={savingEdit}
                            className="px-4 py-2 text-sm bg-white text-black font-medium rounded-full
                                hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                        >
                            {savingEdit
                                ? adminManagementRu.users.saving
                                : adminManagementRu.users.saveChanges}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={!!confirmDelete}
                onClose={() => setConfirmDelete(null)}
                title={adminManagementRu.users.deleteTitle}
            >
                <div className="space-y-4">
                    <p className="text-sm text-gray-300">
                        {adminManagementRu.users.deleteQuestion}
                    </p>
                    <div className="flex gap-2 justify-end items-center">
                        <InlineStatus
                            status={deleteStatus}
                            message={deleteMessage}
                            onClear={() => setDeleteStatus("idle")}
                        />
                        <button
                            onClick={() => setConfirmDelete(null)}
                            className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                        >
                            {adminManagementRu.users.cancel}
                        </button>
                        <button
                            onClick={() =>
                                confirmDelete && handleDelete(confirmDelete)
                            }
                            className="px-4 py-2 text-sm bg-red-500 text-white rounded-full hover:bg-red-600"
                        >
                            {adminManagementRu.users.delete}
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
