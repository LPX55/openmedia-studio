# components/ui/

## Responsibility

Design-system primitives: shadcn/ui-style wrappers over **`@base-ui/react`** (not Radix) plus a few bespoke presentation components (animated backgrounds, text effects). Consumed by the rest of `components/` — this folder never imports app logic or stores.

**Primitives (cva/named exports)**: `button` (`Button`, `buttonVariants`), `input`, `tooltip` (`Tooltip*`), `sheet` (`Sheet*` dialogs), `separator`, `skeleton`, `kbd` (`Kbd`, `KbdGroup`), `avatar` (`Avatar`, `AvatarImage`, `AvatarFallback`, `AvatarBadge`, `AvatarGroup`, `AvatarGroupCount`), `dropdown-menu` (`DropdownMenu*`), `sidebar` (`Sidebar*` + `SIDEBAR_*` constants, cookie/mobile-breakpoint logic).

**Presentation / decorative**: `DotCanvasBackground` (default export, animated dot canvas), `WorkflowDotBackground`, `TypewriterHeading` (character-by-character reveal with `onDone`), `BlurInText` (motion blur-in).

## Design

- **React patterns**: pure presentational components with no store access; props-driven, `forwardRef`-style composition where shadcn conventions expect it; `sidebar.tsx` is the largest primitive (cookie-persisted collapsed state, `use-mobile` hook, keyboard shortcut). `TypewriterHeading` uses local `useState` + `setInterval` for the reveal animation.
- **shadcn/ui conventions**: file-per-component, `cva` variant maps (`buttonVariants`), `cn()` from `lib/utils` (clsx + tailwind-merge) for class merging, shadcn export names — but the underlying headless library is `@base-ui/react/*` (`button`, `dialog`, `input`, `menu`, `tooltip`, `avatar`, `separator`, `merge-props`, `use-render`).
- **Motion**: `motion/react` for `BlurInText`; raw canvas/CSS for the dot backgrounds; `lucide-react` for the few embedded icons.
- **Styling**: this is the only folder using Tailwind classes (plus `clsx`); app components outside use inline `style={{}}`.
- **zustand / @xyflow**: none — intentionally decoupled; consumers wire these to stores themselves.

## Flow

- **Props → render**: variant props (`variant`, `size`, `side`, `align`, …) → `cva`/Base UI props → merged via `cn()`/`merge-props` → DOM.
- **Events**: primitives are transparent — Base UI handles trigger/open/portal/selection internally and surfaces `onOpenChange`/`onClick`/form events to the caller; no app-level event logic here.
- **State**: `sidebar.tsx` owns transient UI state (open/collapsed, mobile breakpoint, cookie); `TypewriterHeading` owns its animation index. Everything else is stateless.
- **Animation flow**: `TypewriterHeading` ticks through `text` then fires `onDone`; `BlurInText` runs a `motion/react` entrance once on mount.

## Integration

- **Stores**: none — imports no `lib/store.ts` state (the only `lib/` import is `cn` from `lib/utils`, plus `hooks/use-mobile` in `sidebar.tsx`).
- **lib/**: `lib/utils` (`cn`) in 10 files; `clsx`; `hooks/use-mobile`.
- **Internal composition**: `button` ← `dropdown-menu`/`sheet`/`tooltip`; `tooltip`/`sheet`/`separator`/`input` re-exported by their composed files.
- **Consumed by**: `components/AppSidebar` (`ui/sidebar`, `ui/avatar`, `ui/dropdown-menu`), `WorkflowDashboard`/`WorkflowHero` (`ui/DotCanvasBackground`, `ui/TypewriterHeading`, `ui/button`), plus toolbars/modals/nodes for `Button`, `Tooltip`, `Sheet`, `Input`, `Kbd`, `Skeleton`.
- **External**: `@base-ui/react/*`, `class-variance-authority`, `clsx`, `motion/react`, `lucide-react`.
