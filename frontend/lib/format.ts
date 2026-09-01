/**
 * Format large numbers into compact notation (e.g., 5,100,000 → "5.1M")
 */
export function formatListeners(count: number | undefined): string {
    if (!count || count === 0) return "Исполнитель";

    if (count >= 1000000) {
        return `${(count / 1000000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн слушателей`;
    }

    if (count >= 1000) {
        return `${(count / 1000).toLocaleString("ru-RU", { maximumFractionDigits: count >= 10000 ? 0 : 1 })} тыс. слушателей`;
    }

    const lastTwo = count % 100;
    const last = count % 10;
    const noun =
        lastTwo >= 11 && lastTwo <= 14
            ? "слушателей"
            : last === 1
              ? "слушатель"
              : last >= 2 && last <= 4
                ? "слушателя"
                : "слушателей";
    return `${count.toLocaleString("ru-RU")} ${noun}`;
}
