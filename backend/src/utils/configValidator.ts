import * as fs from "fs";
import { logger } from "./logger";
import * as path from "path";
import { execFileSync } from "child_process";
import { AppError, ErrorCode, ErrorCategory } from "./errors";
import { parseEnvInt } from "./envParsers";

const ffmpegLogger = logger.child("FFmpeg");
const SYSTEM_FFMPEG_PATH = "/usr/bin/ffmpeg";
const MINIMUM_FFMPEG_MAJOR = 4;
const MINIMUM_FFMPEG_MINOR = 4;
const FFMPEG_VERSION_TIMEOUT_MS = 5_000;
const FFMPEG_VERSION_MAX_BUFFER_BYTES = 64 * 1024;
const FFMPEG_VERSION_PATTERN =
    /^ffmpeg version (?:n)?(\d+)\.(\d+)(?:[.\s-]|$)/i;

/** Resolves the configured FFmpeg executable, defaulting to the image system binary. */
export function resolveFfmpegBinaryPath(configuredPath?: string): string {
    return configuredPath?.trim() || SYSTEM_FFMPEG_PATH;
}

/** Verifies that an available FFmpeg executable meets the supported version floor. */
export function inspectFfmpegVersion(binaryPath: string): string | null {
    let output: string;
    try {
        output = execFileSync(binaryPath, ["-version"], {
            encoding: "utf8",
            maxBuffer: FFMPEG_VERSION_MAX_BUFFER_BYTES,
            timeout: FFMPEG_VERSION_TIMEOUT_MS,
        });
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ETIMEDOUT" &&
            "stdout" in error &&
            typeof error.stdout === "string" &&
            FFMPEG_VERSION_PATTERN.test(
                error.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "",
            )
        ) {
            // Some distro builds print their complete version and then stall
            // during process teardown. The executable is usable and its
            // captured version is still sufficient for the startup gate.
            output = error.stdout;
        } else if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            return null;
        } else {
            throw new Error(`Unable to execute FFmpeg at ${binaryPath}`, {
                cause: error,
            });
        }
    }

    const versionLine = output.split(/\r?\n/, 1)[0]?.trim() ?? "";
    const versionMatch = FFMPEG_VERSION_PATTERN.exec(versionLine);
    if (!versionMatch) {
        throw new Error(`Unable to determine FFmpeg version at ${binaryPath}`);
    }

    const major = Number.parseInt(versionMatch[1], 10);
    const minor = Number.parseInt(versionMatch[2], 10);
    const isSupported =
        major > MINIMUM_FFMPEG_MAJOR ||
        (major === MINIMUM_FFMPEG_MAJOR && minor >= MINIMUM_FFMPEG_MINOR);
    if (!isSupported) {
        throw new Error(
            `FFmpeg ${major}.${minor} is unsupported; version 4.4 or newer is required`,
        );
    }

    return versionLine;
}

export interface MusicConfig {
    musicPath: string;
    transcodeCachePath: string;
    transcodeCacheMaxGb: number;
}

/**
 * Validate and load music configuration
 */
export async function validateMusicConfig(): Promise<MusicConfig> {
    // Loading systemSettings at module initialization pulls in Prisma. Config
    // must first resolve DATABASE_URL from the split-runtime POSTGRES_* values,
    // otherwise the adapter is permanently created with an empty connection
    // string and falls back to 127.0.0.1. Keep this dependency lazy so config
    // bootstrap completes before database-backed settings are read.
    const { getSystemSettings } = await import("./systemSettings");
    // Get system settings to use configured paths
    const settings = await getSystemSettings();

    // Priority: Environment variable > Database setting > Default
    // Env var takes precedence to support Docker deployments where mount point is fixed
    let musicPath = process.env.MUSIC_PATH || settings?.musicPath || "/music";

    // Docker safety: If configured path doesn't exist but /music does, use /music
    // This handles users passing host .env files to Docker with host paths
    const isDocker = fs.existsSync("/.dockerenv");
    if (isDocker && !fs.existsSync(musicPath) && fs.existsSync("/music")) {
        logger.warn(
            `MUSIC_PATH=${musicPath} not found in container, using /music (Docker mount point)`,
        );
        musicPath = "/music";
    }

    // Log if database has a different path than what we're using (helps debug migrations)
    if (settings?.musicPath && settings.musicPath !== musicPath) {
        logger.debug(
            `Database has musicPath=${settings.musicPath}, using ${musicPath} from env/default`,
        );
    }

    // VALIDATE MUSIC PATH EXISTS
    if (!fs.existsSync(musicPath)) {
        const isDocker =
            fs.existsSync("/.dockerenv") ||
            process.env.NODE_ENV === "production";
        const guidance = isDocker
            ? `Docker users: Ensure your volume mount is correct in docker-compose.yml:
   volumes:
     - /path/to/your/music:/music
   The container expects music at /music, not your host path.`
            : `Check that MUSIC_PATH in your .env file points to an existing directory.`;

        throw new AppError(
            ErrorCode.MUSIC_PATH_NOT_ACCESSIBLE,
            ErrorCategory.FATAL,
            `Music path does not exist: ${musicPath}\n\n${guidance}`,
        );
    }

    // VALIDATE MUSIC PATH IS READABLE
    try {
        fs.accessSync(musicPath, fs.constants.R_OK);
    } catch {
        throw new AppError(
            ErrorCode.MUSIC_PATH_NOT_ACCESSIBLE,
            ErrorCategory.FATAL,
            `Music path not readable: ${musicPath}. Check file permissions.`,
        );
    }

    // Get transcode cache path
    const transcodeCachePath =
        process.env.TRANSCODE_CACHE_PATH ||
        path.join(process.cwd(), "cache", "transcodes");

    // VALIDATE TRANSCODE CACHE PATH
    // Create if doesn't exist
    if (!fs.existsSync(transcodeCachePath)) {
        try {
            fs.mkdirSync(transcodeCachePath, { recursive: true });
            logger.debug(
                `Created transcode cache directory: ${transcodeCachePath}`,
            );
        } catch (err: any) {
            throw new AppError(
                ErrorCode.TRANSCODE_CACHE_NOT_WRITABLE,
                ErrorCategory.FATAL,
                `Cannot create transcode cache directory: ${transcodeCachePath}`,
                { originalError: err.message },
            );
        }
    }

    // Validate writable
    try {
        fs.accessSync(transcodeCachePath, fs.constants.W_OK);
    } catch {
        throw new AppError(
            ErrorCode.TRANSCODE_CACHE_NOT_WRITABLE,
            ErrorCategory.FATAL,
            `Transcode cache not writable: ${transcodeCachePath}. Check file permissions.`,
        );
    }

    // Get cache size limit from SystemSettings or fallback to env/default
    const transcodeCacheMaxGb =
        settings?.transcodeCacheMaxGb ||
        parseEnvInt(process.env.TRANSCODE_CACHE_MAX_GB, 10);

    if (isNaN(transcodeCacheMaxGb) || transcodeCacheMaxGb < 1) {
        throw new AppError(
            ErrorCode.INVALID_CONFIG,
            ErrorCategory.FATAL,
            `Invalid transcode cache size: must be a positive integer. Got: ${transcodeCacheMaxGb}`,
        );
    }

    const ffmpegPath = resolveFfmpegBinaryPath(process.env.FFMPEG_PATH);
    const ffmpegVersion = inspectFfmpegVersion(ffmpegPath);
    if (ffmpegVersion) {
        ffmpegLogger.debug("System FFmpeg validated", {
            ffmpegPath,
            version: ffmpegVersion,
        });
    } else {
        ffmpegLogger.warn(
            "System FFmpeg is not available; transcoding is disabled",
            { ffmpegPath },
        );
    }

    logger.debug("Music configuration validated successfully");
    logger.debug(`   Music path: ${musicPath}`);
    logger.debug(`   Transcode cache: ${transcodeCachePath}`);
    logger.debug(`   Cache limit: ${transcodeCacheMaxGb} GB`);

    return {
        musicPath,
        transcodeCachePath,
        transcodeCacheMaxGb,
    };
}
