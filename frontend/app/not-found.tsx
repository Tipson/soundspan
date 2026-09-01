import { SystemState } from "@/app/_components/SystemState";

/** Renders a recoverable Russian not-found route. */
export default function NotFound() {
    return (
        <SystemState
            kind="not-found"
            title="Здесь пока ничего нет"
            description="Возможно, ссылка устарела или страница была перемещена. Вернитесь на главную и продолжите слушать."
            action={{ label: "На главную", href: "/" }}
        />
    );
}
