import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Search } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Modal, type ModalProps } from "../../components/ui/Modal";
import { EmptyState } from "../../components/ui/EmptyState";
import { LoadingScreen } from "../../components/ui/LoadingScreen";
import { PageHeader } from "../../components/layout/PageHeader";
import {
    CarouselItem,
    HorizontalCarousel,
} from "../../components/ui/HorizontalCarousel";
import { PagedGridCarousel } from "../../components/ui/PagedGridCarousel";

const TestModal = Modal as React.ComponentType<
    React.PropsWithChildren<Omit<ModalProps, "children">>
>;

test("Button uses a 44px touch target and the spectral-stage geometry", () => {
    const standard = renderToStaticMarkup(
        React.createElement(Button, { variant: "primary" }, "Продолжить"),
    );
    const icon = renderToStaticMarkup(
        React.createElement(Button, { variant: "icon", "aria-label": "Меню" }),
    );

    assert.match(standard, /min-h-11/);
    assert.match(standard, /rounded-xl/);
    assert.match(icon, /size-11/);
});

test("Card uses one calm shared radius instead of legacy small geometry", () => {
    const html = renderToStaticMarkup(
        React.createElement(Card, null, "Музыка"),
    );

    assert.match(html, /rounded-2xl/);
    assert.doesNotMatch(html, /rounded-md/);
});

test("Modal becomes a bottom sheet on phones and a centered dialog above them", () => {
    const html = renderToStaticMarkup(
        React.createElement(
            TestModal,
            {
                isOpen: true,
                onClose: () => undefined,
                title: "Настройки",
            },
            "Содержимое",
        ),
    );

    assert.match(html, /items-end/);
    assert.match(html, /sm:items-center/);
    assert.match(html, /rounded-t-\[24px\]/);
    assert.match(html, /max-h-\[min\(90dvh,760px\)\]/);
});

test("PageHeader uses an open editorial hierarchy and responsive action dock", () => {
    const html = renderToStaticMarkup(
        React.createElement(PageHeader, {
            title: "Коллекция",
            subtitle: "Ваша музыка",
            icon: Search,
            actions: React.createElement("button", null, "Действие"),
        }),
    );

    assert.match(html, /data-page-header="editorial"/);
    assert.match(html, /text-content/);
    assert.match(html, /w-full.*sm:w-auto/);
});

test("Empty and loading states use semantic copy and the shared canvas", () => {
    const empty = renderToStaticMarkup(
        React.createElement(EmptyState, {
            icon: React.createElement("span", null, "icon"),
            title: "Пока пусто",
            description: "Здесь появится музыка",
        }),
    );
    const loading = renderToStaticMarkup(React.createElement(LoadingScreen));

    assert.match(empty, /text-content-muted/);
    assert.match(loading, /Загрузка…/);
    assert.match(loading, /bg-surface/);
});

test("Shared rails hide system scrollbars and use semantic touch-sized controls", () => {
    const rail = renderToStaticMarkup(
        React.createElement(
            HorizontalCarousel,
            null,
            React.createElement(CarouselItem, null, "Альбом"),
        ),
    );
    const pages = renderToStaticMarkup(
        React.createElement(PagedGridCarousel<string>, {
            items: ["one", "two"],
            itemsPerPage: 1,
            columns: 1,
            rows: 1,
            keyExtractor: (item: string) => item,
            renderItem: (item: string) => item,
        }),
    );

    assert.match(rail, /scrollbar-hide/);
    assert.doesNotMatch(rail, /transition-all/);
    assert.match(pages, /scrollbar-hide/);
    assert.match(pages, /size-11/);
    assert.match(pages, /bg-surface-overlay/);
    assert.doesNotMatch(pages, /transition-all/);
});
