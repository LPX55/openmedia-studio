# components/ui/

## Responsibility

Design-system primitives: shadcn/ui-style wrappers over **`@base-ui/react`** (not Radix), a few bespoke presentation components (animated backgrounds, text effects), and the consolidated provider/model brand icons. Consumed by the rest of `components/` and `app/` — this folder never imports app logic or stores.

**Primitives (cva/named exports)**: `button` (`Button`, `buttonVariants`), `input`, `tooltip` (`Tooltip*`), `sheet` (`Sheet*` dialogs), `separator`, `skeleton`, `kbd` (`Kbd`, `KbdGroup`), `avatar` (`Avatar`, `AvatarImage`, `AvatarFallback`, `AvatarBadge`, `AvatarGroup`, `AvatarGroupCount`), `dropdown-menu` (`DropdownMenu*`), `sidebar` (`Sidebar*` + `SIDEBAR_*` constants, cookie/mobile-breakpoint logic).

**Icons**: `ProviderIcon.tsx` — two pure-JSX exports:
- `ProviderBrandIcon({ id, size })` — backend mark for the provider pill/toggle. Handles `kie` (teal "K" wordmark), `codex` (OpenAI knot SVG), `azure` (Azure SVG), `openrouter` (neutral "OR" wordmark), `pollinations` (neutral "POL" wordmark); any other id renders `null` (label fallback comes from `providerMeta()` in `lib/providers.ts`).
- `NodeProviderIcon({ provider, size, className })` — model-brand mark for model rows: `OpenAI`, `Google`, `Seedream`, `Z-AI`, `X`, `Kling`, `Bytedance`, `Alibaba`, `MiniMax`; unknown providers render `null`.

**Presentation / decorative**: `DotCanvasBackground` (default export, animated dot canvas), `TypewriterHeading` (character-by-character reveal with `onDone`). `WorkflowDotBackground` and `blur-in-text.tsx` (`BlurInText`) remain but currently have **no importers** — legacy presentation, keep out of new work.

## Design

- **React patterns**: pure presentational components with no store access; props-driven, `forwardRef`-style composition where shadcn conventions expect it; `sidebar.tsx` is the largest primitive (cookie-persisted collapsed state, `use-mobile` hook, keyboard shortcut). `TypewriterHeading` uses local `useState` + `setInterval` for the reveal animation.
- **shadcn/ui conventions**: file-per-component, `cva` variant maps (`buttonVariants`), `cn()` from `lib/utils` (clsx + tailwind-merge) for class merging, shadcn export names — but the underlying headless library is `@base-ui/react/*` (`button`, `dialog`, `input`, `menu`, `tooltip`, `avatar`, `separator`, `merge-props`, `use-render`).
- **ProviderIcon design**: one file replaced four near-duplicate copies that lived in `SettingsModal.tsx`, `GenerateNode.tsx`, `VideoGeneratorNode.tsx`, and `app/gallery/page.tsx`. It is client-safe: pure JSX, no store, no server imports — the only `lib/` reference is a **type-only** `ProviderId` import (erased at build). Brand policy: real SVG paths where the repo has them (azure, codex, model brands); neutral text wordmarks ("K", "OR", "POL") where no asset exists, deliberately off the teal accent so third-party backends read as neutral. `size` drives both the box and a proportional font size; `NodeProviderIcon` accepts a `className` color override (default `text-[#2DD4BF]`).
- **Motion**: `motion/react` for `BlurInText`; raw canvas/CSS for the dot backgrounds; `lucide-react` for the few embedded icons.
- **Styling**: this is the only folder using Tailwind classes (plus `clsx`); app components outside use inline `style={{}}`. `ProviderIcon` mixes Tailwind color classes with inline sizing styles.
- **zustand / @xyflow**: none — intentionally decoupled; consumers wire these to stores themselves.

## Flow

- **Props → render**: variant props (`variant`, `size`, `side`, `align`, …) → `cva`/Base UI props → merged via `cn()`/`merge-props` → DOM. `ProviderBrandIcon` branches on `id`, `NodeProviderIcon` on `provider`; both return `null` for unknown values so callers can fall back to a text label.
- **Events**: primitives are transparent — Base UI handles trigger/open/portal/selection internally and surfaces `onOpenChange`/`onClick`/form events to the caller; no app-level event logic here.
- **State**: `sidebar.tsx` owns transient UI state (open/collapsed, mobile breakpoint, cookie); `TypewriterHeading` owns its animation index. Everything else is stateless.
- **Animation flow**: `TypewriterHeading` ticks through `text` then fires `onDone`; `BlurInText` runs a `motion/react` entrance once on mount.

## Integration

- **Stores**: none — imports no `lib/store.ts` state (the only `lib/` imports are `cn` from `lib/utils` in 10 files and the type-only `ProviderId` in `ProviderIcon.tsx`), plus `hooks/use-mobile` in `sidebar.tsx`.
- **lib/**: `lib/utils` (`cn`); `clsx`; `hooks/use-mobile`; `@/lib/providers` (type only).
- **Internal composition**: `button` ← `dropdown-menu`/`sheet`/`sidebar`; `sidebar` wraps `sheet` (mobile drawer), `tooltip` (collapsed icon tooltips), and re-exports `SidebarInput`/`SidebarSeparator`/`SidebarMenuSkeleton` over the `input`/`separator`/`skeleton` primitives.
- **Consumed by**: `components/AppSidebar` (`ui/sidebar`, `ui/avatar`, `ui/dropdown-menu`); `app/layout.tsx` (`ui/sidebar`, `ui/tooltip`); `WorkflowDashboard`/`app/gallery`/`app/chat` (`ui/DotCanvasBackground`); `WorkflowCanvas`/`app/chat` (`ui/TypewriterHeading`); `app/gallery` (`ui/button`, `ui/kbd`, `ui/sidebar`); `SettingsModal`, `GenerateNode`, `VideoGeneratorNode`, `app/gallery` (`ui/ProviderIcon`). `input`, `sheet`, `separator`, `skeleton` are currently composed only inside this folder (`sheet`/`sidebar`) — exported but not imported by app code.
- **External**: `@base-ui/react/*`, `class-variance-authority`, `clsx`, `motion/react`, `lucide-react`.
