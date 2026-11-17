# Code Review Remediation — Round 2

**Date:** 2026-11-17
**Scope:** Full-repository review at `HEAD e3868fe` (working tree was clean).
**Goal:** Implement every confirmed finding from the review and add regression coverage.

## High

1. **FormGroup validity/status propagation** (`fg-dynamic.component.ts`)
   `setControlDisabled()` and `setFormControlValidators()` update the control with
   `onlySelf: true`, so the parent `FormGroup` keeps a stale `valid`/`status`.
   Remove `onlySelf` from those updates so ancestors recompute.

2. **Destroy during an async `ngOnChanges`** (`fg-dynamic.component.ts`)
   Add a destroyed flag and invalidate the change generation in `ngOnDestroy()`.
   Re-check it after every `await` (and in `clearResolvedComponent`) so a pending
   loader cannot create/re-create components or subscriptions on a dead view.

## Medium

3. **One invalid child aborting the whole tree** (`fg-dynamic.component.ts`)
   `collectConfigurationStats()` returns `null` for any non-object child. Skip
   invalid nested entries instead (still reject an invalid root, cycles, oversized
   maps and non-array `items`) so behaviour matches the documented "invalid entries
   are ignored".

4. **Managed validators leaking on reused controls** (`fg-dynamic.component.ts`)
   `cleanup()` clears `_managedValidatorFns` without removing the validators from a
   control it does not own. Remove them and recompute validity during cleanup.

5. **Optional chaining does not short-circuit across links**
   (`safe-expression.ts`) Introduce a short-circuit sentinel that propagates through
   the remaining `Member`/`Call` links and is normalized to `undefined` at expression
   boundaries, matching JavaScript `?.` semantics.

6. **No viewModel → control synchronization** (`fg-dynamic.component.ts`)
   Track the last value written by the control and, on view-model changes, write the
   new path value back to the control with `emitEvent: false` when it differs.

7. **Native callbacks/coercion bypass the method policy** (`safe-expression.ts`)
   Reject custom function arguments passed to callback-taking natives and custom
   `toString`/`valueOf`/`toLocaleString` hooks invoked by `join`/`toLocaleString`.

8. **Form-path reads execute getters** (`fg-dynamic.component.ts`)
   Read through property descriptors in `getModelPropertyValue`,
   `setModelPropertyValue` and the clone helper; never invoke accessors.

## Low

9. Re-evaluate `allowExistingControls` when it changes and the wiring is active.
10. Remove empty intermediate groups immediately when form wiring fails.
11. Replace the `$ev` substring heuristic with a word-boundary identifier match
    (keeps the `$ev` alias, avoids matching literal text).
12. Surface a clear warning when no `ControlValueAccessor` is found; keep the
    internal `FormControlDirective` usage documented.
13. Reduce hot-path work: path-limited cloning instead of a full view-model clone on
    every control change, and share structural validation between `ngOnChanges` and
    `items()` through a cached computed instead of validating twice.
14. Fix stale comments/docs (`CLAUDE.md`, component comment) about invalid entries.
15. Document `allowFunctionTypes: true` in the README promise/loader examples
    (both README copies).
16. Exclude `.env.example`/`.env.sample`/`.env.template` from the secret-file guard
    using a portable ERE allowlist (no grep lookahead).
17. Add `set -euo pipefail` to `update_outdated_packages.command`.

## Tests

Regression coverage for all of the above:

- safe-expression: multi-link optional chains, optional calls, JS-correct mixed
  chains, string amplification, callback/coercion policy.
- component: FormGroup validity/status (required + disabled), reused-control validator
  cleanup, viewModel → control sync, destroy with pending loader, mixed valid/invalid
  child items, policy re-evaluation, accessor-safe path reads.
- test quality: replace conditional assertions and fixed `setTimeout` waits in the
  existing attribute/promise tests.

## Verification

- `npx tsc -p projects/fg-dynamic-component/tsconfig.lib.json --noEmit` — passes.
- `npx tsc -p projects/fg-dynamic-component/tsconfig.spec.json --noEmit` — passes.
- `npm test -- --no-watch` — 103 tests pass (82 component + 21 expression).
- `npm run build` — ng-packagr partial compilation succeeds.
- `bash -n` on both shell scripts — syntax OK; secret guard checked against
  `.env.example`/`.env.sample`/`.env.template` and real `.env*` names.
