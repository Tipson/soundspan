import type { PersonalizedHomeMood } from "./types";

export interface TimeOfDayMix {
    key: "night" | "morning" | "daytime" | "evening";
    title: string;
    description: string;
    mood: PersonalizedHomeMood;
}

/** Selects a listening context from the listener's local hour. */
export function timeOfDayMixForHour(hour: number): TimeOfDayMix {
    if (hour < 5) {
        return {
            key: "night",
            title: "Тихая ночь",
            description: "Спокойная музыка после полуночи",
            mood: "calm",
        };
    }
    if (hour < 12) {
        return {
            key: "morning",
            title: "Утренний ритм",
            description: "Музыка, с которой приятно начать день",
            mood: "energetic",
        };
    }
    if (hour < 18) {
        return {
            key: "daytime",
            title: "Дневной фокус",
            description: "Музыка для дел и сосредоточенности",
            mood: "focus",
        };
    }
    return {
        key: "evening",
        title: "Тихий вечер",
        description: "Спокойная музыка к концу дня",
        mood: "calm",
    };
}
