export interface TimeOfDayMix {
    key: "night" | "morning" | "daytime" | "evening";
    title: string;
    description: string;
}

/** Selects a listening context from the listener's local hour. */
export function timeOfDayMixForHour(hour: number): TimeOfDayMix {
    if (hour < 6) {
        return {
            key: "night",
            title: "Ваша ночь",
            description: "Музыка для вашего времени после полуночи",
        };
    }
    if (hour < 12) {
        return {
            key: "morning",
            title: "Ваше утро",
            description: "Музыка для вашего утра",
        };
    }
    if (hour < 18) {
        return {
            key: "daytime",
            title: "Ваш день",
            description: "Музыка для вашего дня",
        };
    }
    return {
        key: "evening",
        title: "Ваш вечер",
        description: "Музыка для вашего вечера",
    };
}
