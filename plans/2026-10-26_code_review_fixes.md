# Code Review Fixes Plan - fg-dynamic-component

**Date:** 2026-10-26  
**Branch:** main  
**Goal:** Implement all fixes identified in the code review

## Summary of Issues

### CRITICAL
1. **eval() with no sandboxing/error handling** (`fg-dynamic.component.ts:467-475`) - Security risk, arbitrary code execution
2. **addControl name collision** (`fg-dynamic.component.ts:210-216`) - Could cause issues if control already exists

### HIGH
3. **Path parsing crashes on null** (`getModelPropertyValue:392`, `setModelPropertyValue:407`) - `match()` returns null, causes TypeError
4. **setModelPropertyValue creates objects for arrays** (`fg-dynamic.component.ts:410-412`) - Breaks array paths like `items[0].name`
5. **ProjectableNodes not updated** - Projected items not refreshed when items change on existing component instance
6. **Cleanup uses evaluated name** (`fg-dynamic.component.ts:494-505`) - Could fail if evaluation behaves differently

### MEDIUM
7. **ngOnChanges async races** - No cancellation/version tracking
8. **Outputs not re-wired on config changes** - Subscriptions not updated if outputs change on same instance
9. **Disabled attribute removal not handled** - Control stays disabled when attribute removed
10. **Validator DOM attribute comparisons are flawed** - Logic is incorrect
11. **Length validators missing typeof check** - Could pass wrong types
12. **Manual FormControlDirective wiring** - Hacky but may need hardening

### LOW
13. **Silent failures** (missing component registration, loader errors) - Add warnings
14. **Type safety improvements**
15. **Code readability**

## Implementation Plan

### Fix 1: Harden evaluateExpression
- Wrap `eval()` in try/catch
- Return `undefined` or original value on error
- Add logging
- Consider safer evaluation (but keep backward compat)
- Prevent scope issues where possible

### Fix 2: Handle form control name collision
- Check if control with name already exists
- If exists and it's different instance, handle appropriately (warn, don't overwrite, or reuse)
- Follow the guard pattern used in cleanup

### Fix 3: Fix path parsing null issues
- Guard against null from `match()`
- Return appropriate defaults
- Handle empty paths

### Fix 4: Fix setModelPropertyValue for arrays
- Detect numeric keys (array indices)
- Create arrays `[]` for numeric indices
- Check existing value types before overwriting
- Handle edge cases

### Fix 5: Handle projectableNodes updates
- Track items reference/length
- Recreate component when items change (or update projection)
- Or track and detect changes

### Fix 6: Fix outputs re-wiring
- Track current outputs configuration
- Re-subscribe when outputs change even if component instance unchanged
- Clean up old subscriptions before re-subscribing

### Fix 7: Fix disabled attribute removal
- When disabled attribute is removed/null, re-enable the control
- Handle properly

### Fix 8: Fix validator logic
- Remove flawed DOM attribute comparisons
- Add proper typeof checks for all validators
- Rebuild validators cleanly each time

### Fix 9: Add cancellation to ngOnChanges
- Track configuration reference/version
- Ignore stale async operations

### Fix 10: Improve error handling and warnings
- Log warnings for missing components
- Better error messages

## Files to Modify
- `projects/fg-dynamic-component/src/lib/fg-dynamic.component.ts` - Main implementation
- Possibly add tests? No test infrastructure exists, skip for now per repo conventions

## Testing
- Run `npm run build` after changes to verify compilation
- Manual review of changes

## Notes
- Follow existing code style (4 spaces, mixed tabs/spaces as-is)
- Maintain backward compatibility
- Keep changes minimal and focused
- No new dependencies
- Don't modify dist/, node_modules/
- Follow CLAUDE.md gotchas
