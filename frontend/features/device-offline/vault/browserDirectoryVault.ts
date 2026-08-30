import {
    DeviceAudioVaultError,
    type DeviceAudioAccessRequest,
    type DeviceAudioAccessResult,
    type DeviceAudioAccessState,
    type DeviceAudioDirectoryHandle,
    type DeviceAudioDirectoryRegistry,
    type DeviceAudioExportResult,
    type DeviceAudioPlayResult,
    type DeviceAudioReceipt,
    type DeviceAudioRetainInput,
    type DeviceAudioStorageKind,
    type DeviceAudioTrackDescriptor,
    type DeviceAudioVault,
    type DeviceAudioVaultRef,
    type DeviceAudioVaultRuntime,
    type DeviceAudioVaultSession,
} from "./types";

const PERMISSION_OPTIONS = { mode: "readwrite" } as const;
const VAULT_DIRECTORY_NAME = "Soundspan";
const TRACKS_DIRECTORY_NAME = "tracks";
const MEDIA_REF_VERSION = "fsa1";

const READY_REASON = "Музыкальные файлы хранятся в выбранной папке.";

interface BrowserDirectoryVaultPresentation {
    storageKind: DeviceAudioStorageKind;
    mediaRefVersion: string;
    readyLabel?: string;
    readyReason: string;
}

const DEFAULT_PRESENTATION: BrowserDirectoryVaultPresentation = {
    storageKind: "desktop-directory",
    mediaRefVersion: MEDIA_REF_VERSION,
    readyReason: READY_REASON,
};

function accessState(
    status: DeviceAudioAccessState["status"],
    code: DeviceAudioAccessState["code"],
    label: string,
    reason: string,
    storageKind: DeviceAudioStorageKind,
): DeviceAudioAccessState {
    return {
        status,
        code,
        storageKind:
            status === "unsupported" || status === "error" ? null : storageKind,
        label,
        reason,
    };
}

function readyState(
    handle: DeviceAudioDirectoryHandle,
    presentation: BrowserDirectoryVaultPresentation,
): DeviceAudioAccessState {
    return accessState(
        "ready",
        null,
        presentation.readyLabel || handle.name || "Выбранная папка",
        presentation.readyReason,
        presentation.storageKind,
    );
}

function stateForPermission(
    handle: DeviceAudioDirectoryHandle,
    permission: PermissionState,
    presentation: BrowserDirectoryVaultPresentation,
): DeviceAudioAccessState {
    if (permission === "granted") return readyState(handle, presentation);
    if (permission === "denied") {
        return accessState(
            "denied",
            "permission_denied",
            handle.name || "Выбранная папка",
            "Soundspan не может записывать файлы в выбранную папку.",
            presentation.storageKind,
        );
    }
    return accessState(
        "permission-required",
        "permission_required",
        handle.name || "Выбранная папка",
        "Разрешите Soundspan запись в выбранную папку.",
        presentation.storageKind,
    );
}

function setupRequiredState(
    presentation: BrowserDirectoryVaultPresentation,
): DeviceAudioAccessState {
    return accessState(
        "setup-required",
        "setup_required",
        "Выберите папку с музыкой",
        "Перед загрузкой файлов на это устройство выберите папку.",
        presentation.storageKind,
    );
}

function unsupportedState(): DeviceAudioAccessState {
    return accessState(
        "unsupported",
        "unsupported",
        "Файлы на устройстве недоступны",
        "Этот браузер не может записывать файлы в выбранную пользователем папку.",
        "desktop-directory",
    );
}

function ioState(): DeviceAudioAccessState {
    return accessState(
        "error",
        "io",
        "Хранилище устройства недоступно",
        "Soundspan не удалось проверить выбранную папку.",
        "desktop-directory",
    );
}

function errorFromAccessState(
    state: DeviceAudioAccessState,
): DeviceAudioVaultError {
    const code = state.code ?? "io";
    return new DeviceAudioVaultError(
        code,
        state.reason,
        code === "unsupported" ? "none" : "user-action",
    );
}

function isNamedError(error: unknown, name: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        String(error.name) === name
    );
}

function mapIoError(error: unknown): DeviceAudioVaultError {
    if (error instanceof DeviceAudioVaultError) return error;
    if (isNamedError(error, "AbortError")) {
        return new DeviceAudioVaultError(
            "interrupted",
            "Операция с файлом на устройстве была прервана.",
            "retry",
            { cause: error },
        );
    }
    if (isNamedError(error, "QuotaExceededError")) {
        return new DeviceAudioVaultError(
            "storage_full",
            "На устройстве недостаточно места для этого файла.",
            "user-action",
            { cause: error },
        );
    }
    if (
        isNamedError(error, "NotAllowedError") ||
        isNamedError(error, "SecurityError")
    ) {
        return new DeviceAudioVaultError(
            "permission_denied",
            "Soundspan не может получить доступ к выбранной папке.",
            "user-action",
            { cause: error },
        );
    }
    return new DeviceAudioVaultError(
        "io",
        error instanceof Error
            ? error.message
            : "Не удалось выполнить операцию с файлом на устройстве.",
        "retry",
        { cause: error },
    );
}

function assertSessionCurrent(
    runtime: DeviceAudioVaultRuntime,
    authGeneration: number,
): void {
    if (!runtime.isAuthGenerationCurrent(authGeneration)) {
        throw new DeviceAudioVaultError(
            "auth_changed",
            "Активный аккаунт изменился во время операции с файлом на устройстве.",
            "none",
        );
    }
}

function safeSegment(value: string, fallback: string): string {
    const sanitized = value
        .normalize("NFKC")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[ .]+|[ .]+$/g, "")
        .slice(0, 72)
        .replace(/[ .]+$/g, "");
    return sanitized || fallback;
}

function extensionFor(contentType: string | null): string {
    const normalized = String(contentType ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
    const extensions: Record<string, string> = {
        "audio/aac": "aac",
        "audio/flac": "flac",
        "audio/m4a": "m4a",
        "audio/mp4": "m4a",
        "audio/mpeg": "mp3",
        "audio/ogg": "ogg",
        "audio/opus": "opus",
        "audio/wav": "wav",
        "audio/webm": "webm",
    };
    return extensions[normalized] ?? "audio";
}

function opaqueSuffix(runtime: DeviceAudioVaultRuntime): string {
    const normalized = runtime
        .createOpaqueId()
        .replace(/[^A-Za-z0-9_-]/g, "")
        .slice(0, 24);
    if (normalized.length >= 6) return normalized;
    throw new DeviceAudioVaultError(
        "io",
        "Среда выполнения не создала корректный непрозрачный идентификатор медиафайла.",
        "retry",
    );
}

function displayName(
    track: DeviceAudioTrackDescriptor,
    contentType: string | null,
    runtime: DeviceAudioVaultRuntime,
): string {
    const artist = safeSegment(track.artist.name, "Неизвестный исполнитель");
    const title = safeSegment(track.title, "Без названия");
    return `${artist} - ${title} -- ${opaqueSuffix(runtime)}.${extensionFor(contentType)}`;
}

function mediaRef(
    mediaRefVersion: string,
    ownerScope: string,
    name: string,
): DeviceAudioVaultRef {
    return `${mediaRefVersion}:${ownerScope}:${encodeURIComponent(name)}` as DeviceAudioVaultRef;
}

function parseMediaRef(
    ref: DeviceAudioVaultRef,
    expectedOwnerScope: string,
    mediaRefVersion: string,
): string {
    const parts = String(ref).split(":");
    if (parts.length !== 3 || parts[0] !== mediaRefVersion) {
        throw new DeviceAudioVaultError(
            "invalid_ref",
            "Некорректная ссылка на файл устройства.",
            "none",
        );
    }
    if (parts[1] !== expectedOwnerScope) {
        throw new DeviceAudioVaultError(
            "owner_mismatch",
            "Этот файл на устройстве принадлежит другому аккаунту.",
            "none",
        );
    }
    let name: string;
    try {
        name = decodeURIComponent(parts[2]);
    } catch (error) {
        throw new DeviceAudioVaultError(
            "invalid_ref",
            "Некорректная ссылка на файл устройства.",
            "none",
            { cause: error },
        );
    }
    if (
        !name ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        /[\u0000-\u001f]/.test(name)
    ) {
        throw new DeviceAudioVaultError(
            "invalid_ref",
            "Некорректная ссылка на файл устройства.",
            "none",
        );
    }
    return name;
}

async function removeIfPresent(
    directory: DeviceAudioDirectoryHandle,
    name: string,
): Promise<boolean> {
    try {
        await directory.removeEntry(name);
        return true;
    } catch (error) {
        if (isNamedError(error, "NotFoundError")) return false;
        throw mapIoError(error);
    }
}

async function readFile(
    directory: DeviceAudioDirectoryHandle,
    name: string,
): Promise<Blob | null> {
    try {
        const handle = await directory.getFileHandle(name);
        return await handle.getFile();
    } catch (error) {
        if (isNamedError(error, "NotFoundError")) return null;
        throw mapIoError(error);
    }
}

function verifyBytes(
    file: Blob,
    expectedBytes: number | null | undefined,
): void {
    if (file.size < 1) {
        throw new DeviceAudioVaultError(
            "integrity",
            "Сохранённый файл на устройстве пуст.",
            "retry",
        );
    }
    if (
        typeof expectedBytes === "number" &&
        expectedBytes >= 0 &&
        file.size !== expectedBytes
    ) {
        throw new DeviceAudioVaultError(
            "integrity",
            `Сохранённый файл на устройстве неполный (${file.size} из ${expectedBytes} байт).`,
            "retry",
        );
    }
}

class BrowserDirectorySession implements DeviceAudioVaultSession {
    readonly storage: {
        kind: DeviceAudioStorageKind;
        label: string;
    };

    constructor(
        readonly ownerId: string,
        readonly authGeneration: number,
        private readonly ownerScope: string,
        private readonly tracksDirectory: DeviceAudioDirectoryHandle,
        private readonly runtime: DeviceAudioVaultRuntime,
        private readonly mediaRefVersion: string,
        storageKind: DeviceAudioStorageKind,
        storageLabel: string,
    ) {
        this.storage = {
            kind: storageKind,
            label: storageLabel,
        };
    }

    async retain(input: DeviceAudioRetainInput): Promise<DeviceAudioReceipt> {
        assertSessionCurrent(this.runtime, this.authGeneration);
        const name = displayName(input.track, input.contentType, this.runtime);
        let writer: Awaited<
            ReturnType<
                Awaited<
                    ReturnType<DeviceAudioDirectoryHandle["getFileHandle"]>
                >["createWritable"]
            >
        > | null = null;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        let committed = false;
        try {
            if (input.signal?.aborted) {
                throw new DOMException("Загрузка прервана", "AbortError");
            }
            const fileHandle = await this.tracksDirectory.getFileHandle(name, {
                create: true,
            });
            writer = await fileHandle.createWritable();
            reader = input.stream.getReader();
            let bytes = 0;
            while (true) {
                assertSessionCurrent(this.runtime, this.authGeneration);
                if (input.signal?.aborted) {
                    throw new DOMException("Загрузка прервана", "AbortError");
                }
                const chunk = await reader.read();
                if (chunk.done) break;
                if (!(chunk.value instanceof Uint8Array)) {
                    throw new DeviceAudioVaultError(
                        "io",
                        "Поток файла на устройстве вернул некорректный фрагмент.",
                        "retry",
                    );
                }
                await writer.write(chunk.value);
                bytes += chunk.value.byteLength;
                input.onProgress?.(bytes, input.expectedBytes ?? null);
            }
            if (input.signal?.aborted) {
                throw new DOMException("Загрузка прервана", "AbortError");
            }
            await writer.close();
            writer = null;
            if (input.signal?.aborted) {
                throw new DOMException("Загрузка прервана", "AbortError");
            }
            assertSessionCurrent(this.runtime, this.authGeneration);
            const file = await fileHandle.getFile();
            if (input.signal?.aborted) {
                throw new DOMException("Загрузка прервана", "AbortError");
            }
            assertSessionCurrent(this.runtime, this.authGeneration);
            verifyBytes(file, input.expectedBytes);
            if (input.signal?.aborted) {
                throw new DOMException("Загрузка прервана", "AbortError");
            }
            assertSessionCurrent(this.runtime, this.authGeneration);
            committed = true;
            let discardPromise: Promise<void> | null = null;
            return {
                ref: mediaRef(this.mediaRefVersion, this.ownerScope, name),
                bytes: file.size,
                contentType: input.contentType,
                displayName: name,
                persistenceGranted: true,
                discard: () => {
                    discardPromise ??= removeIfPresent(
                        this.tracksDirectory,
                        name,
                    )
                        .then(() => undefined)
                        .catch((error: unknown) => {
                            discardPromise = null;
                            throw error;
                        });
                    return discardPromise;
                },
            };
        } catch (error) {
            await writer?.abort?.().catch(() => undefined);
            if (!committed) {
                await removeIfPresent(this.tracksDirectory, name).catch(
                    () => undefined,
                );
            }
            throw mapIoError(error);
        } finally {
            reader?.releaseLock();
        }
    }

    async access<T extends DeviceAudioAccessRequest>(
        input: T,
    ): Promise<DeviceAudioAccessResult<T>> {
        assertSessionCurrent(this.runtime, this.authGeneration);
        const name = parseMediaRef(
            input.ref,
            this.ownerScope,
            this.mediaRefVersion,
        );
        if (input.kind === "remove") {
            return {
                kind: "remove",
                removed: await removeIfPresent(this.tracksDirectory, name),
            } as DeviceAudioAccessResult<T>;
        }

        const file = await readFile(this.tracksDirectory, name);
        if (!file) {
            if (input.kind === "inspect") {
                return {
                    kind: "inspect",
                    exists: false,
                    bytes: null,
                } as DeviceAudioAccessResult<T>;
            }
            throw new DeviceAudioVaultError(
                "not_found",
                "Этот файл на устройстве больше недоступен.",
                "retry",
            );
        }
        verifyBytes(file, input.expectedBytes);
        if (input.kind === "inspect") {
            return {
                kind: "inspect",
                exists: true,
                bytes: file.size,
            } as DeviceAudioAccessResult<T>;
        }

        const url = this.runtime.createObjectUrl(file);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this.runtime.revokeObjectUrl(url);
        };
        const result: DeviceAudioPlayResult | DeviceAudioExportResult =
            input.kind === "export"
                ? {
                      kind: "export",
                      url,
                      displayName: name,
                      bytes: file.size,
                      release,
                  }
                : { kind: "play", url, release };
        return result as DeviceAudioAccessResult<T>;
    }
}

class BrowserDirectoryDeviceAudioVault implements DeviceAudioVault {
    private cachedHandle: DeviceAudioDirectoryHandle | null = null;
    private registryInspected = false;

    constructor(
        private readonly registry: DeviceAudioDirectoryRegistry,
        private readonly runtime: DeviceAudioVaultRuntime,
        private readonly presentation: BrowserDirectoryVaultPresentation,
    ) {}

    async inspectAccess(): Promise<DeviceAudioAccessState> {
        if (!this.runtime.isSupported()) return unsupportedState();
        try {
            if (!this.registryInspected) {
                this.cachedHandle = await this.registry.load();
                this.registryInspected = true;
            }
            if (!this.cachedHandle) {
                return setupRequiredState(this.presentation);
            }
            return stateForPermission(
                this.cachedHandle,
                await this.cachedHandle.queryPermission(PERMISSION_OPTIONS),
                this.presentation,
            );
        } catch (error) {
            if (
                error instanceof DeviceAudioVaultError &&
                error.code === "unsupported"
            ) {
                return unsupportedState();
            }
            return ioState();
        }
    }

    async requestAccess(): Promise<DeviceAudioAccessState> {
        if (!this.runtime.isSupported()) return unsupportedState();

        if (!this.cachedHandle) {
            // Deliberately invoke the picker before any registry I/O. File
            // System Access requires the transient user activation owned by
            // the caller of requestAccess(). inspectAccess() is responsible
            // for hydrating a persisted handle before this interactive path.
            let picker: Promise<DeviceAudioDirectoryHandle>;
            try {
                picker = this.runtime.pickDirectory();
            } catch (error) {
                throw mapIoError(error);
            }
            let selected: DeviceAudioDirectoryHandle;
            try {
                selected = await picker;
            } catch (error) {
                if (isNamedError(error, "AbortError")) {
                    throw new DeviceAudioVaultError(
                        "user_cancelled",
                        "Папка на устройстве не выбрана.",
                        "user-action",
                        { cause: error },
                    );
                }
                throw mapIoError(error);
            }
            const permission =
                await selected.queryPermission(PERMISSION_OPTIONS);
            const granted =
                permission === "granted"
                    ? permission
                    : await selected.requestPermission(PERMISSION_OPTIONS);
            const state = stateForPermission(
                selected,
                granted,
                this.presentation,
            );
            if (state.status !== "ready") return state;
            await this.registry.save(selected).catch((error: unknown) => {
                throw mapIoError(error);
            });
            this.cachedHandle = selected;
            this.registryInspected = true;
            return state;
        }

        try {
            const current =
                await this.cachedHandle.queryPermission(PERMISSION_OPTIONS);
            const permission =
                current === "granted"
                    ? current
                    : await this.cachedHandle.requestPermission(
                          PERMISSION_OPTIONS,
                      );
            return stateForPermission(
                this.cachedHandle,
                permission,
                this.presentation,
            );
        } catch (error) {
            throw mapIoError(error);
        }
    }

    async open(input: {
        ownerId: string;
        authGeneration: number;
    }): Promise<DeviceAudioVaultSession> {
        const ownerId = input.ownerId.trim();
        if (!ownerId) {
            throw new DeviceAudioVaultError(
                "invalid_owner",
                "Для доступа к файлам на устройстве нужно войти в аккаунт.",
                "none",
            );
        }
        assertSessionCurrent(this.runtime, input.authGeneration);
        const access = await this.inspectAccess();
        if (access.status !== "ready" || !this.cachedHandle) {
            throw errorFromAccessState(access);
        }
        try {
            const scope = await this.runtime.ownerScope(ownerId);
            if (!/^[A-Za-z0-9_-]{8,128}$/.test(scope)) {
                throw new DeviceAudioVaultError(
                    "io",
                    "Среда выполнения создала некорректную область владельца.",
                    "retry",
                );
            }
            const vaultDirectory = await this.cachedHandle.getDirectoryHandle(
                VAULT_DIRECTORY_NAME,
                { create: true },
            );
            const ownerDirectory = await vaultDirectory.getDirectoryHandle(
                scope,
                { create: true },
            );
            const tracksDirectory = await ownerDirectory.getDirectoryHandle(
                TRACKS_DIRECTORY_NAME,
                { create: true },
            );
            assertSessionCurrent(this.runtime, input.authGeneration);
            return new BrowserDirectorySession(
                ownerId,
                input.authGeneration,
                scope,
                tracksDirectory,
                this.runtime,
                this.presentation.mediaRefVersion,
                this.presentation.storageKind,
                access.label,
            );
        } catch (error) {
            throw mapIoError(error);
        }
    }
}

/** Create the File System Access adapter with injected local dependencies. */
export function createBrowserDirectoryDeviceAudioVault(input: {
    registry: DeviceAudioDirectoryRegistry;
    runtime: DeviceAudioVaultRuntime;
    presentation?: Partial<BrowserDirectoryVaultPresentation>;
}): DeviceAudioVault {
    return new BrowserDirectoryDeviceAudioVault(input.registry, input.runtime, {
        ...DEFAULT_PRESENTATION,
        ...input.presentation,
    });
}
