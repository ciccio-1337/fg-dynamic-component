# Security Review Remediation — fg-dynamic-component

**Date:** 2026-11-07
**Status:** implemented on 2026-11-10 (tests + build green)
**Source review:** full-repository security review at `HEAD 8e80c81` (clean working tree)
**Goal:** close the remaining security gaps after the previous `eval` removal, without
losing the documented expression/form features.

## Findings to fix

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| C-1 | Critical | Expression interpreter escapes to browser APIs through reachable host objects (`$event.view`, `$event.target.ownerDocument.defaultView`) → localStorage/cookie theft, `fetch` exfiltration, DOM HTML/script injection | Reject host objects and host-object results in member access; block dangerous properties (`document`, `location`, `cookie`, `fetch`, `setTimeout`, `insertAdjacentHTML`, …); allow only native methods from a safe allowlist; block `call`/`apply`/`bind`; add DOM-event regression tests. |
| H-1 | High | Expressions can call arbitrary view-model methods and mutate state (`$vm.set`, `$vm.update`, `$vm().dangerous()`) | Make expressions read-only by default. Add `expressionPolicy`: custom calls require `allowCustomMethods` or an explicit `allowedMethods` list; `$vm.set`/`$vm.update` require `allowViewModelMutation`. |
| H-2 | High | Shared `FormGroup` cross-binding: configs can reuse/read/disable unrelated controls and copy their values into the shared view model | Add `formControlPolicy`: do not reuse existing controls by default; optional `allowedControlNames` allowlist; stop form-value writes at non-plain objects. |
| M-1 | Medium | ReDoS heuristic bypass (`^(\d+(?:\d+)?)+$` takes seconds on ~20 chars) | Replace heuristic with a conservative group/quantifier scanner; add regression test and keep input/pattern caps. |
| M-2 | Medium | Unbounded nested `items`, unbounded input/attribute/output key counts, and unbounded native string growth | Add config depth (32), total-node (2000) and key caps (100 keys, 128 chars); cap `repeat`/`padStart`/`padEnd`/`join`; add tests. |
| M-3 | Medium | Global registry is the default and `type` accepts functions/promises, bypassing registry scoping | Add `typePolicy`: reject function/promise loaders by default; optional `requireScopedRegistry`; add tests. |
| L-1 | Low | `id`/`name`/`class`/`href`/`src` enable DOM clobbering and UI-redress | Add `attributePolicy` strict mode for untrusted configs (disables `id`, `class`, `for`, `href`, `src`; keeps `name` for form wiring); test it. |
| L-2 | Low | Secret scan only checks filenames; lockfile is deleted by the update script; long-lived npm token | Scan staged file contents for common secret patterns; keep `package-lock.json`; document trusted publishing. |

## Files

- `projects/fg-dynamic-component/src/lib/safe-expression.ts` — host-object rejection, method policy, string-growth caps.
- `projects/fg-dynamic-component/src/lib/fg-dynamic.component.ts` — policy inputs, config limits, form/type/attribute hardening.
- `projects/fg-dynamic-component/src/lib/*.spec.ts` — regression tests for every fix.
- `README.md` + `projects/fg-dynamic-component/README.md` — security model and policy docs (keep byte-identical).
- `CLAUDE.md` — implementation notes.
- `git_commit_and_push.command`, `update_outdated_packages.command` — secret/supply-chain hardening.
- `.github/workflows/publish.yml` — comment/guidance for trusted publishing (keep token fallback).

## Verification

1. `npm run test -- --no-watch` — all existing tests plus new security regression tests pass.
2. `npm run build` — production library build passes.
3. Re-run the two proofs of concept from the review:
   - DOM event expression cannot reach `localStorage`, `document.cookie`, `fetch`, `location`, or `insertAdjacentHTML`.
   - `^(\d+(?:\d+)?)+$` is ignored by the pattern validator.
4. `git grep` secret patterns and `npm audit` remain clean.
5. Review `git diff`; no `dist/` or `node_modules/` changes committed.

## Compatibility notes

- Expressions are read-only by default. Existing configurations that call custom view-model
  methods must opt in with `[expressionPolicy]="{ allowCustomMethods: true }"` or list the
  methods in `allowedMethods`.
- Existing `$vm.set`/`$vm.update` expressions require `allowViewModelMutation: true`.
- Promise/loader component `type` values require `[typePolicy]="{ allowFunctionTypes: true }"`;
  Angular component classes continue to work.
- Pre-existing form controls are not reused unless
  `[formControlPolicy]="{ allowExistingControls: true }"` is set.
- Published version bumped to 4.0.0 (root/library `package.json`, lockfile and README compatibility table) because the security fixes change default behavior.
