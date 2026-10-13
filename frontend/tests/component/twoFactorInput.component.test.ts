import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

test("second-factor input normalizes formatted pasted codes and clears on mode change", async () => {
    const { createRoot } = await import("react-dom/client");
    const { TwoFactorInput } =
        await import("../../features/auth/components/TwoFactorInput");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Form() {
        const [value, setValue] = React.useState("");
        const [recovery, setRecovery] = React.useState(false);
        return React.createElement(TwoFactorInput, {
            id: "test-code",
            value,
            useRecoveryCode: recovery,
            onValueChange: setValue,
            onRecoveryCodeChange: setRecovery,
        });
    }
    const paste = async (text: string) => {
        const input = container.querySelector("input")!;
        await React.act(async () => {
            Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
            )!.set!.call(input, text);
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        return container.querySelector("input")!.value;
    };
    try {
        await React.act(async () => root.render(React.createElement(Form)));
        assert.equal(await paste("123 456"), "123456");
        assert.equal(await paste("123456789"), "123456");
        await React.act(async () => container.querySelector("button")!.click());
        assert.equal(container.querySelector("input")!.value, "");
        assert.equal(await paste("ab-cd1234"), "ABCD1234");
        assert.equal(await paste("ABCD1234FFFF"), "ABCD1234");
        assert.equal(container.querySelector("input")!.inputMode, "text");
        await React.act(async () => container.querySelector("button")!.click());
        assert.equal(container.querySelector("input")!.value, "");
        assert.equal(container.querySelector("input")!.inputMode, "numeric");
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});
