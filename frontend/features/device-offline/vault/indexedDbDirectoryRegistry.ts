import type {
    DeviceAudioDirectoryHandle,
    DeviceAudioDirectoryRegistry,
} from "./types";

const DATABASE_NAME = "soundspan-device-audio-vault-v1";
const STORE_NAME = "directory-handles";
const DIRECTORY_KEY = "desktop-directory";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

class IndexedDbDeviceAudioDirectoryRegistry implements DeviceAudioDirectoryRegistry {
    private databasePromise: Promise<IDBDatabase> | null = null;

    private database(): Promise<IDBDatabase> {
        if (this.databasePromise) return this.databasePromise;
        const attempt = new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(DATABASE_NAME, 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                    request.result.createObjectStore(STORE_NAME);
                }
            };
            request.onsuccess = () => {
                const database = request.result;
                database.onversionchange = () => {
                    database.close();
                    this.databasePromise = null;
                };
                resolve(database);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () =>
                reject(
                    new Error("Device audio vault database upgrade blocked"),
                );
        });
        const retryableAttempt = attempt.catch((error: unknown) => {
            if (this.databasePromise === retryableAttempt) {
                this.databasePromise = null;
            }
            throw error;
        });
        this.databasePromise = retryableAttempt;
        return retryableAttempt;
    }

    async load(): Promise<DeviceAudioDirectoryHandle | null> {
        const database = await this.database();
        const transaction = database.transaction(STORE_NAME, "readonly");
        const result = await requestResult(
            transaction.objectStore(STORE_NAME).get(DIRECTORY_KEY),
        );
        return (result as DeviceAudioDirectoryHandle | undefined) ?? null;
    }

    async save(handle: DeviceAudioDirectoryHandle): Promise<void> {
        const database = await this.database();
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(handle, DIRECTORY_KEY);
        await transactionDone(transaction);
    }
}

/** Persist the selected directory handle without coupling the vault to IDB. */
export function createIndexedDbDeviceAudioDirectoryRegistry(): DeviceAudioDirectoryRegistry {
    return new IndexedDbDeviceAudioDirectoryRegistry();
}
