# AGENTS.md

Read this file first, then the nearest module `AGENTS.md` and any relevant [`docs/`](docs/) before editing. It captures only project-specific, non-obvious guidance — standard React/TypeScript best practices still apply.

## Project Overview

A single **Vite + React 18 + TypeScript (strict)** monolith (`lume-trader-ui`) that ships many branded LumeTrader trading/admin apps (spreader, rfq, admin, fmx, passkey, ltfx, treasury, curvature, ...) from one codebase.

An "app" is **not** a separate build or entry point — it is selected at runtime:

- Vite `--mode` → a matching `.env.{app}.{env}` file
- `VITE_SUPPORTED_APPLICATIONS` → `window.SUPPORTED_APPLICATIONS` → `supportedApplications` in [src/env.ts](src/env.ts)
- [src/panel-loader.ts](src/panel-loader.ts) lazy-loads only the `*.panel.tsx` files whose `application` matches.

## Tech Stack

- **Build**: Vite 8 (not Next.js, not Webpack/CRA)
- **UI**: React 18 + TypeScript (strict, `noUncheckedIndexedAccess`)
- **Design system**: `@lume/prism` (Panel, styled, zustandSync, Logger, toast, MessageBus, layout) — use it before hand-rolling UI
- **State**: Zustand + `zustandSync` + immer (no Redux/Redux Toolkit)
- **Wire format**: `@lume/protobuf` (protobuf + JSON over WebSocket)
- **Validation**: yup (not Zod)
- **Styling**: Prism `styled()` (preferred); SCSS modules + `clsx` in legacy code, being phased out (no Tailwind/Shadcn/Radix)
- **Money/number math**: `big.js`; dates `date-fns` (twap/time: `luxon`)
- **Lint/format**: Biome (not ESLint/Prettier). **Typecheck**: `tsgo` (not `tsc`). **Tests**: Vitest + Testing Library; E2E Playwright + Cucumber
- **Desktop**: Electron (`electron/`)

## Project Structure

```
src/
├── modules/       # Product UI, grouped by domain (trader, rfq, admin, passkey, fmx, settings, bootstrap, common, ...)
├── api/           # WebSocket client + inbound routing + outbound vertexMessage builders
├── hooks/         # Cross-cutting Zustand stores + React hooks
├── business/      # Pure domain logic (no React / no IO)
├── utils/         # Shared transforms/helpers
├── types/         # Shared TypeScript contracts
├── main.tsx       # Entry: guard stack + panel preload
├── panel-loader.ts, panel-ids.ts, panels.metadata.json   # Panel registry (panel-ids.ts + metadata are CODEGEN)
└── env.ts         # Runtime config from window.*
```

Guiding rule: put logic in the **most specific** place — don't bloat `src/modules/common` or `src/utils` with feature-specific code. (Import aliases and file/naming conventions: see "Conventions" below.)

## Build, Run & Verify

```bash
# Run a dev app (mode-based)
npm run dev:spreader      # or dev:rfq, dev:admin, dev:fmx, dev:passkey, dev:ltfx ...
npm run dev:spreader:electron

# Verify before declaring work done
npm run lint             # Biome (formatter + linter); lint:fix / lint:changed to scope
npm run typecheck        # tsgo --noEmit — NOT tsc
npm run test             # Vitest; uses --passWithNoTests, so confirm tests actually ran
npm run madge:circular   # detect circular imports
```

Git hooks enforce a baseline: pre-commit = Biome on staged files + lockfile validation + shellcheck; commit-msg = commitlint; pre-push = `typecheck-changed`. `typecheck:changed` ignores pre-existing errors outside your diff, so run full `npm run typecheck` for risky refactors.

## Architecture

### Panel system
Panels are the composable unit of UI — `*.panel.tsx` modules registered with `@lume/prism` `Panel()` / `PanelAlt()`, lazy-loaded by [src/panel-loader.ts](src/panel-loader.ts) for the current app. How to add/change a panel (codegen, `application`, entitlements): [`.cursor/rules/panels.mdc`](.cursor/rules/panels.mdc).

### Bootstrap
[src/main.tsx](src/main.tsx) renders a guard stack in [src/modules/bootstrap/guards](src/modules/bootstrap/guards): `AuthGuard` (OAuth/PKCE) → `PopupGuard` → `SocketGuard` (WebSocket connect + message handlers) → `ProfileGuard` → `App`.

## State Management

Global state is **Zustand**, always wrapped in **`zustandSync()`** (from `@lume/prism`) for cross-window/Electron sync. **No Redux/Redux Toolkit.**

**Authoring a store**
- `create()` (or `createWithEqualityFn` from `zustand/traditional`) wrapped in `zustandSync(initializer, 'uniqueName')`.
- Nested updates via `immer` middleware or standalone `produce`. Larger stores expose an `actions` sub-object with the `State` type kept separate.
- Normalize collections into keyed maps (`Record<id, T>`); one store per domain — avoid all-in-one stores.

```tsx
// immer middleware + `actions` sub-object + normalized map
// Ref: src/modules/rfq/features/middleOffice/useMiddleOfficeState.ts
export const useMiddleOfficeState = create(
  zustandSync(
    immer<State>((set) => ({
      navigationTab: undefined,
      subscriptions: {} as Record<TabKey, { loading: boolean }>,
      actions: {
        navigateTo: (tab) => set({ navigationTab: tab }),
        loadingComplete: (tab) =>
          set((state) => {
            const sub = state.subscriptions[tab]; // "mutate" the immer draft
            if (sub) sub.loading = false;
          }),
      },
    })),
    'useMiddleOfficeState', // unique zustandSync name
  ),
);

export const getSubscriptions = (s: State) => s.subscriptions; // selectors live by the store
```

**Consuming a store (React components)**
- Subscribe with a selector: `useStore(selector)`. Use `useShallow` (default) for object/tuple selects, `useDeep` ([src/hooks/use-deep-selector.ts](src/hooks/use-deep-selector.ts)) for nested/array values.
- In non-React code (message handlers, utilities) read/write via `useStore.getState()` — never call hooks there.
- Export reusable `getX(state)` selectors from the store file.

```tsx
// ✅ Component: subscribe with a selector
const active = useTraderState(getTraderStatus);
const subs = useMiddleOfficeState(useShallow((s) => s.subscriptions));

// ✅ Non-React / message handler: imperative getState()
useTraderState.getState().setTraderState(true);

// ❌ Don't select the whole store in a component (re-renders on every change)
const store = useTraderState();
```

## Messaging (WebSocket)

Most global state is **server-driven**: inbound socket messages update Zustand stores; the UI sends changes as `vertexMessage` builders in `src/api/*`. Cross-module coordination uses shared stores (primary), plus `MessageBus` (UI events), `MarketDataService` (live prices), and `document` CustomEvents (`socket:connected` / `socket:disconnected`).

The socket-layer conventions (inbound routing + typed handler maps, `vertexMessage` shape, protobuf validation, audit `changes` map) live in [`.cursor/rules/state-and-messaging.mdc`](.cursor/rules/state-and-messaging.mdc), which auto-loads when you edit `src/api` / `src/hooks` / message-handler files.

## Engineering principles

Tie-breakers for judgment calls (mechanical style/lint is already enforced by Biome and covered under "Conventions" below, so it's not repeated here):

- **Simplest thing that works.** Prefer the obvious approach over premature cleverness, abstraction, or optimization; justify complexity with evidence and profile before optimizing. Exception: known hot paths (streaming market data, large blotters/grids) warrant reasonable care up front.
- **Clear beats clever.** If a competent peer would pause reading it, rewrite — or hide the trick behind a well-named function.
- **Do one thing well.** Small, composable units; `parseX()` parses, it doesn't also validate and log.
- **Inline until reuse is real.** Extract on the *second* genuine caller, not the first imagined one.
- **Length follows the work.** Don't fragment coherent top-to-bottom logic just to hit a line count; don't let unrelated concerns pile into one function/file either.
- **Flat over nested** — call stacks, data shapes, and folder trees.
- **Names carry meaning.** `orders.filter(isWorking)` beats an inline boolean soup; the call site should read as intent.
- **Build for the case in front of you.** No speculative flexibility, config knobs, or plugin systems "for later."
- **A little copying beats a small dependency.** Don't add a package for <~100 lines you can write clearly; prefer existing deps (`big.js`, `date-fns`, Prism) over new ones.
- **Composition over inheritance** — wrap, don't extend, unless it's genuinely "is-a."
- **Tests enable fearless change.** Cover edge cases and branches, skip trivial asserts; keep tests scoped while iterating, run the full suite before done.

## Conventions (repo-specific)

### Linting (Biome)
Only the rules Biome flags but can't auto-fix (so write them correctly up front); pure formatting is auto-applied.
- Avoid `any` — `noExplicitAny` is an error; write a precise type.
- Use Prism `Logger`, not `console` — `src/**` allows only `console.error` / `console.count`.
- Suppress a rule only with a reasoned `// biome-ignore <rule>: reason`.

### Imports & path aliases
- Prefer `~` aliases over deep relative paths: `~api`, `~hooks`, `~utils`, `~types`, `~common`, `~modules/*`, `~modules-trader/*`, `~modules-rfq/*`, `~business/*`, `~env`. Barrels are rare — import direct file paths.

### Components
- Functional, arrow-function, **named exports** (default export only for entry points / Storybook).
- Props via inline type or `export type XxxProps`.

### Files & naming
- **Files/folders**: kebab-case dominant.
- **Suffixes**: `*.panel.tsx`, `*.types.ts`, `*.test.ts(x)`, `style/styled-*.ts`, `use-*.ts`, `column-defs.tsx`, `constants/*.ts`, `messageHandlers.ts` / `*-message-handlers.ts`.
- **Identifiers**:
  - `handle*` for event handlers, `is/has/can*` for booleans, `use*` for hooks.
  - PascalCase for components/types, camelCase for variables/functions/props.
  - `UPPER_SNAKE` for constants and env vars.

### Libraries
- Prefer an existing dep before adding a new one:
  - `lodash`, `date-fns` (dates) / `luxon` (twap/time), `big.js` (money/ticks — no float math), `immer`, `yup`, `dequal`, `nanoid`, `fast-sort`.
  - UI/state helpers from `@lume/prism`; wire types from `@lume/protobuf`.

### Comments
- Explain *why/how* a block solves the problem; no numbered-step narration. See [docs/comment-style.md](docs/comment-style.md).

## UI & Styling

### Prism primitives
- Build from Prism primitives: `Button`, `IconButton`, `Input`, `FormField`, `Select`, `List` / `MenuItem`, `Modal` / `ModalContent`, `Tooltip`, `SegmentedButton`, `DateTimePicker`, price widgets (`PriceInput`, `PriceDisplay`), data-table types (`PrismTableProps`, `PrismDataTableCellProps`), and Prism icons (`AddIcon`, `EditIcon`, `DeleteIcon`, ...).
- This is a **trading app**: dense, information-first layouts — not mobile-first. Don't add responsive breakpoints or a mobile layer unless a panel actually needs it.

### Styling — prefer Prism `styled()`
- **Default for new code: Prism `styled()`** — stitches-style object styles in `style/styled-*.ts`, using `variants` for stateful styling.
- **SCSS modules + `clsx` are legacy** (still widespread, especially in `rfq`) and are being **phased out**. Don't add new `*.module.scss`; when editing an existing SCSS-styled component match its pattern, but prefer migrating to `styled()` when it's reasonable.

### Theming
Use Prism theme tokens — never hard-coded colors — so light/dark and per-brand themes work automatically. Don't build your own dark-mode toggle.
- In `styled()`: `hsla('$green')` / `$token` references.
- In legacy SCSS: CSS variables like `var(--colors-text)`, `var(--colors-buy)`, `var(--colors-sell)`, `var(--colors-tertiarySurface)`.

```ts
// Preferred — Prism styled() with variants (Ref: src/modules/admin/rules/style/styled-status-cell.ts)
import { hsla, styled } from '@lume/prism';

export const StyledStatusCell = styled(StatusCell, {
  variants: {
    highlight: {
      warning: { '&::before': { backgroundColor: hsla('$yellow') } },
      error: { '&::before': { backgroundColor: hsla('$red') } },
    },
  },
});
```

```tsx
// Legacy (don't add new) — SCSS module + clsx (Ref: src/modules/rfq/components/Chip.tsx)
import clsx from 'clsx';
import sx from './Chip.module.scss';

export const Chip = ({ variant, className, children }: ChipProps) => (
  <div
    className={clsx(
      sx.chip,
      { [sx.buy as string]: variant === 'buy', [sx.sell as string]: variant === 'sell' },
      className,
    )}
  >
    {children}
  </div>
);
```

## Testing

- **Unit (Vitest)**: name tests `*.test.ts(x)` co-located with source — **`*.spec.ts` is NOT picked up**. jsdom + `tests/setup-tests.tsx`. Mock with `vi.mock(...)` hoisted (`vi.hoisted()` for shared refs); drive stores via `useStore.setState(...)`. Full: [`.cursor/rules/testing.mdc`](.cursor/rules/testing.mdc).
- **E2E (Cucumber + Playwright)**: `npm run e2e` / `scripts/e2e-runner.mjs`; tag features `@backend:<name>`; use account leases in shared envs; Xray is read-only. See [docs/e2e.md](docs/e2e.md).

## Git & Commits

- Conventional format `type(LFE-####): summary` (types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test); breaking = `type(LFE-####)!:`. See [docs/git-commit.md](docs/git-commit.md).
- Bump `package.json` version only when changing `electron/` code ([docs/electron-versioning.md](docs/electron-versioning.md)).

## Common tasks

Multi-step recipes — the easy-to-forget steps are called out. Follow the linked rule for detail.

- **Add a panel**: follow [`.cursor/rules/panels.mdc`](.cursor/rules/panels.mdc) (create `*.panel.tsx`, check `VITE_SUPPORTED_APPLICATIONS`, regenerate metadata/ids).
- **Add an inbound message**: extend the `WSMessage` union / `AppMessageHandlers` types first, add a handler in the feature's `*-message-handlers.ts`, spread it into [src/api/root-message-handlers.ts](src/api/root-message-handlers.ts), and update the store via `useXStore.getState().update*()`.
- **Add an outbound message**: add a thin builder in `src/api/<domain>/*` that constructs a `vertexMessage` (correlation via `createCorrelationId()`) and calls `socket.send` / `socket.request`. For admin/passkey mutations, attach the `changes` audit map ([skill](.cursor/skills/audit-trail-websocket/SKILL.md)).
- **Add a store**: `create(zustandSync(immer(...), 'uniqueName'))` in `src/hooks/*` (cross-cutting) or the feature; expose `actions` + `getX` selectors (see "State Management").
- **Add a unit test**: co-locate `*.test.ts(x)` (**not** `.spec`), hoist mocks with `vi.mock`, drive stores via `useStore.setState`. See [`.cursor/rules/testing.mdc`](.cursor/rules/testing.mdc).

## Troubleshooting

- **Auth / OAuth loop**: server-side OAuth+PKCE via `useServerAuth`; check `authUrl` has no trailing slash (see README Authentication).
- **App shows no panels**: confirm `VITE_SUPPORTED_APPLICATIONS` matches the panel's `application`; regenerate metadata after adding/renaming a `*.panel.tsx`.
- **Socket disconnected screen**: [src/api/disconnected-screen.tsx](src/api/disconnected-screen.tsx); check `VITE_API_URL_WS` and `SocketGuard`.
- **Commit rejected**: message must match `type(LFE-####): summary`.
- **Pre-commit fails on lockfile**: run `npm install` to reconcile `package-lock.json`.

## Reference docs (`docs/`)

Not auto-loaded — read the one that matches the task:

- [comment-style](docs/comment-style.md) — comment conventions
- [git-commit](docs/git-commit.md) — commit format + Electron versioning rules
- [e2e](docs/e2e.md) · [e2e-leases](docs/e2e-leases.md) · [e2e-xray-map](docs/e2e-xray-map.md) — end-to-end testing, shared account leases, Xray→Cucumber mapping
- [electron-windows](docs/electron-windows.md) · [electron-versioning](docs/electron-versioning.md) — Electron window/WebContentsView details, SemVer for `electron/`
