# Security Review Remediation Plan — fg-dynamic-component

**Date:** 2026-10-26
**Source review:** full-repo security review (clean tree, no pending diff)
**Goal:** remove the identified injection/authorization/dependency risks while preserving the
documented public API as far as possible.

## Findings to fix

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| C-1 | Critical | `eval()` of configuration strings in `evaluateExpression` and the output handler → arbitrary JS execution / persistent XSS | Remove every `eval`. Add a self-contained, allowlisted expression interpreter (`safe-expression.ts`) supporting literals, property access, operators, calls on the view model, arrays/objects/spread and expression-bodied arrows. Unknown identifiers, `__proto__`/`prototype`/`constructor`, assignments and globals are rejected. Add step/depth/source-size limits. |
| H-1 | High | Arbitrary attribute injection through `attributes` (`onclick`, `href=javascript:`, `style`, …) | Validate attribute names against an allowlist + `data-*`/`aria-*`, reject `on*`, namespaces, `style`, `srcdoc`, `formaction`; validate URL-valued attributes; only stringify primitive values; cap name/value length. |
| H-2 | High | Prototype pollution via `attributes.name` path (`__proto__.x`) | Central `parsePath` that rejects `__proto__`, `prototype`, `constructor` (any casing), caps depth/segment length; own-property traversal only; `Object.defineProperty` writes. Apply before `FormGroup.addControl/get/removeControl` too. |
| M-1 | Medium | Global mutable component registry, prototype-chain lookup, invoking arbitrary `type` functions | Add `FGDynamicRegistry` backed by `Map`; `FGDynamicService` delegates to a default registry; optional `registry` input on the component (propagated to children) for scoped allowlists; own-key lookup only; detect Angular component classes and never invoke them; only invoke zero-arity loader functions; surface load failures. |
| M-2 | Medium | `disabled` and validators are client-side, config-controlled, not authorization | Document explicitly in README/CLAUDE that these are UX-only and that authorization/validation must be server-side; keep the existing managed-validator behaviour; add JSDoc on the `formGroup`/attribute wiring. |
| M-3 | Medium | ReDoS / invalid regex via `pattern` | Compile patterns defensively, cap source length, reject nested-quantifier patterns, skip `RegExp.test` on non-string/oversized values. |
| L-1 | Low | Unconditional `console.*` with error objects/schema details | Gate all diagnostics behind `isDevMode()` and log only a short message + error message (never raw error objects, values or expression source). |
| L-2 | Low | `obj.hasOwnProperty(...)` crashes; no config validation | Replace with `Object.hasOwn`; validate `configuration` shape, cap `items` count, ignore invalid entries without killing siblings. |
| L-3 | Low | Publish workflow hardening | `permissions` least privilege, pinned action SHAs, `environment`, `--provenance`, OIDC (`id-token: write`). |
| L-4 | Low | `git add .` + missing secret ignores | Add secret patterns to `.gitignore`; make the commit script exclude secret files and refuse on detection. |
| I-1 | Info | Build-tool dependency advisories | Update the Angular build toolchain to patched versions and re-run `npm audit`; re-verify build + tests. |

## Files

- `projects/fg-dynamic-component/src/lib/safe-expression.ts` — new safe evaluator.
- `projects/fg-dynamic-component/src/lib/fg-dynamic.component.ts` — registry, attribute/path validation, safe eval, dev-only logging, regex guards.
- `projects/fg-dynamic-component/src/lib/fg-dynamic.component.spec.ts` — security regression tests.
- `README.md` + `projects/fg-dynamic-component/README.md` — security section, expression subset, registry scoping (keep byte-identical).
- `CLAUDE.md` — implementation notes updated (no `eval`, safe subset, scoped registry).
- `.github/workflows/publish.yml` — supply-chain hardening.
- `.gitignore`, `git_commit_and_push.command` — secret hygiene.
- `package.json` / `package-lock.json` — patched build toolchain (only if the build stays green).
- `projects/fg-dynamic-component/src/public-api.ts` — unchanged: registry types are already exported from the component file; the expression interpreter stays internal.

## Verification

1. `npm run build` (partial compilation) must succeed.
2. `npm run test -- --no-watch` must pass, including new security tests:
   - `onclick` / `javascript:` attributes are not applied;
   - `__proto__.polluted` does not pollute `Object.prototype`;
   - payloads such as `fetch(...),$vm` are rejected (no network / no code execution);
   - `$vm().name`, ternaries, comparisons, `$vm.update(vm => ({...vm, x: $event}))` still work;
   - `pattern` with nested quantifier is ignored instead of freezing;
   - registry ignores prototype keys (`constructor`, `__proto__`) and scoped registries isolate components.
3. `npm audit` reviewed; no critical/high advisories left in shipped/runtime paths (build-only advisories documented if upgrades are incompatible).
4. Confirm `README.md` and `projects/fg-dynamic-component/README.md` are identical (`cmp`).
5. `git diff --stat` reviewed; no changes to `dist/` or `node_modules/` committed (both ignored).

## Compatibility notes

- Literal strings without `$vm`/`$event` keep working exactly as before.
- Expression strings are now limited to a safe subset. Unsupported constructs (assignments,
  `new`, globals, `this`, template literals, IIFEs, regex literals, optional catch-all) are
  ignored with a dev-mode warning instead of executing.
- Component types passed as functions are only invoked when they are not Angular classes and
  have zero declared parameters; promise loaders and `type: () => import(...)` keep working.
- The `registry` input is optional; existing `FGDynamicService.registerComponent` calls keep
  resolving through the default registry.
