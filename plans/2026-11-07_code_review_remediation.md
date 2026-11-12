# Code Review Remediation — fg-dynamic-component

**Date:** 2026-11-07  
**Scope:** Full-repository code review of `HEAD 98c9961` (working tree was clean).  
**Goal:** Implement the fixes from the review and add regression coverage.

## Fixes

### High

1. **Support dotted form-control names correctly**
   - Build nested `FormGroup`s for names like `data.firstName`, or consistently use literal control keys.
   - Keep a record of the parent group/key used for removal.
   - Use the stored control name (not the current configuration) during cleanup.

2. **Do not remove pre-existing form controls**
   - Track whether the control was created by this component.
   - Only remove owned controls; restore/unsubscribe reused controls.

3. **Clear stale dynamic components**
   - When `configuration.type` is missing, unknown, invalid or a loader fails, clear `_component` and destroy the old component instead of continuing to render it.
   - Handle invalid configuration shapes the same way.

4. **Support Angular `output()` emissions**
   - Accept both `EventEmitter` and `OutputEmitterRef` (or duck-type `subscribe()`), and support both subscription types during cleanup.

5. **Fix boolean attribute handling**
   - Remove boolean attributes (`hidden`, `disabled`, `readonly`, `required`, `checked`, `selected`, `multiple`) for falsey values and set them for truthy values instead of writing `"false"`.

6. **Evaluate output expressions with nullish `$event`**
   - Distinguish “no event context” from “event payload is `null`/`undefined`” so `EventEmitter<void>` and signal outputs still invoke handlers.

### Medium

7. **Guard async component resolution**
   - Check the `ngOnChanges` generation before assigning `_component` after an `await`.

8. **Rewire form controls when form inputs change**
   - Recreate the dynamic component when `formGroup`, the evaluated control name or form availability changes.
   - Create the control when form inputs become available after initial creation.

9. **Clean removed configuration keys**
   - Track applied DOM attributes and remove attributes whose keys disappear.
   - Re-enable controls when the `disabled` key is removed.
   - Track disabled state so pre-existing controls are not enabled accidentally.

10. **Subscribe to `valueChanges` for reused controls**
    - Use the same subscription setup for created and reused controls.

11. **Preserve functions/non-cloneables when updating the view model**
    - Replace the `structuredClone`/JSON fallback with a clone that preserves functions, class instances and other non-cloneable values.

12. **Strengthen ReDoS protection**
    - Extend the pattern heuristic to overlapping alternations such as `(a|aa)+` and `(\w|\d)+`.
    - Document that this remains a heuristic.

13. **Fix published peer dependencies**
    - Add `@angular/forms` and `rxjs` peers.
    - Align the Angular peer range with the README/toolchain (`^22.2.3`).
    - Mark the root package private.

14. **Make nullish `$vm` handling honest**
    - Only evaluate `$vm` expressions when a view-model value exists; otherwise fall back to the literal value.

15. **Enforce parser depth for collections and unary chains**
    - Count depth for arrays, objects, argument lists, unary operators and exponents.

16. **Fix `disabled` value normalization**
    - Normalize boolean/string/numeric values; remove dead branches and support key removal.

17. **Avoid stateful global/sticky `RegExp` validators**
    - Clone regexes without `g`/`y` before passing them to `Validators.pattern`.

### Low / maintainability

18. Preserve numeric-key objects instead of replacing them with arrays in `setModelPropertyValue`.
19. Reject malformed bracket paths.
20. Update stale comments and documentation.
21. Update tooling metadata:
    - Use the supported `@angular/build:ng-packagr` builder.
    - Include `test-setup.ts` in the spec TS program.
    - Fix stale VS Code tasks/launch entries.
    - Update Node version in `CONTRIBUTING.md`.
    - Remove the dead `CHANGELOG.md` entry from `SUMMARY.md`.
    - Remove the duplicate `plans/` ignore entry.
22. Improve type declarations (`Record<string, unknown>` instead of `string | unknown`).

## Regression Tests

Add tests for:

- dotted control names and nested group cleanup;
- reuse and non-removal of pre-existing controls;
- reused-control value synchronization;
- switching to an unknown/removed component type;
- async type change races;
- `output()` and void output emissions, including nullish `$event`;
- boolean attributes (true/false/removed);
- attribute and disabled-key removal;
- form inputs becoming available after initial render;
- function preservation during view-model updates;
- ReDoS alternation patterns and global/sticky regexes;
- nested parser depth limits;
- nullish view-model expression fallback;
- numeric disabled values.

## Verification

1. `npm run test -- --no-watch`
2. `npm run build`
3. `git status` review (no generated files committed)
