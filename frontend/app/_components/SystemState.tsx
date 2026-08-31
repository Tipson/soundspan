import { CircleAlert, Compass, LoaderCircle } from "lucide-react";
import { AuthPanel, AuthStage } from "@/features/auth/components/AuthStage";

type SystemStateKind = "loading" | "error" | "not-found";

interface SystemStateAction {
    label: string;
    href?: string;
    onClick?: () => void;
}

interface SystemStateProps {
    kind: SystemStateKind;
    title: string;
    description: string;
    action?: SystemStateAction;
}

const actionClassName =
    "inline-flex min-h-11 items-center justify-center rounded-full bg-brand px-5 py-2.5 text-sm font-black text-black transition-[transform,background-color] active:scale-[0.98] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised motion-reduce:transition-none";

/** Unified Russian loading, error, and not-found presentation. */
export function SystemState({
    kind,
    title,
    description,
    action,
}: SystemStateProps) {
    const Icon =
        kind === "loading"
            ? LoaderCircle
            : kind === "not-found"
              ? Compass
              : CircleAlert;
    const role =
        kind === "loading" ? "status" : kind === "error" ? "alert" : "region";

    return (
        <AuthStage footer={false}>
            <AuthPanel className="text-center">
                <div
                    data-system-state={kind}
                    role={role}
                    aria-live={kind === "loading" ? "polite" : undefined}
                    className="mx-auto flex max-w-sm flex-col items-center py-5 sm:py-7"
                >
                    <span className="grid h-14 w-14 place-items-center rounded-2xl border border-brand/20 bg-brand/10 text-brand-light">
                        <Icon
                            className={`h-6 w-6 ${
                                kind === "loading"
                                    ? "animate-spin motion-reduce:animate-none"
                                    : ""
                            }`}
                            aria-hidden="true"
                        />
                    </span>
                    <p className="mt-5 text-[0.68rem] font-bold uppercase tracking-[0.18em] text-brand-light">
                        {kind === "loading"
                            ? "Soundspan готовится"
                            : kind === "not-found"
                              ? "Страница не найдена"
                              : "Нужна ваша помощь"}
                    </p>
                    <h1 className="mt-2 text-2xl font-black tracking-[-0.035em] text-content sm:text-3xl">
                        {title}
                    </h1>
                    <p className="mt-3 text-sm leading-6 text-content-secondary">
                        {description}
                    </p>
                    {action && (
                        <div className="mt-6">
                            {action.href ? (
                                <a
                                    href={action.href}
                                    className={actionClassName}
                                >
                                    {action.label}
                                </a>
                            ) : (
                                <button
                                    type="button"
                                    onClick={action.onClick}
                                    className={actionClassName}
                                >
                                    {action.label}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </AuthPanel>
        </AuthStage>
    );
}
