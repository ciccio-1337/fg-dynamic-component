# Security Review Remediation — Round 2

**Date:** 2026-11-17
**Scope:** full-repository security review at `HEAD 8c56335` (clean working tree).
**Goal:** close the six confirmed findings without removing the documented
expression, attribute and form features, and add regression coverage for each.
**Status:** implemented on 2026-11-19 (113 tests + build green).

## Findings to fix

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| S-1 | High | `$vm` arrow-parameter shadowing bypasses the "custom functions cannot be called" policy (`(($vm) => $vm())($vm.fns.at(0))`) | Reject arrow parameters named `$vm`/`$event`/`$ev` at parse time and require the direct-call fast path to resolve to the genuine root `$vm` binding. |
| S-2 | Medium | `expressionPolicy.allowedMethods` matches by name only, so the same method name becomes callable on every reachable object (`$vm.store.set(...)` with `allowedMethods: ['set']`) | Scope allowlist entries to the root `$vm` capability by default; support explicit `{ name, receiver: 'any' }` and `{ name, on: object }` descriptors. |
| S-3 | Medium | Coercion guard checks only the receiver/elements and only `toString`/`valueOf`; `Symbol.toPrimitive` and call arguments are unguarded (`$vm.items.join($vm.sep)`, `$vm.s.padStart(10, $vm.o)`) | Validate `Symbol.toPrimitive` and `Symbol.isConcatSpreadable`, and validate every object argument passed to a native built-in. |
| S-4 | Medium | Default attribute policy allows `href`/`src` to arbitrary `https` origins, enabling silent view-model exfiltration from untrusted configurations | Allow relative/same-origin URLs and `mailto:`/`tel:` by default; require `attributePolicy.allowExternalUrls: true` for cross-origin and protocol-relative URLs. |
| S-5 | Low | `Symbol.toStringTag` getters execute during host-object detection | Read the tag from property descriptors (own + inherited) and treat accessor tags as host objects instead of calling `Object.prototype.toString`. |
| S-6 | Low | Publish job exposes the npm token to `npm publish` lifecycle hooks from build output | Switch to OIDC trusted publishing only, remove `NODE_AUTH_TOKEN`, publish with `--ignore-scripts`. |

## Implementation notes

### S-1 / S-2 (`safe-expression.ts`)

- New `FGDynamicAllowedMethod` descriptor: `{ name, receiver?: 'root' | 'any', on?: object }`.
  String entries keep working but are **root-scoped** (the `$vm` wrapper or the value it returns).
- `EvaluationState` gains the root `$vm` binding and a lazy cache of its resolved value.
- `readMember()` and the call path take the evaluation state so the receiver can be checked
  before a custom method is released.
- Coercion guards keep using name-only matching: an explicitly allowed coercion hook is an
  intentional host opt-in, independent of receiver scoping.
- Arrow parameters named `$vm`, `$event` or `$ev` are rejected while parsing.

### S-3 (`safe-expression.ts`)

- `assertSafeCoercionValue()` additionally inspects `Symbol.toPrimitive` and
  `Symbol.isConcatSpreadable` descriptors; accessor or custom-function hooks fail.
- `assertSafeCoercion()` validates every argument of a native call, not only the receiver.

### S-4 (`fg-dynamic.component.ts`)

- `IFGDynamicAttributePolicy.allowExternalUrls?: boolean` (default `false`).
- `isSafeUrl()` rejects protocol-relative URLs and cross-origin `http(s)` URLs unless the
  policy opts in; relative URLs, fragments, `mailto:` and `tel:` stay allowed.
- SSR-safe: without `document`, absolute external URLs are refused unless opted in.

### S-5 (`safe-expression.ts`)

- `isHostObject()` reads `Symbol.toStringTag` via `findPropertyDescriptor()`; an accessor or
  non-string tag is treated as a host object. `Object.prototype.toString` is only used when
  no tag descriptor exists anywhere in the prototype chain (no getter can run in that case).

### S-6 (`.github/workflows/publish.yml`)

- Remove the `NODE_AUTH_TOKEN` fallback and rely on npm trusted publishing (OIDC)
  with `--provenance --ignore-scripts`.
- Drop `registry-url` from `actions/setup-node`: it exports a placeholder
  `NODE_AUTH_TOKEN` (`XXXXX-XXXXX-XXXXX-XXXXX`) that makes npm skip OIDC and fail
  with a 404. The publish step fails fast if a token is present.
- Prerequisite: authorize repo `ciccio-1337/fg-dynamic-component`, workflow
  `publish.yml` and environment `npm-publish` on npmjs.com.

## Regression tests

- `safe-expression.spec.ts`
  - shadowed `$vm` parameter (direct and nested arrows) is rejected;
  - allowed method on the root view model succeeds, on nested objects fails unless
    `receiver: 'any'` / `on` opts in;
  - `join` separator, `replace`/`padStart` arguments and `Symbol.toPrimitive` elements fail
    without invoking the hooks;
  - `Symbol.toStringTag` getter is never invoked.
- `fg-dynamic.component.spec.ts`
  - cross-origin `href`/`src` and protocol-relative URLs are blocked by default;
  - `allowExternalUrls: true` restores cross-origin URLs;
  - relative URLs remain allowed.

## Acceptance

- `npm run build` passes.
- `npm run test -- --no-watch` passes.
- No new public export; only additive policy option (`allowExternalUrls`) and widened
  `allowedMethods` entry type.
