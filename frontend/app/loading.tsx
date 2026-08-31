import { SystemState } from "@/app/_components/SystemState";

/**
 * Renders the Loading component.
 */
export default function Loading() {
    return (
        <SystemState
            kind="loading"
            title="Загружаем Soundspan"
            description="Готовим музыку, обложки и ваши настройки."
        />
    );
}
