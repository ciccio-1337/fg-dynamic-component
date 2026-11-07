# CLAUDE.md

## What this repo is
Single-package Angular library (`fg-dynamic-component`) published to npm. No demo app.

- `projects/fg-dynamic-component/src/lib/fg-dynamic.component.ts` — the implementation: `IFGDynamicItem`, `FGDynamicRegistry`, `FGDynamicService`, `FGDynamicComponent`.
- `projects/fg-dynamic-component/src/lib/safe-expression.ts` — internal allowlisted expression interpreter used instead of `eval()`. Not re-exported publicly.
- `projects/fg-dynamic-component/src/lib/*.spec.ts` — vitest specs (`fg-dynamic.component.spec.ts`, `safe-expression.spec.ts`).
- `projects/fg-dynamic-component/src/public-api.ts` — ng-packagr entry file; `export *` from the lib file, so anything exported there becomes public API automatically.
- `projects/fg-dynamic-component/src/test-setup.ts` — vitest setup file referenced by `angular.json`.
- `projects/fg-dynamic-component/package.json` — version + peerDeps that ng-packagr writes into the published package.
- `dist/fg-dynamic-component/` — build output (gitignored). This is what gets published.

## Commands
- `npm run build` — `ng build` (ng-packagr, production config → partial compilation).
- `npm run test -- --no-watch` — `ng test` via `@angular/build:unit-test` + vitest, single run. **Run this and `npm run build` before declaring work done.**
- `npm run watch` — `ng build --watch --configuration development`.
- Root `*.command` scripts are the repo's task-runner convention: `build.command`, `watch.command`, `git_commit_and_push.command`, `update_outdated_packages.command`. Each does `cd "$(dirname "$0")"` first.
- `update_outdated_packages.command` needs `rimraf` and `ncu` **globally installed** — they are not in devDependencies, so it fails as-is.
- `angular.json` uses the supported `@angular/build:ng-packagr` builder.
- `tsconfig.spec.json` includes `src/test-setup.ts` in the TS program.
- `.vscode/tasks.json` exposes the existing `build`/`watch`/`test` npm scripts.

## Testing
Vitest specs live next to the sources and run through Angular's unit-test builder. Root `tsconfig.json` has `"strict": false` but `strictTemplates: true`, so `ng build` still fails on template type errors; the library `tsconfig.lib.json` excludes `**/*.spec.ts` so specs never ship.

When touching the component, keep these regression areas covered:
- `ngOnChanges` awaits `loadComponentAsync`, so updates are applied one microtask after the change; tests should `await fixture.whenStable()` (see the `settle()` helper). `_ngOnChangesCounter` rejects stale async resolutions;
- unresolved/unknown/failed component types clear and destroy the previous component;
- scoped registries, prototype-name rejection, unsafe attribute/URL/pattern/path rejection;
- boolean attribute presence semantics and attribute/input key removal;
- dotted form names (nested groups), reused-control ownership/`valueChanges`, form rewiring and `disabled` normalization (`true`/`false`/`'true'`/`'false'`/`1`/`0`/null);
- `output()`/`OutputEmitterRef` and nullish output payloads;
- expression interpreter limits and forbidden constructs.

## Versioning & release
- The version is duplicated in root `package.json` and `projects/fg-dynamic-component/package.json` — bump **both**.
- Publishing is triggered by **creating a GitHub Release** (`.github/workflows/publish.yml`, `on: release: types: [created]`): it runs `npm ci && npm run test -- --no-watch && npm run build`, then `cd dist/fg-dynamic-component && npm publish --access=public --provenance` using `NPM_TOKEN`. The workflow has least-privilege `permissions` (`contents: read`, `id-token: write`), pinned action SHAs and the `npm-publish` environment. The version bump must be committed *before* the release is created; `dist/` is never committed.
- The README compatibility table (Angular version → library version → npm range) must be updated on every version bump. `README.md` and `projects/fg-dynamic-component/README.md` are byte-identical copies that must stay in sync (ng-packagr copies the library README into `dist`).
- Node 26.x (per CI workflow).

## Local resolution gotcha
Root `tsconfig.json` maps path `fg-dynamic-component` → `./dist/fg-dynamic-component` (built output, **not** source). Rebuild before expecting source changes to be visible when imported by package name.

## Implementation gotchas
- Everything runs off `ngOnChanges` on the `configuration` input: load type → create component → setInputs → setFormControlStatus → setFormControlValidators → setAttributes. Since it's `ngOnChanges` and not an `effect`, updates only re-apply when the `configuration` **reference** changes; mutating the config object in place will not re-apply inputs/attributes/validators. Children come from the template's `@for (item of configuration()?.items)`.
- Expression binding is **interpreted, never evaluated**. A string is evaluated only when it contains `$vm` or `$event` (and the matching context is available); otherwise the raw string is used literally. `evaluateSafeExpression` supports literals, arrays/objects, member access/optional chaining, calls, operators, ternaries, spread and expression-bodied arrows. Globals, assignments, `new`, `this`, template/regex literals and `__proto__`/`prototype`/`constructor`/`caller`/`callee`/`arguments` are rejected; source/token/depth/step limits apply. Do not reintroduce `eval`/`new Function`. Inside an expression `$vm` is callable (`$vm()`) and also exposes `set`/`update`; `$event` is the output payload (including `undefined`/`null` for void outputs).
- Nested `items` are **projected into** the dynamically created component via `projectableNodes` (taken from the `<fg-dynamic #dynamicItem>` template refs), so children render inside the created component's content projection rather than as siblings — the target component needs a matching `<ng-content>`. `items` is capped at 1000 entries and non-object entries are filtered out.
- The component instance is created once per resolved type; it is torn down/recreated when the resolved type, projected-items signature or form wiring (form group / evaluated control name) changes (`cleanup()` also runs from `ngOnDestroy`). `createComponent` only creates when `_componentRef` is absent and `_component` is set; unresolved/failed types clear `_component` and destroy the previous component.
- Component resolution goes through `FGDynamicRegistry` (`Map`-backed, no prototype-chain lookup). `FGDynamicService` is the default/global registry; pass a scoped registry via the `[registry]` input for untrusted configurations — it is propagated to nested items. Angular component classes are never invoked as loaders; only zero-arity non-Angular functions are treated as lazy loaders. `FGDynamicService._components` no longer exists — use `clearRegistry()`, `registry`, `createRegistry()`, `hasComponent()`, `unregisterComponent()`.
- Form wiring needs the `formGroup` input, a non-null `viewModel`, and an `attributes['name']` (dot/bracket path into the view model, e.g. `data.firstName`). Dotted names are represented as nested `FormGroup`s; the component builds its own `FormControl` + `FormControlDirective` and injects `NgControl` into the child. Wiring is re-evaluated on every change and rebinds/removes the control when the group or evaluated name changes.
- Control names are parsed by a single hardened `parsePath`: prototype segments (`__proto__`, `prototype`, `constructor`, case-insensitive) are rejected; depth is capped at 32 and each segment at 128 chars; traversal is own-property only and writes use `Object.defineProperty`.
- Validators are "managed": `_managedValidatorFns` is removed and rebuilt on every change, so don't attach other validators to that control. Attribute→validator mapping: `min`, `max`, `required`, `email`, `maxlength`, `minlength`, `pattern`. `pattern` is compiled defensively (512-char source cap, 1024-char input cap, nested-quantifier/quantified-alternation/backreference heuristics, and `RegExp` inputs are cloned without `g`/`y`) and invalid/non-string values are ignored. `disabled` is normalized from boolean/string/number values; removing the key restores the control's previous state. `disabled` and validators are UX-only — server-side enforcement is required.
- `cleanup()` removes the control only when this component created it (`_ownsFormControl`), using the exact parent group/key recorded at wire time; pre-existing controls are never removed and their previous disabled state is restored. It also removes empty intermediate groups created for dotted names.
- `attributes` names go through an allowlist (`id`, `class`, `name`, `role`, `title`, `tabindex`, `hidden`, `dir`, `lang`, `for`, `href`, `src`, common form attributes, plus `data-*`/`aria-*`). `on*`, `style`, `srcdoc`, `formaction`, namespaced names, non-primitive values and over-long values are ignored. `href`/`src` only allow `http`, `https`, `mailto`, `tel` and relative URLs. Boolean attributes use presence semantics (`true` adds them, `false`/`null` removes them); other values are stringified and `null`/`undefined` removes the attribute. Attributes/inputs deleted from the configuration are cleaned up on the next change.
- All diagnostics are dev-mode only (`isDevMode()`) and never include expression sources, configuration values or raw error objects.

## Conventions
- Commits follow Conventional Commits (`fix: ...`, `chore: ...`) — see `git log`.
- Only branch is `main`; `git_commit_and_push.command` refuses to commit likely secret files (`.env*`, `.npmrc`, `*.pem`, `*.key`, …) and then does `git add -A` → `git commit -m "Update"` → `git push`.
- `.editorconfig`: 4-space indent, single quotes in TS, final newline. The main source file mixes tab-indented blocks (the `@Component` decorator and signal fields) with 4-space blocks — write new code with 4 spaces, matching the dominant style.
- No Prettier/ESLint config; formatting is manual.
