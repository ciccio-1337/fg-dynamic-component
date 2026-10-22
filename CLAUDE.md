# CLAUDE.md

## What this repo is
Single-package Angular library (`fg-dynamic-component`) published to npm. No demo app, no test suite.

- `projects/fg-dynamic-component/src/lib/fg-dynamic.component.ts` — the **entire** implementation (~530 lines): `IFGDynamicItem`, `FGDynamicService`, `FGDynamicComponent`. This is the only source file.
- `projects/fg-dynamic-component/src/public-api.ts` — ng-packagr entry file; `export *` from the lib file, so anything exported there becomes public API automatically.
- `projects/fg-dynamic-component/package.json` — version + peerDeps that ng-packagr writes into the published package.
- `dist/fg-dynamic-component/` — build output (gitignored). This is what gets published.

## Commands
- `npm run build` — `ng build` (ng-packagr, production config → partial compilation). **This is the only verification step**: no test runner, no lint, no typecheck script.
- `npm run watch` — `ng build --watch --configuration development`.
- Root `*.command` scripts are the repo's task-runner convention: `build.command`, `watch.command`, `git_commit_and_push.command`, `update_outdated_packages.command`. Each does `cd "$(dirname "$0")"` first.
- `update_outdated_packages.command` needs `rimraf` and `ncu` **globally installed** — they are not in devDependencies, so it fails as-is.
- `ng build` prints a deprecation warning for `@angular-devkit/build-angular:ng-packagr` (should become `@angular/build:ng-packagr`). Warning only, build still succeeds.
- `.vscode/tasks.json` invokes `npm start` / `npm test` — **those scripts don't exist**. Stale file; ignore it.

## Testing
There is no test infrastructure: no spec files, no karma/jasmine/jest/vitest, and `tsconfig.lib.json` excludes `**/*.spec.ts` so specs are never compiled into the package. Never report "tests pass" — there are none. Adding tests requires installing a runner yourself (Angular 22: `@angular/build` unit-test / vitest).

Note: root `tsconfig.json` has `"strict": false` but `strictTemplates: true`, so `ng build` still fails on template type errors.

## Versioning & release
- The version is duplicated in root `package.json` and `projects/fg-dynamic-component/package.json` — bump **both**.
- Publishing is triggered by **creating a GitHub Release** (`.github/workflows/publish.yml`, `on: release: types: [created]`): it runs `npm ci && npm run build`, then `cd dist/fg-dynamic-component && npm publish --access=public` using `NPM_TOKEN`. The version bump must be committed *before* the release is created; `dist/` is never committed.
- The README compatibility table (Angular version → library version → npm range) must be updated on every version bump. `README.md` and `projects/fg-dynamic-component/README.md` are byte-identical copies that must stay in sync (ng-packagr copies the library README into `dist`).
- Node 26.x (per CI workflow).

## Local resolution gotcha
Root `tsconfig.json` maps path `fg-dynamic-component` → `./dist/fg-dynamic-component` (built output, **not** source). Rebuild before expecting source changes to be visible when imported by package name.

## Implementation gotchas
- Everything runs off `ngOnChanges` on the `configuration` input: load type → create component → setInputs → setFormControlStatus → setFormControlValidators → setAttributes. Since it's `ngOnChanges` and not an `effect`, updates only re-apply when the `configuration` **reference** changes; mutating the config object in place will not re-apply inputs/attributes/validators. Children come from the template's `@for (item of configuration()?.items)`.
- Expression binding uses `eval()`. A string is evaluated **only** when it contains `$vm` or `$event` (and the matching value is non-null); otherwise the raw string is used literally. Inside an expression `$vm` is the ModelSignal itself → read with `$vm()`, write with `$vm.update(...)`; `$event` is the output payload.
- Nested `items` are **projected into** the dynamically created component via `projectableNodes` (taken from the `<fg-dynamic #dynamicItem>` template refs), so children render inside the created component's content projection rather than as siblings — the target component needs a matching `<ng-content>`.
- The component instance is created once per resolved type; it is torn down/recreated only when the resolved type changes (`cleanup()` also runs from `ngOnDestroy`). `createComponent` intentionally bails out while `_formControlDirective` exists to prevent double creation.
- Form wiring needs all three: the `formGroup` input, an `attributes['name']` (dot path into the view model, e.g. `data.firstName`), and a non-null `viewModel`. The component builds its own `FormControl` + `FormControlDirective` and injects `NgControl` into the child.
- Validators are "managed": `_managedValidatorFns` is removed and rebuilt on every change, so don't attach other validators to that control. Attribute→validator mapping: `min`, `max`, `required`, `email`, `maxlength`, `minlength`, `pattern`.
- `cleanup()` removes the control from the FormGroup **only if it is the one this component created** (`formGroup().get(name) === this._formControl`) — keep that guard, it protects pre-existing controls sharing the name.
- `attributes` values are stringified; `null`/`undefined` removes the attribute from the DOM.
- `FGDynamicService` is a static/global registry keyed by string name — names are app-wide and re-registering the same name overwrites it.

## Conventions
- Commits follow Conventional Commits (`fix: ...`, `chore: ...`) — see `git log`.
- Only branch is `main`; `git_commit_and_push.command` does `git add .` → `git commit -m "Update"` → `git push`.
- `.editorconfig`: 4-space indent, single quotes in TS, final newline. The main source file mixes tab-indented blocks (the `@Component` decorator and signal fields) with 4-space blocks — write new code with 4 spaces, matching the dominant style.
- No Prettier/ESLint config; formatting is manual.
