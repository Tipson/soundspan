/** Expected seed validation/lookup failure, independent of HTTP transport and providers. */
export class LibrarySeedRadioError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "LibrarySeedRadioError";
    }
}
