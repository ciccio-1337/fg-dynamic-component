import { ChangeDetectionStrategy, Component, ComponentRef, ElementRef, Injector, InputSignal, ModelSignal, OnChanges, OnDestroy, Renderer2, Signal, SimpleChanges, Type, ViewContainerRef, computed, inject, input, isDevMode, model, viewChild, viewChildren } from '@angular/core';
import { AbstractControl, ControlValueAccessor, FormControl, FormControlDirective, FormGroup, NG_VALUE_ACCESSOR, NgControl, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';
import { Subscription } from 'rxjs';
import { evaluateSafeExpression } from './safe-expression';

export type FGDynamicType = Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>);

export interface IFGDynamicItem {
    type?: string | FGDynamicType;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, string | Function>;
    attributes?: Record<string, unknown>;
    items?: IFGDynamicItem[];
}

/**
 * Controls what expressions may do. By default expressions are read-only and
 * can only call native built-ins and `$vm()`; custom view-model methods and
 * view-model mutation require an explicit opt-in.
 */
export interface IFGDynamicExpressionPolicy {
    /** Allow calling any method reachable from the view model. Defaults to `false`. */
    allowCustomMethods?: boolean;
    /** Method names that may be called when `allowCustomMethods` is `false`. */
    allowedMethods?: readonly string[];
    /** Expose `$vm.set` and `$vm.update`. Defaults to `false`. */
    allowViewModelMutation?: boolean;
}

/**
 * Controls how the dynamic component interacts with the host `FormGroup`.
 * By default pre-existing controls and nested groups are not reused.
 */
export interface IFGDynamicFormPolicy {
    /** Reuse controls/groups that already exist in the supplied `FormGroup`. */
    allowExistingControls?: boolean;
    /** Optional allowlist of form control names (the evaluated `attributes.name`). */
    allowedControlNames?: readonly string[];
}

/**
 * Controls which component `type` values are accepted.
 * Promise/loader values are rejected unless explicitly enabled.
 */
export interface IFGDynamicTypePolicy {
    /** Allow promise-returning and function loader `type` values. Defaults to `false`. */
    allowFunctionTypes?: boolean;
    /** Require an explicit scoped registry instead of the global default. */
    requireScopedRegistry?: boolean;
}

/**
 * Controls which DOM attributes may be applied. `strict` is intended for
 * untrusted configurations and disables UI-redress/DOM-clobbering attributes.
 */
export interface IFGDynamicAttributePolicy {
    /** Disallow `id`, `class`, `for`, `href` and `src`. Defaults to `false`. */
    strict?: boolean;
}

const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PATH_DEPTH = 32;
const MAX_PATH_SEGMENT_LENGTH = 128;
const MAX_CONFIGURATION_ITEMS = 1000;
const MAX_CONFIGURATION_DEPTH = 32;
const MAX_TOTAL_CONFIGURATION_NODES = 2000;
const MAX_CONFIGURATION_KEYS = 100;
const MAX_CONFIGURATION_KEY_LENGTH = 128;
const MAX_ATTRIBUTE_NAME_LENGTH = 128;
const MAX_ATTRIBUTE_VALUE_LENGTH = 8192;
const MAX_PATTERN_LENGTH = 512;
const MAX_PATTERN_INPUT_LENGTH = 1024;

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
    'class', 'id', 'name', 'role', 'title', 'tabindex', 'hidden', 'dir', 'lang',
    'disabled', 'readonly', 'required', 'placeholder', 'autocomplete', 'spellcheck',
    'min', 'max', 'minlength', 'maxlength', 'pattern', 'email', 'step',
    'multiple', 'checked', 'selected', 'for', 'href', 'src'
]);

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src']);

/** Attributes disabled by `attributePolicy.strict` for untrusted configurations. */
const STRICT_DISALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set(['id', 'class', 'for', 'href', 'src']);

/**
 * HTML boolean attributes: presence means `true`, so a false/absent value must
 * remove the attribute instead of writing `"false"`.
 */
const BOOLEAN_ATTRIBUTES: ReadonlySet<string> = new Set([
    'hidden', 'disabled', 'readonly', 'required', 'checked', 'selected', 'multiple'
]);

/**
 * A scoped component registry. Backed by a `Map`, so lookups never walk the
 * prototype chain and names such as `__proto__` or `constructor` are ordinary keys.
 *
 * Use one registry per rendering context (e.g. per plugin or tenant) so a
 * configuration can only select components that were explicitly registered for
 * that context.
 */
export class FGDynamicRegistry {
    private readonly _components = new Map<string, FGDynamicType>();

    register(name: string, type: FGDynamicType): void {
        if (typeof name === 'string' && name.length > 0 && type) {
            this._components.set(name, type);
        }
    }

    get(name: string): FGDynamicType | undefined {
        return typeof name === 'string' ? this._components.get(name) : undefined;
    }

    has(name: string): boolean {
        return typeof name === 'string' && this._components.has(name);
    }

    unregister(name: string): boolean {
        return this._components.delete(name);
    }

    clear(): void {
        this._components.clear();
    }

    get names(): string[] {
        return Array.from(this._components.keys());
    }
}

/**
 * Declare components to dynamically load in static and/or dynamic way using the FGDynamicService.
 *
 * The static registry is global. For untrusted or multi-tenant configurations,
 * create a scoped registry with `FGDynamicService.createRegistry()` and pass it
 * to `<fg-dynamic [registry]="registry">`.
 */
export class FGDynamicService {
    private static readonly _defaultRegistry = new FGDynamicRegistry();

    static get registry(): FGDynamicRegistry {
        return FGDynamicService._defaultRegistry;
    }

    static createRegistry(): FGDynamicRegistry {
        return new FGDynamicRegistry();
    }

    static registerComponent(name: string, type: FGDynamicType): void {
        FGDynamicService._defaultRegistry.register(name, type);
    }

    static getComponent(name: string): FGDynamicType | undefined {
        return FGDynamicService._defaultRegistry.get(name);
    }

    static hasComponent(name: string): boolean {
        return FGDynamicService._defaultRegistry.has(name);
    }

    static unregisterComponent(name: string): boolean {
        return FGDynamicService._defaultRegistry.unregister(name);
    }

    static clearRegistry(): void {
        FGDynamicService._defaultRegistry.clear();
    }
}

/**
 * Create a standalone signals based dynamic components tree through a JSON configuration with full
 * life-cycle support for inputs, outputs, attributes, reactive forms and expressions binding evaluation.
 */
@Component({
	selector: 'fg-dynamic',
	template: `
        <ng-container #viewContainer></ng-container>
        @for (item of items(); track $index) {
            <fg-dynamic #dynamicItem [configuration]="item" [(viewModel)]="viewModel" [formGroup]="formGroup()" [registry]="registry()" [expressionPolicy]="expressionPolicy()" [formControlPolicy]="formControlPolicy()" [typePolicy]="typePolicy()" [attributePolicy]="attributePolicy()" [depth]="depth() + 1" />
        }
    `,
	changeDetection: ChangeDetectionStrategy.OnPush,
	standalone: true,
	styles: [`:host { display: contents; }`]
})
export class FGDynamicComponent implements OnChanges, OnDestroy {
	configuration: InputSignal<IFGDynamicItem> = input.required<IFGDynamicItem>();
	viewModel: ModelSignal<unknown> = model<unknown>();
	formGroup: InputSignal<FormGroup> = input<FormGroup>();
	registry: InputSignal<FGDynamicRegistry> = input<FGDynamicRegistry>(FGDynamicService.registry);
	expressionPolicy: InputSignal<IFGDynamicExpressionPolicy> = input<IFGDynamicExpressionPolicy>({});
	formControlPolicy: InputSignal<IFGDynamicFormPolicy> = input<IFGDynamicFormPolicy>({});
	typePolicy: InputSignal<IFGDynamicTypePolicy> = input<IFGDynamicTypePolicy>({});
	attributePolicy: InputSignal<IFGDynamicAttributePolicy> = input<IFGDynamicAttributePolicy>({});
	/** Current nesting depth; used to bound recursive configurations. */
	depth: InputSignal<number> = input<number>(0);

    /**
     * Validated child items. Invalid entries are ignored and the list is capped
     * to avoid pathological configurations blocking the renderer.
     */
    protected readonly items: Signal<readonly IFGDynamicItem[]> = computed((): readonly IFGDynamicItem[] => {
        if (this.depth() >= MAX_CONFIGURATION_DEPTH) {
            return [];
        }
        const configuration = this.configuration();
        if (!this.validateConfiguration(configuration)) {
            return [];
        }
        const items = configuration && typeof configuration === 'object' && !Array.isArray(configuration) ? (configuration as IFGDynamicItem).items : undefined;
        if (!Array.isArray(items)) {
            return [];
        }
        return items
            .filter((item: unknown): item is IFGDynamicItem => item != null && typeof item === 'object' && !Array.isArray(item))
            .slice(0, MAX_CONFIGURATION_ITEMS);
    });

	private _viewContainerRef: Signal<ViewContainerRef> = viewChild.required('viewContainer', {
        read: ViewContainerRef
    });
    private _dynamicItems: Signal<readonly ElementRef<unknown>[]> = viewChildren('dynamicItem', {
        read: ElementRef
    });
	private _componentRef?: ComponentRef<unknown>;
    private _renderer: Renderer2 = inject(Renderer2);
    private _outputsSubscriptions: Array<{ unsubscribe(): void }> = [];
    private _currentOutputsConfig?: Record<string, string | Function>;
    private _formControl?: FormControl;
    private _formControlDirective?: FormControlDirective;
    private _formControlSubscription?: Subscription;
    private _managedValidatorFns: ValidatorFn[] = [];
    private _component?: Type<unknown>;
    private _injector: Injector = inject(Injector);
    private _ngOnChangesCounter = 0;
    private _lastProjectedItemsSignature?: string;

    /** Group that literally contains the current control (may be a nested group). */
    private _formControlContainer?: FormGroup;
    /** Literal key of the control inside `_formControlContainer`. */
    private _formControlKey?: string;
    /** True only when this component created (and may therefore remove) the control. */
    private _ownsFormControl = false;
    /** Intermediate groups created while wiring a dotted control name. */
    private _createdFormGroups: Array<{ parent: FormGroup; key: string; group: FormGroup }> = [];
    /** Form wiring currently attached to the rendered component, used to detect rebinds. */
    private _wiredFormGroup?: FormGroup;
    private _wiredControlName?: string;
    /** Disabled state managed by this component, so it can be restored when `disabled` disappears. */
    private _disabledManaged = false;
    private _disabledBeforeManagement?: boolean;

    /** Attribute names currently applied to the dynamic element. */
    private _appliedAttributes = new Set<string>();
    /** Input names currently set on the dynamic component. */
    private _appliedInputs = new Set<string>();

    /**
     * A callback method that is invoked immediately after the default change
     * detector has checked data-bound properties if at least one has changed,
     * and before the view and content children are checked.
     */
    async ngOnChanges(changes?: SimpleChanges): Promise<void> {
        const counter = ++this._ngOnChangesCounter;
        try {
            const configuration = this.configuration();
            if (configuration != null && (typeof configuration !== 'object' || Array.isArray(configuration))) {
                this.logError('Invalid configuration: expected an object.');
                this.clearResolvedComponent(counter);
                return;
            }

            if (!this.validateConfiguration(configuration)) {
                this.logError('Invalid configuration: it exceeds the structural limits.');
                this.clearResolvedComponent(counter);
                return;
            }

            // Lazy-load a component. Resolutions from older change-detection
            // generations are rejected inside `loadComponentAsync`.
            await this.loadComponentAsync(counter);

            if (counter !== this._ngOnChangesCounter) {
                return;
            }

            // If projected items changed, we need to recreate the component to update projectableNodes
            const items = this.items();
            const itemsSignature = items.length > 0
                ? `${items.length}:${items.map((item: IFGDynamicItem, index: number): string => `${index}:${item?.type}`).join('|')}`
                : '';
            if (this._componentRef && this._lastProjectedItemsSignature !== itemsSignature) {
                this.cleanup();
                this._lastProjectedItemsSignature = itemsSignature;
            } else if (!this._componentRef) {
                this._lastProjectedItemsSignature = itemsSignature;
            }

            // Recreate the component when the form wiring (group/name) changed.
            this.rewireFormIfNeeded();

            // Instantiates a single component and inserts its host view into this container.
            this.createComponent();

            if (counter !== this._ngOnChangesCounter) {
                return;
            }

            // Updates specified input names to new values.
            this.setInputs();
            // Disables/enables the control.
            this.setFormControlStatus();
            // Add synchronous validators to this control.
            this.setFormControlValidators();
            // Set attribute values for an element in the DOM.
            this.setAttributes();
            // Re-wire outputs if they changed
            this.handleOutputsIfChanged();
            // Ensure change detection
            if (this._componentRef?.changeDetectorRef) {
                this._componentRef.changeDetectorRef.markForCheck();
            }
        } catch (error) {
            if (counter === this._ngOnChangesCounter) {
                this.logError('Error during component initialization.', error);
                this.clearResolvedComponent(counter);
            }
        }
    }

    /**
     * Destroys the rendered component when it no longer has a resolvable type.
     * Ignored when a newer `ngOnChanges` generation has started.
     */
    private clearResolvedComponent(counter: number): void {
        if (counter !== this._ngOnChangesCounter) {
            return;
        }
        this._component = undefined;
        if (this._componentRef) {
            this.cleanup();
        }
    }

    /**
     * Validates the whole configuration subtree before rendering. Rejects
     * excessive depth, node count, key counts, oversized keys and cycles.
     * The check is iterative so a hostile configuration cannot overflow the
     * JavaScript stack during validation itself.
     */
    private validateConfiguration(configuration: IFGDynamicItem | null | undefined): boolean {
        if (configuration == null) {
            return true;
        }

        const stats = this.collectConfigurationStats(configuration);
        if (!stats) {
            return false;
        }

        return this.depth() + stats.maxDepth <= MAX_CONFIGURATION_DEPTH
            && stats.nodes <= MAX_TOTAL_CONFIGURATION_NODES;
    }

    private collectConfigurationStats(configuration: IFGDynamicItem): { nodes: number; maxDepth: number } | null {
        const stack: Array<{ item: unknown; depth: number }> = [{ item: configuration, depth: 0 }];
        const seen = new WeakSet<object>();
        let nodes = 0;
        let maxDepth = 0;

        while (stack.length > 0) {
            const current = stack.pop()!;
            const item = current.item;

            if (item == null || typeof item !== 'object' || Array.isArray(item)) {
                return null;
            }
            if (seen.has(item)) {
                // Reject cycles and repeated references to the same node.
                return null;
            }
            seen.add(item);

            nodes++;
            if (nodes > MAX_TOTAL_CONFIGURATION_NODES || current.depth > MAX_CONFIGURATION_DEPTH) {
                return null;
            }
            if (current.depth > maxDepth) {
                maxDepth = current.depth;
            }

            for (const field of ['inputs', 'attributes', 'outputs'] as const) {
                const map = (item as Record<string, unknown>)[field];
                if (map == null) {
                    continue;
                }
                if (typeof map !== 'object' || Array.isArray(map)) {
                    return null;
                }

                const keys = Object.keys(map as Record<string, unknown>);
                if (keys.length > MAX_CONFIGURATION_KEYS) {
                    return null;
                }
                if (keys.some((key: string): boolean => key.length > MAX_CONFIGURATION_KEY_LENGTH
                    || FORBIDDEN_PATH_SEGMENTS.has(key.toLowerCase()))) {
                    return null;
                }
            }

            const items = (item as Record<string, unknown>)['items'];
            if (items == null) {
                continue;
            }
            if (!Array.isArray(items) || items.length > MAX_CONFIGURATION_ITEMS) {
                return null;
            }

            for (const child of items) {
                stack.push({ item: child, depth: current.depth + 1 });
            }
        }

        return { nodes, maxDepth };
    }

    /**
     * A method to lazy-load a component.
     */
    private async loadComponentAsync(counter: number): Promise<void> {
        const configurationType = this.configuration()?.type;

        if (configurationType == null) {
            this.clearResolvedComponent(counter);
            return;
        }

        if (this.typePolicy()?.requireScopedRegistry === true && this.isUsingGlobalRegistry()) {
            this.logWarning('A scoped registry is required by typePolicy but only the global registry is available.');
            this.clearResolvedComponent(counter);
            return;
        }

        let candidate: FGDynamicType | undefined;

        if (typeof configurationType === 'string') {
            candidate = this.getRegistry().get(configurationType);
            if (candidate == null) {
                this.logWarning(`Component type "${configurationType}" not found in the registry.`);
                this.clearResolvedComponent(counter);
                return;
            }
        } else {
            candidate = configurationType;
        }

        if (!this.isCandidateAllowed(candidate)) {
            this.logWarning('Component type was rejected by typePolicy (function/promise types are disabled).');
            this.clearResolvedComponent(counter);
            return;
        }

        try {
            const resolved = this.resolveCandidate(candidate);
            const resolvedType = this.isPromiseLike(resolved) ? await resolved : resolved;

            // Ignore resolutions that belong to a superseded configuration.
            if (counter !== this._ngOnChangesCounter) {
                return;
            }

            if (!resolvedType) {
                this.clearResolvedComponent(counter);
                return;
            }

            // Only re-assign when the resolved type actually changed, so that subsequent
            // input/attribute updates don't tear down the already-instantiated component.
            if (this._component !== resolvedType) {
                this.cleanup();
                this._component = resolvedType;
            }
        } catch (error) {
            if (counter !== this._ngOnChangesCounter) {
                return;
            }
            this.logError('Unable to resolve the dynamic component type.', error);
            this.clearResolvedComponent(counter);
        }
    }

    private isPromiseLike(value: unknown): value is PromiseLike<unknown> {
        return value != null
            && (typeof value === 'object' || typeof value === 'function')
            && typeof (value as { then?: unknown }).then === 'function';
    }

    private resolveCandidate(candidate: unknown): Type<unknown> | PromiseLike<Type<unknown> | undefined> | undefined {
        if (candidate == null) {
            return undefined;
        }

        if (this.isPromiseLike(candidate)) {
            return Promise.resolve(candidate).then((resolved: unknown): Type<unknown> | undefined => this.toComponentType(resolved));
        }

        if (typeof candidate === 'function') {
            // Never invoke an Angular component/directive/pipe class: it is a type, not a loader.
            if (this.isAngularComponentType(candidate)) {
                return candidate as Type<unknown>;
            }

            // A function with declared parameters cannot be a lazy loader (loaders are zero-arity).
            if (candidate.length > 0) {
                return candidate as Type<unknown>;
            }

            const result: unknown = (candidate as () => unknown)();

            if (this.isPromiseLike(result)) {
                return Promise.resolve(result).then((resolved: unknown): Type<unknown> | undefined => this.toComponentType(resolved));
            }

            return this.toComponentType(result);
        }

        this.logWarning('Invalid component type in configuration.');
        return undefined;
    }

    private toComponentType(resolved: unknown): Type<unknown> | undefined {
        if (typeof resolved === 'function') {
            return resolved as Type<unknown>;
        }

        this.logWarning('Component loader did not resolve to a component type.');
        return undefined;
    }

    private isAngularComponentType(candidate: Function): boolean {
        const metadata = candidate as unknown as Record<string, unknown>;
        return Boolean(
            metadata['ɵcmp'] ||
            metadata['ɵdir'] ||
            metadata['ɵpipe'] ||
            metadata['ɵfac'] ||
            metadata['ngComponentDef'] ||
            metadata['ngDirectiveDef']
        );
    }

    /**
     * Function loaders and thenables execute host code, so they are only
     * accepted when the host opts in. Angular component classes stay allowed.
     */
    private isCandidateAllowed(candidate: unknown): boolean {
        if (candidate == null) {
            return false;
        }
        if (this.typePolicy()?.allowFunctionTypes === true) {
            return true;
        }
        return typeof candidate === 'function' && this.isAngularComponentType(candidate);
    }

    private isUsingGlobalRegistry(): boolean {
        const registry = this.registry();
        return registry == null || registry === FGDynamicService.registry;
    }

    private getRegistry(): FGDynamicRegistry {
        return this.registry() ?? FGDynamicService.registry;
    }

    /**
     * Instantiates a single component and inserts its host view into this container.
     */
    private createComponent(): void {
        // If the component type changed, clean up and recreate it.
        if (this._componentRef && this._component !== this._componentRef.componentType) {
            this.cleanup();
        }

        if (this._component && !this._componentRef && this._viewContainerRef()) {
            let injector: Injector | undefined = undefined;
            const formGroup = this.formGroup();
            const controlName = this.resolveFormControlName();

            if (formGroup && controlName) {
                // Synchronizes a standalone FormControl instance to a form control element.
                this._formControlDirective = new FormControlDirective(null, null, null, null);

                // Creates a new injector instance that provides one or more dependencies, according to a given type or types of StaticProvider.
                injector = Injector.create({
                    providers: [{
                        provide: NgControl,
                        useValue: this._formControlDirective
                    }],
                    parent: this._injector
                });
            }

            // Instantiates a single component and inserts its host view into this container.
            const dynamicItems = this._dynamicItems();
            this._componentRef = this._viewContainerRef().createComponent(this._component, {
                projectableNodes: dynamicItems && dynamicItems.length > 0 ? [dynamicItems.map((e: ElementRef<unknown>): Node => e.nativeElement as Node)] : undefined,
                injector: injector
            });

            // When a view uses the ChangeDetectionStrategy#OnPush (checkOnce) change detection strategy, explicitly marks the view as changed so that it can be checked again.
            // Components are normally marked as dirty (in need of rerendering) when inputs have changed or events have fired in the view.
            // Call this method to ensure that a component is checked even if these triggers have not occurred.
            if (this._componentRef?.changeDetectorRef) {
                this._componentRef.changeDetectorRef.markForCheck();
            }

            // Register handlers for those events by subscribing to an instance.
            this.handleOutputs();
            // Construct and attach a FormControl with an initial value.
            this.wireFormControl();
        }
    }

    /**
     * Register handlers for those events by subscribing to an instance.
     * Supports both `EventEmitter` (`@Output`) and signal outputs created with `output()`.
     */
    private handleOutputs(): void {
        // Clean up existing subscriptions
        if (this._outputsSubscriptions && this._outputsSubscriptions.length > 0) {
            this._outputsSubscriptions.forEach((s: { unsubscribe(): void }): void => {
                try {
                    s.unsubscribe();
                } catch (e) {
                    // Ignore
                }
            });
            this._outputsSubscriptions = [];
        }

        const outputs = this.configuration()?.outputs;
        this._currentOutputsConfig = outputs ? { ...outputs } : undefined;

        if (outputs && typeof outputs === 'object' && this._componentRef?.instance) {
            const instance = this._componentRef.instance as Record<string, unknown>;

            for (const outputName of Object.keys(outputs)) {
                const emitter = instance[outputName];

                if (!this.isOutputEmitter(emitter)) {
                    continue;
                }

                const subscription = emitter.subscribe(($event: unknown): void => {
                    try {
                        const expr = outputs[outputName];
                        const viewModelValue = this.getViewModelValue();
                        // Output handlers always have an event context, even when the
                        // emitted payload is `null`/`undefined` (e.g. `EventEmitter<void>`).
                        const result: unknown = typeof expr === 'string'
                            ? this.evaluateExpression(expr, viewModelValue, $event, true)
                            : expr;

                        if (typeof result === 'function') {
                            (result as Function).call(viewModelValue, $event);
                        }
                    } catch (error) {
                        this.logError('Error handling output.', error);
                    }
                });

                if (subscription && typeof subscription.unsubscribe === 'function') {
                    this._outputsSubscriptions.push(subscription);
                }
            }
        }
    }

    private isOutputEmitter(value: unknown): value is { subscribe(callback: (event: unknown) => void): { unsubscribe(): void } | void } {
        if (value == null) {
            return false;
        }
        const emitter = value as Record<string, unknown>;
        return typeof emitter['subscribe'] === 'function' && typeof emitter['emit'] === 'function';
    }

    private handleOutputsIfChanged(): void {
        const outputs = this.configuration()?.outputs;
        const current = this._currentOutputsConfig;
        
        // Check if outputs changed
        if (!outputs && !current) {
            return;
        }
        if (!outputs || !current) {
            this.handleOutputs();
            return;
        }
        
        const currentKeys = Object.keys(current).sort();
        const newKeys = Object.keys(outputs).sort();
        if (currentKeys.length !== newKeys.length) {
            this.handleOutputs();
            return;
        }
        for (let i = 0; i < currentKeys.length; i++) {
            if (currentKeys[i] !== newKeys[i] || current[currentKeys[i]] !== outputs[newKeys[i]]) {
                this.handleOutputs();
                return;
            }
        }
    }

    /**
     * Evaluates the configured `attributes.name` into a safe control path.
     * Returns `undefined` when the view model or name is not available yet, so
     * the wiring is retried on the next change.
     */
    private resolveFormControlName(): string | undefined {
        const attributes = this.configuration()?.attributes;
        if (!attributes || !Object.hasOwn(attributes, 'name')) {
            return undefined;
        }

        const nameAttr = attributes['name'];
        if (nameAttr == null) {
            return undefined;
        }

        const viewModelValue = this.getViewModelValue();
        if (viewModelValue == null) {
            return undefined;
        }

        const name = this.evaluateExpression(nameAttr, viewModelValue);
        if (typeof name !== 'string' || name.length === 0) {
            return undefined;
        }

        if (!this.isSafePath(name)) {
            this.logWarning('Unsafe form control name was ignored.');
            return undefined;
        }

        const allowedNames = this.formControlPolicy()?.allowedControlNames;
        if (allowedNames !== undefined && (!Array.isArray(allowedNames) || !allowedNames.includes(name))) {
            this.logWarning('Form control name was rejected by formControlPolicy.');
            return undefined;
        }

        return name;
    }

    /**
     * Recreates the dynamic component when the `formGroup`, the evaluated
     * control name or the availability of the view model changed.
     */
    private rewireFormIfNeeded(): void {
        if (!this._componentRef) {
            return;
        }

        const formGroup = this.formGroup();
        const controlName = this.resolveFormControlName();
        const desiredGroup = formGroup && controlName ? formGroup : undefined;

        if (this._wiredFormGroup !== desiredGroup || this._wiredControlName !== controlName) {
            this.cleanup();
        }
    }

    /**
     * Constructs (or reuses) the form control and attaches it to the rendered
     * component. Dotted names are represented as nested `FormGroup`s so that
     * `formGroup.get('data.firstName')` works and no key contains a dot.
     */
    private wireFormControl(): void {
        const formGroup = this.formGroup();
        const name = this.resolveFormControlName();

        if (!formGroup || !name) {
            this._wiredFormGroup = undefined;
            this._wiredControlName = undefined;
            return;
        }

        const path = this.parsePath(name);
        if (!path) {
            this._wiredFormGroup = undefined;
            this._wiredControlName = undefined;
            return;
        }

        const parent = this.ensureFormGroupPath(formGroup, path.slice(0, -1));
        if (!parent) {
            this._wiredFormGroup = undefined;
            this._wiredControlName = undefined;
            return;
        }

        const key = path[path.length - 1];
        const existing = parent.get(key);

        if (existing) {
            if (this.formControlPolicy()?.allowExistingControls !== true) {
                this.logWarning('A form control with the requested name already exists; reuse is disabled by formControlPolicy.');
                this._wiredFormGroup = undefined;
                this._wiredControlName = undefined;
                return;
            }

            if (!(existing instanceof FormControl)) {
                this.logWarning('A form control with the requested name already exists and is not a FormControl.');
                this._wiredFormGroup = undefined;
                this._wiredControlName = undefined;
                return;
            }

            this.logWarning('A form control with the requested name already exists; reusing it.');
            this._formControl = existing;
            this._ownsFormControl = false;
        } else {
            // Construct a FormControl with an initial value.
            const control = new FormControl(this.getModelPropertyValue(this.getViewModelValue(), name, null));

            try {
                // Add a control to this group. `key` never contains a dot.
                parent.addControl(key, control);
                this._formControl = control;
                this._ownsFormControl = true;
            } catch (error) {
                this.logError('Error adding form control.', error);
                return;
            }
        }

        this._formControlContainer = parent;
        this._formControlKey = key;
        this._wiredFormGroup = formGroup;
        this._wiredControlName = name;
        this._disabledBeforeManagement = this._formControl.disabled;

        // Synchronizes a standalone FormControl instance to a form control element.
        this.attachFormControlDirective();
        this.bindFormControlValueChanges(name);
    }

    /**
     * Walks/creates the nested `FormGroup`s required by a dotted control path.
     * Created groups are tracked so they can be removed again on cleanup.
     */
    private ensureFormGroupPath(root: FormGroup, segments: string[]): FormGroup | null {
        let current = root;

        for (const segment of segments) {
            const existing = current.get(segment);

            if (existing == null) {
                const group = new FormGroup({});
                try {
                    current.addControl(segment, group);
                } catch (error) {
                    this.logError('Error creating nested form group.', error);
                    return null;
                }
                this._createdFormGroups.push({ parent: current, key: segment, group });
                current = group;
            } else if (existing instanceof FormGroup) {
                if (this.formControlPolicy()?.allowExistingControls !== true) {
                    this.logWarning(`Cannot reuse existing nested form group "${segment}" because formControlPolicy disables it.`);
                    return null;
                }
                current = existing;
            } else {
                this.logWarning(`Cannot create nested form group "${segment}" because a different control already exists.`);
                return null;
            }
        }

        return current;
    }

    /**
     * Keeps the view model in sync with the control value. Used for both newly
     * created and reused controls.
     */
    private bindFormControlValueChanges(name: string): void {
        if (this._formControlSubscription) {
            try {
                this._formControlSubscription.unsubscribe();
            } catch (e) {
                // Ignore
            }
        }

        this._formControlSubscription = this._formControl.valueChanges.subscribe((value: unknown): void => {
            const currentModel = this.getViewModelValue();
            if (currentModel == null) {
                return;
            }

            // Clone plain objects/arrays so sibling values are preserved, while
            // functions and non-plain objects (class instances, DOM nodes, ...)
            // are kept by reference instead of being dropped.
            const viewModel = this.cloneForMutation(currentModel);

            // Sets the value at path of object.
            this.setModelPropertyValue(viewModel, name, value);
            // Directly set the signal to a new value, and notify any dependents.
            try {
                this.viewModel.set(viewModel);
                // Ensure the dynamically created view (and its value accessor)
                // is checked even though the host uses OnPush.
                if (this._componentRef?.changeDetectorRef) {
                    this._componentRef.changeDetectorRef.markForCheck();
                }
            } catch (error) {
                this.logError('Error updating view model.', error);
            }
        });
    }

    /**
     * Deep-clones arrays and plain objects, preserving functions and non-plain
     * objects by reference. Handles cycles through a `WeakMap`.
     */
    private cloneForMutation(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
        if (value == null || typeof value !== 'object') {
            return value;
        }

        const source = value as object;
        if (seen.has(source)) {
            return seen.get(source);
        }

        if (Array.isArray(value)) {
            const copy: unknown[] = [];
            seen.set(source, copy);
            for (const item of value) {
                copy.push(this.cloneForMutation(item, seen));
            }
            return copy;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype === Object.prototype || prototype === null) {
            const copy: Record<string, unknown> = {};
            seen.set(source, copy);
            for (const key of Object.keys(value as Record<string, unknown>)) {
                this.defineOwn(copy, key, this.cloneForMutation((value as Record<string, unknown>)[key], seen));
            }
            return copy;
        }

        // Class instances, Date, Map, DOM nodes, observables, ... are preserved.
        return value;
    }

    private setControlDisabled(disabled: boolean): void {
        if (!this._formControl) {
            return;
        }

        try {
            if (disabled && this._formControl.enabled) {
                this._formControl.disable({
                    onlySelf: true,
                    emitEvent: false
                });
            } else if (!disabled && this._formControl.disabled) {
                this._formControl.enable({
                    onlySelf: true,
                    emitEvent: false
                });
            }
        } catch (error) {
            this.logError('Error updating form control status.', error);
        }
    }

    /**
     * Restores the disabled state a control had before this component managed
     * it (important for pre-existing/reused controls and removed `disabled` keys).
     */
    private restoreManagedDisabledState(): void {
        if (!this._formControl || !this._disabledManaged) {
            return;
        }

        this.setControlDisabled(this._disabledBeforeManagement === true);
        this._disabledManaged = false;
        this._disabledBeforeManagement = undefined;
    }

    /**
     * Disables/enables the control, normalizing boolean-ish values, and restores
     * the previous state when the `disabled` key is removed.
     */
    private setFormControlStatus(): void {
        if (!this._formControl) {
            return;
        }

        const attributes = this.configuration()?.attributes;

        if (!attributes || !Object.hasOwn(attributes, 'disabled')) {
            this.restoreManagedDisabledState();
            return;
        }

        const disabledAttr = attributes['disabled'];
        const evaluated = this.evaluateExpression(disabledAttr, this.getViewModelValue());

        // Do not treat an unevaluated `$vm`/`$event` expression as `true`.
        if (this.isUnresolvedExpression(disabledAttr, evaluated)) {
            return;
        }

        const shouldDisable = this.toBoolean(evaluated);

        if (!this._disabledManaged) {
            this._disabledBeforeManagement = this._formControl.disabled;
            this._disabledManaged = true;
        }

        this.setControlDisabled(shouldDisable);
    }

    /**
     * Add synchronous validators to this control.
     */
    private setFormControlValidators(): void {
        if (!this._formControl) {
            return;
        }

        // Always remove previously managed validators, even when the current
        // configuration has no validator-bearing attributes.
        if (this._managedValidatorFns.length > 0) {
            try {
                this._formControl.removeValidators(this._managedValidatorFns);
            } catch (error) {
                this.logError('Error removing managed validators.', error);
            }
            
            this._managedValidatorFns = [];
            
            try {
                this._formControl.updateValueAndValidity({
                    onlySelf: true,
                    emitEvent: false
                });
            } catch (error) {
                this.logError('Error updating form control validity.', error);
            }
        }

        const attributes = this.configuration()?.attributes;
        if (attributes && Object.keys(attributes).length > 0 && this._componentRef?.location?.nativeElement) {
            const validators: ValidatorFn[] = [];
            // Validator that requires the control's value to be greater than or equal to the provided number.
            if (Object.hasOwn(attributes, 'min')) {
                const { value: min, unresolved } = this.evaluateAttribute(attributes, 'min');
                if (!unresolved && typeof(min) === 'number' && !isNaN(min)) {
                    validators.push(Validators.min(min));
                }
            }

            // Validator that requires the control's value to be less than or equal to the provided number.
            if (Object.hasOwn(attributes, 'max')) {
                const { value: max, unresolved } = this.evaluateAttribute(attributes, 'max');
                if (!unresolved && typeof(max) === 'number' && !isNaN(max)) {
                    validators.push(Validators.max(max));
                }
            }

            // Validator that requires the control have a non-empty value.
            if (Object.hasOwn(attributes, 'required')) {
                const { value: required, unresolved } = this.evaluateAttribute(attributes, 'required');
                if (!unresolved && required === true) {
                    validators.push(Validators.required);
                }
            }

            // Validator that requires the control's value pass an email validation test.
            if (Object.hasOwn(attributes, 'email')) {
                const { value: email, unresolved } = this.evaluateAttribute(attributes, 'email');
                if (!unresolved && email === true) {
                    validators.push(Validators.email);
                }
            }

            // Validator that requires the length of the control's value to be less than or equal to the provided maximum length.
            if (Object.hasOwn(attributes, 'maxlength')) {
                const { value: maxLength, unresolved } = this.evaluateAttribute(attributes, 'maxlength');
                if (!unresolved && typeof(maxLength) === 'number' && !isNaN(maxLength) && maxLength >= 0) {
                    validators.push(Validators.maxLength(maxLength));
                }
            }

            // Validator that requires the length of the control's value to be greater than or equal to the provided minimum length.
            if (Object.hasOwn(attributes, 'minlength')) {
                const { value: minLength, unresolved } = this.evaluateAttribute(attributes, 'minlength');
                if (!unresolved && typeof(minLength) === 'number' && !isNaN(minLength) && minLength >= 0) {
                    validators.push(Validators.minLength(minLength));
                }
            }

            // Validator that requires the control's value to match a regex pattern.
            // Configuration patterns are untrusted: cap their size and reject
            // nested quantifiers that can trigger catastrophic backtracking.
            if (Object.hasOwn(attributes, 'pattern')) {
                const { value: pattern, unresolved } = this.evaluateAttribute(attributes, 'pattern');
                const patternValidator = unresolved ? null : this.createPatternValidator(pattern);
                if (patternValidator) {
                    validators.push(patternValidator);
                }
            }

            // Track and add the newly built managed validators.
            if (validators.length > 0) {
                this._managedValidatorFns = validators;
                try {
                    this._formControl.addValidators(this._managedValidatorFns);
                } catch (error) {
                    this.logError('Error adding managed validators.', error);
                }
            } else {
                this._managedValidatorFns = [];
            }
            // Recalculates the value and validation status of the control whenever the
            // managed validator set changes (including when it becomes empty).
            try {
                this._formControl.updateValueAndValidity({
                    onlySelf: true,
                    emitEvent: false
                });
            } catch (error) {
                this.logError('Error updating form control validity.', error);
            }
        } else {
            this._managedValidatorFns = [];
        }
    }

    /**
     * Builds a defensive `pattern` validator. Invalid, oversized or potentially
     * catastrophic regular expressions are ignored instead of blocking the UI.
     */
    private createPatternValidator(pattern: unknown): ValidatorFn | null {
        let regex: RegExp;

        if (typeof pattern === 'string') {
            if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
                this.logWarning('Pattern validator was ignored because its source is empty or too long.');
                return null;
            }
            if (this.isUnsafeRegex(pattern)) {
                this.logWarning('Pattern validator was ignored because the expression is potentially unsafe.');
                return null;
            }

            try {
                const anchored = (pattern.startsWith('^') ? '' : '^') + pattern + (pattern.endsWith('$') ? '' : '$');
                regex = new RegExp(anchored);
            } catch (error) {
                this.logError('Pattern validator was ignored because the expression is invalid.', error);
                return null;
            }
        } else if (pattern instanceof RegExp) {
            if (pattern.source.length > MAX_PATTERN_LENGTH || this.isUnsafeRegex(pattern.source)) {
                this.logWarning('Pattern validator was ignored because the expression is potentially unsafe.');
                return null;
            }
            try {
                // Global/sticky regexes mutate `lastIndex` on every `test()` call,
                // which makes validation stateful. Clone without `g`/`y`.
                regex = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
            } catch (error) {
                this.logError('Pattern validator was ignored because the expression is invalid.', error);
                return null;
            }
        } else {
            return null;
        }

        const baseValidator = Validators.pattern(regex);

        return (control: AbstractControl): ValidationErrors | null => {
            const value = control.value;

            if (value == null) {
                return baseValidator(control);
            }
            if (typeof value !== 'string' && typeof value !== 'number') {
                return { pattern: { requiredPattern: regex.toString() } };
            }
            if (typeof value === 'string' && value.length > MAX_PATTERN_INPUT_LENGTH) {
                return { pattern: { requiredPattern: regex.toString() } };
            }

            return baseValidator(control);
        };
    }

    /**
     * Conservative scanner for regular expressions with nested/ambiguous
     * quantifiers (e.g. `(a+)+`, `(\d+(?:\d+)?)+`, `(a*)*`, `(\d+){2,}`) and
     * quantified alternations (e.g. `(a|aa)+`, `(\w|\d)+`) that can cause
     * exponential backtracking.
     *
     * Groups are tracked with an explicit stack, so nested groups and optional
     * inner quantifiers are detected instead of relying on a single regex.
     * This is still a heuristic: it errs on the side of rejecting ambiguous
     * constructs rather than allowing a catastrophic pattern through.
     */
    private isUnsafeRegex(source: string): boolean {
        if (source.length > MAX_PATTERN_LENGTH) {
            return true;
        }

        interface GroupState {
            hasQuantifier: boolean;
            hasAlternation: boolean;
        }

        const stack: GroupState[] = [{ hasQuantifier: false, hasAlternation: false }];
        let inCharacterClass = false;

        const isQuantifierAt = (index: number): boolean => {
            const character = source[index];
            if (character === '+' || character === '*') {
                return true;
            }
            if (character !== '{') {
                return false;
            }
            const match = /^\{\d+(?:,\d*)?\}/.exec(source.slice(index));
            if (!match) {
                return false;
            }
            // Very large bounded repetitions are also a CPU/memory hazard.
            const bounds = /^\{(\d+)(?:,(\d*))?\}/.exec(match[0]);
            if (bounds) {
                const upper = bounds[2] === undefined || bounds[2] === '' ? Infinity : Number(bounds[2]);
                if (Number.isFinite(upper) && upper > 10000) {
                    return true;
                }
            }
            return true;
        };

        for (let index = 0; index < source.length; index++) {
            const character = source[index];

            if (character === '\\') {
                const next = source[index + 1];
                if (next && /[1-9]/.test(next)) {
                    let cursor = index + 2;
                    while (cursor < source.length && /\d/.test(source[cursor])) {
                        cursor++;
                    }
                    if (isQuantifierAt(cursor)) {
                        return true;
                    }
                }
                index++;
                continue;
            }

            if (inCharacterClass) {
                if (character === ']') {
                    inCharacterClass = false;
                }
                continue;
            }

            if (character === '[') {
                inCharacterClass = true;
                continue;
            }

            if (character === '(') {
                stack.push({ hasQuantifier: false, hasAlternation: false });
                // Skip the `?` of `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` and
                // named capture group prefixes.
                if (source[index + 1] === '?') {
                    index++;
                }
                continue;
            }

            if (character === ')') {
                const group = stack.pop();
                if (group) {
                    const quantified = isQuantifierAt(index + 1);
                    if (quantified && (group.hasQuantifier || group.hasAlternation)) {
                        return true;
                    }

                    const parent = stack[stack.length - 1];
                    if (parent) {
                        if (quantified || group.hasQuantifier) {
                            parent.hasQuantifier = true;
                        }
                        if (group.hasAlternation) {
                            parent.hasAlternation = true;
                        }
                    }
                }
                continue;
            }

            if (character === '|') {
                stack[stack.length - 1].hasAlternation = true;
                continue;
            }

            if (character === '+' || character === '*' || character === '{' || character === '?') {
                // `?` is a quantifier when it follows a token, but not when it
                // belongs to a group prefix (`(?:`, `(?=`, …).
                if (character === '?' && source[index - 1] === '(') {
                    continue;
                }
                if (character === '{' && !/^\{\d+(?:,\d*)?\}/.test(source.slice(index))) {
                    continue;
                }
                if (character === '{' && isQuantifierAt(index)) {
                    const bounds = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(index));
                    const upper = bounds && bounds[2] !== undefined && bounds[2] !== '' ? Number(bounds[2]) : Infinity;
                    if (Number.isFinite(upper) && upper > 10000) {
                        return true;
                    }
                }
                stack[stack.length - 1].hasQuantifier = true;
            }
        }

        return false;
    }

    /**
     * Synchronizes a standalone FormControl instance to a form control element.
     */
    private attachFormControlDirective(): void {
        if (this._formControlDirective && this._componentRef?.injector && this._formControl) {
            try {
                const valueAccessors: ControlValueAccessor[] | null = this._componentRef.injector.get<ControlValueAccessor[] | null>(NG_VALUE_ACCESSOR, null);
                
                this._formControlDirective.valueAccessor = Array.isArray(valueAccessors) && valueAccessors.length > 0 ? valueAccessors[0] : null;
                this._formControlDirective.form = this._formControl;

                // A callback method that is invoked immediately after the default change detector has checked data-bound properties if at least one has changed, and before the view and content children are checked.
                this._formControlDirective.ngOnChanges({
                    form: {
                        firstChange: true,
                        currentValue: this._formControl,
                        previousValue: undefined,
                        isFirstChange: (): true => true
                    }
                });
            } catch (error) {
                this.logError('Error attaching form control directive.', error);
            }
        }
    }

    /**
     * Parses a dot/bracket path. Returns `null` when the path is malformed or
     * contains prototype-related segments (`__proto__`, `prototype`,
     * `constructor`), which protects both the view model and `FormGroup`.
     */
    private parsePath(property: Array<string> | string | null | undefined): string[] | null {
        if (property == null) {
            return null;
        }

        let pathArray: string[] | null = null;

        if (Array.isArray(property)) {
            pathArray = property
                .filter((segment: unknown): boolean => segment != null && segment !== '')
                .map((segment: unknown): string => String(segment));
        } else if (typeof property === 'string') {
            pathArray = this.parseStringPath(property);
        }

        if (!pathArray || pathArray.length === 0 || pathArray.length > MAX_PATH_DEPTH) {
            return null;
        }

        for (const segment of pathArray) {
            if (segment.length === 0 || segment.length > MAX_PATH_SEGMENT_LENGTH) {
                return null;
            }
            if (FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase())) {
                return null;
            }
        }

        return pathArray;
    }

    /**
     * Strictly parses `a.b`, `a[0]`, `a['b']` and `a["b"]`. Unbalanced brackets,
     * empty segments and stray characters are rejected instead of being silently
     * ignored.
     */
    private parseStringPath(property: string): string[] | null {
        const source = property.trim();
        if (source.length === 0) {
            return null;
        }

        const segments: string[] = [];
        let index = 0;
        let expectingSegment = true;

        while (index < source.length) {
            const character = source[index];

            if (character === '.') {
                if (expectingSegment) {
                    return null;
                }
                expectingSegment = true;
                index++;
                continue;
            }

            if (character === '[') {
                index++;
                let value = '';

                if (source[index] === '"' || source[index] === "'") {
                    const quote = source[index];
                    index++;
                    let closed = false;

                    while (index < source.length) {
                        const current = source[index];
                        if (current === '\\') {
                            if (index + 1 >= source.length) {
                                return null;
                            }
                            value += source[index + 1];
                            index += 2;
                            continue;
                        }
                        if (current === quote) {
                            index++;
                            closed = true;
                            break;
                        }
                        value += current;
                        index++;
                    }

                    if (!closed) {
                        return null;
                    }
                } else {
                    const start = index;
                    while (index < source.length && source[index] !== ']') {
                        if (source[index] === '[' || source[index] === '.') {
                            return null;
                        }
                        value += source[index];
                        index++;
                    }
                    if (index === start) {
                        return null;
                    }
                    value = value.trim();
                }

                if (source[index] !== ']' || value.length === 0) {
                    return null;
                }

                index++;
                segments.push(value);
                expectingSegment = false;
                continue;
            }

            if (!expectingSegment) {
                return null;
            }

            let value = '';
            while (index < source.length && source[index] !== '.' && source[index] !== '[') {
                value += source[index];
                index++;
            }

            if (value.length === 0) {
                return null;
            }

            segments.push(value);
            expectingSegment = false;
        }

        if (expectingSegment) {
            return null;
        }

        return segments;
    }

    private isSafePath(property: Array<string> | string): boolean {
        return this.parsePath(property) !== null;
    }

    private defineOwn(target: object, key: string, value: unknown): void {
        Object.defineProperty(target, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true
        });
    }

    /**
     * Only plain objects and arrays may be traversed/written by form
     * synchronization. This prevents writes into class instances, services and
     * DOM objects referenced by the view model.
     */
    private isMutableContainer(value: unknown): boolean {
        if (value == null || typeof value !== 'object') {
            return false;
        }
        if (Array.isArray(value)) {
            return true;
        }
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    /**
     * Gets the value at path of object. If the resolved value is undefined, the defaultValue is returned in its place.
     * Only own properties are read; prototype-chain reads are blocked.
     * @param model The object.
     * @param property The path.
     * @param defaultValue The resolved value.
     */
    private getModelPropertyValue(model: unknown, property: Array<string> | string, defaultValue: unknown): unknown {
        if (model == null) {
            return defaultValue;
        }

        const pathArray = this.parsePath(property);
        if (!pathArray) {
            return defaultValue;
        }

        try {
            let current: unknown = model;

            for (const key of pathArray) {
                if (current == null) {
                    return defaultValue;
                }
                const container = Object(current) as Record<string, unknown>;
                if (!Object.hasOwn(container, key)) {
                    return defaultValue;
                }
                current = container[key];
            }

            return current != null ? current : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    /**
     * Sets the value at path of object. If a portion of path doesn't exist, it's created.
     * Arrays are created for missing index properties while objects are created for all other missing properties.
     * Only own properties are traversed and written; prototype-related segments are rejected.
     * This method mutates object.
     * @param model The object.
     * @param property The path.
     * @param value The value.
     */
    private setModelPropertyValue(model: unknown, property: Array<string> | string, value: unknown): void {
        if (model == null) {
            return;
        }

        const pathArray = this.parsePath(property);
        if (!pathArray) {
            return;
        }

        try {
            let current: any = model;

            for (let index = 0; index < pathArray.length; index++) {
                const key = pathArray[index];
                const isLast = index === pathArray.length - 1;

                if (!this.isMutableContainer(current)) {
                    return;
                }

                if (isLast) {
                    this.defineOwn(current, key, value);
                    return;
                }

                const isNumericKey = /^\d+$/.test(key);
                const existing = Object.hasOwn(current, key) ? current[key] : undefined;

                if (existing == null) {
                    // Create array if key is numeric, otherwise object.
                    const next: unknown = isNumericKey ? [] : {};
                    this.defineOwn(current, key, next);
                    current = next;
                } else if (isNumericKey && !Array.isArray(existing)) {
                    // Preserve existing objects with numeric keys instead of
                    // discarding their data by replacing them with an array.
                    if (existing !== null && typeof existing === 'object') {
                        current = existing;
                    } else {
                        return;
                    }
                } else if (!isNumericKey && typeof existing !== 'object') {
                    const next: Record<string, unknown> = {};
                    this.defineOwn(current, key, next);
                    current = next;
                } else {
                    current = existing;
                }
            }
        } catch (error) {
            this.logError('Error setting model property value.', error);
        }
    }

    /**
     * Updates specified input names to new values and resets inputs that were
     * removed from the configuration.
     */
    private setInputs(): void {
        if (!this._componentRef) {
            return;
        }

        const inputs = this.configuration()?.inputs;
        const currentNames = inputs && typeof inputs === 'object' ? Object.keys(inputs) : [];

        for (const inputName of Array.from(this._appliedInputs)) {
            if (!currentNames.includes(inputName)) {
                try {
                    this._componentRef.setInput(inputName, undefined);
                } catch (error) {
                    this.logError(`Error resetting dynamic input "${inputName}".`, error);
                }
                this._appliedInputs.delete(inputName);
            }
        }

        if (!inputs || typeof inputs !== 'object') {
            return;
        }

        for (const inputName of currentNames) {
            try {
                // Updates a specified input name to a new value.
                this._componentRef.setInput(inputName, this.evaluateExpression(inputs[inputName], this.getViewModelValue()));
                this._appliedInputs.add(inputName);
            } catch (error) {
                this.logError(`Error setting dynamic input "${inputName}".`, error);
            }
        }
    }

    /**
     * Set attribute values for an element in the DOM.
     *
     * Attribute names and values are validated: event handlers (`on*`),
     * namespaced attributes, `style`/`srcdoc`/`formaction` and unsafe URL
     * schemes are never applied. Non-primitive values are ignored so that
     * configuration data cannot invoke `toString()`/`toJSON()` hooks.
     *
     * Attributes removed from the configuration (or set to a false boolean /
     * `null`) are removed from the element.
     */
    private setAttributes(): void {
        const attributes = this.configuration()?.attributes;
        const element = this._componentRef?.location?.nativeElement;

        if (!element) {
            return;
        }

        const currentNames = attributes && typeof attributes === 'object' ? Object.keys(attributes) : [];

        // Remove attributes that were applied previously but are now absent.
        for (const attributeName of Array.from(this._appliedAttributes)) {
            if (!currentNames.includes(attributeName) || !this.isAllowedAttribute(attributeName)) {
                this._renderer.removeAttribute(element, attributeName);
                this._appliedAttributes.delete(attributeName);
            }
        }

        if (!attributes || typeof attributes !== 'object') {
            return;
        }

        for (const attributeName of currentNames) {
            if (!this.isAllowedAttribute(attributeName)) {
                this.logWarning(`Attribute "${attributeName}" is not allowed and was skipped.`);
                continue;
            }

            try {
                const rawValue = attributes[attributeName];
                const value = this.evaluateExpression(rawValue, this.getViewModelValue());

                // An unresolved `$vm`/`$event` expression must not be written as
                // a literal attribute value (which would be truthy/visible).
                if (this.isUnresolvedExpression(rawValue, value)) {
                    continue;
                }

                const lower = attributeName.toLowerCase();

                if (BOOLEAN_ATTRIBUTES.has(lower)) {
                    if (!this.toBoolean(value)) {
                        this._renderer.removeAttribute(element, attributeName);
                        this._appliedAttributes.delete(attributeName);
                    } else if (element.getAttribute(attributeName) !== '') {
                        this._renderer.setAttribute(element, attributeName, '');
                        this._appliedAttributes.add(attributeName);
                    } else {
                        this._appliedAttributes.add(attributeName);
                    }
                    continue;
                }

                const stringValue = this.attributeValueToString(value);

                if (stringValue === undefined) {
                    continue;
                }

                if (stringValue === null) {
                    this._renderer.removeAttribute(element, attributeName);
                    this._appliedAttributes.delete(attributeName);
                    continue;
                }

                if (URL_ATTRIBUTES.has(lower) && !this.isSafeUrl(stringValue)) {
                    this.logWarning(`Unsafe URL for attribute "${attributeName}" was ignored.`);
                    continue;
                }

                // Returns element's first attribute whose qualified name is qualifiedName, and null if there is no such attribute otherwise.
                if (element.getAttribute(attributeName) !== stringValue) {
                    this._renderer.setAttribute(element, attributeName, stringValue);
                }
                this._appliedAttributes.add(attributeName);
            } catch (error) {
                this.logError(`Error setting dynamic attribute "${attributeName}".`, error);
            }
        }
    }

    private isAllowedAttribute(name: string): boolean {
        if (typeof name !== 'string' || name.length === 0 || name.length > MAX_ATTRIBUTE_NAME_LENGTH) {
            return false;
        }

        const lower = name.toLowerCase();

        if (lower.startsWith('on')) {
            return false;
        }

        // Reject namespaces, whitespace and other non-standard attribute names.
        if (!/^[a-z][a-z0-9_.-]*$/i.test(name)) {
            return false;
        }

        if (this.attributePolicy()?.strict === true && STRICT_DISALLOWED_ATTRIBUTES.has(lower)) {
            return false;
        }

        if (lower.startsWith('data-') || lower.startsWith('aria-')) {
            return true;
        }

        return ALLOWED_ATTRIBUTES.has(lower);
    }

    /**
     * Returns `undefined` to skip the attribute entirely, `null` to remove it,
     * or a safe string value.
     */
    private attributeValueToString(value: unknown): string | null | undefined {
        if (value == null) {
            return null;
        }

        const type = typeof value;

        if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'bigint') {
            this.logWarning('Non-primitive attribute values are ignored.');
            return undefined;
        }

        const stringValue = String(value);

        if (stringValue.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
            this.logWarning('Attribute value is too long and was ignored.');
            return undefined;
        }

        return stringValue;
    }

    private isSafeUrl(value: string): boolean {
        // Browsers ignore control characters and whitespace inside URL schemes.
        const normalized = value.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();

        if (normalized.length === 0) {
            return true;
        }

        const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized);

        if (!scheme) {
            // Relative URL, fragment or query string.
            return true;
        }

        return scheme[1] === 'http' || scheme[1] === 'https' || scheme[1] === 'mailto' || scheme[1] === 'tel';
    }

    /**
     * Evaluates a configured attribute value and reports whether it is an
     * expression that could not be evaluated because its context was missing.
     */
    private evaluateAttribute(attributes: Record<string, unknown>, name: string): { value: unknown; unresolved: boolean } {
        const raw = attributes[name];
        const value = this.evaluateExpression(raw, this.getViewModelValue());
        return { value, unresolved: this.isUnresolvedExpression(raw, value) };
    }

    /**
     * True when a string expression was returned verbatim because its `$vm` or
     * `$event` context was not available. Such values must not be treated as
     * literal booleans/attributes/control names.
     */
    private isUnresolvedExpression(source: unknown, result: unknown): boolean {
        return typeof source === 'string'
            && result === source
            && (source.includes('$vm') || source.includes('$event') || source.includes('$ev'));
    }

    /**
     * Normalizes boolean-ish configuration values. `false`, `'false'`, `0`,
     * `'0'`, `''`, `null` and `undefined` are false; everything else is true.
     */
    private toBoolean(value: unknown): boolean {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            return value !== 0 && !Number.isNaN(value);
        }
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            return normalized !== '' && normalized !== 'false' && normalized !== '0'
                && normalized !== 'null' && normalized !== 'undefined';
        }
        return value != null;
    }

    /**
     * Evaluates an expression with a small, allowlisted interpreter. No `eval`,
     * `Function` or other string-to-code primitive is used.
     * @param value The expression or literal value.
     * @param viewModelValue The resolved view model value.
     * @param eventParam The event payload.
     * @param hasEventContext Whether an event is currently being handled. This
     *        distinguishes "no event" from an output that emitted `null`/`undefined`.
     * @returns Evaluated expression, `undefined` when the expression is rejected,
     *          or the original value when it is a literal/unresolved expression.
     */
    private evaluateExpression(value: unknown, viewModelValue?: unknown, eventParam?: unknown, hasEventContext = false): unknown {
        if (typeof value !== 'string') {
            return value;
        }

        const hasVm = value.includes('$vm');
        const hasEvent = value.includes('$event') || value.includes('$ev');

        if (!hasVm && !hasEvent) {
            return value;
        }

        if (hasVm && viewModelValue == null) {
            return value;
        }

        if (hasEvent && !hasEventContext) {
            return value;
        }

        try {
            const policy = this.expressionPolicy() ?? {};
            const allowedMethods = new Set<string>(Array.isArray(policy.allowedMethods) ? policy.allowedMethods : []);

            // Expose the view model as a callable (`$vm()`). The ModelSignal
            // helpers are only attached when the host opts into mutation.
            const $vm: any = (): unknown => this.getViewModelValue();

            if (policy.allowViewModelMutation === true) {
                $vm.set = (nextValue: unknown): void => {
                    this.viewModel.set(nextValue);
                };
                $vm.update = (updateFn: (current: unknown) => unknown): void => {
                    this.viewModel.update(updateFn);
                };
                allowedMethods.add('set');
                allowedMethods.add('update');
            }

            return evaluateSafeExpression(value, {
                $vm,
                $event: eventParam,
                $ev: eventParam
            }, {
                allowCustomMethods: policy.allowCustomMethods === true,
                allowedMethods: Array.from(allowedMethods)
            });
        } catch {
            this.logWarning('Expression could not be evaluated safely and was ignored.');
            return undefined;
        }
    }

    private getViewModelValue(): unknown {
        const model = this.viewModel;
        return typeof model === 'function' ? (model as () => unknown)() : model;
    }

    private logWarning(message: string): void {
        if (isDevMode()) {
            console.warn(`[fg-dynamic] ${message}`);
        }
    }

    private logError(message: string, error?: unknown): void {
        if (!isDevMode()) {
            return;
        }
        const detail = error instanceof Error ? ` (${error.name})` : '';
        console.error(`[fg-dynamic] ${message}${detail}`);
    }

    /**
     * Cleans up every dynamically created resource: subscriptions, form control, value accessor directive and component reference.
     * Used both on component type change and on destroy.
     */
    private cleanup(): void {
        // Disposes the resources held by the output subscriptions.
        if (this._outputsSubscriptions) {
            this._outputsSubscriptions.forEach((s: { unsubscribe(): void }): void => {
                try {
                    s.unsubscribe();
                } catch (e) {
                    // Ignore
                }
            });
        }

        this._outputsSubscriptions = [];
        this._currentOutputsConfig = undefined;

        // Disposes the resources held by the form control subscription.
        if (this._formControlSubscription) {
            try {
                this._formControlSubscription.unsubscribe();
            } catch (e) {
                // Ignore
            }
        }

        this._formControlSubscription = undefined;

        // Restore the disabled state of reused controls before detaching.
        this.restoreManagedDisabledState();

        // A callback method that performs custom clean-up, invoked immediately before a directive, pipe, or service instance is destroyed.
        if (this._formControlDirective) {
            try {
                this._formControlDirective.ngOnDestroy();
            } catch (e) {
                // Ignore
            }
        }

        this._formControlDirective = undefined;

        // Remove the managed control from the exact group/key it was wired to.
        // Only owned controls are removed; pre-existing controls are left intact.
        if (this._ownsFormControl && this._formControl && this._formControlContainer && this._formControlKey) {
            try {
                if (this._formControlContainer.get(this._formControlKey) === this._formControl) {
                    this._formControlContainer.removeControl(this._formControlKey);
                }
            } catch (e) {
                // Ignore
            }
        }

        // Remove intermediate groups created for dotted names, deepest first,
        // but only if they are still empty and still attached to the parent.
        for (let index = this._createdFormGroups.length - 1; index >= 0; index--) {
            const { parent, key, group } = this._createdFormGroups[index];
            try {
                if (parent.get(key) === group && Object.keys(group.controls).length === 0) {
                    parent.removeControl(key);
                }
            } catch (e) {
                // Ignore
            }
        }

        this._createdFormGroups = [];
        this._formControl = undefined;
        this._formControlContainer = undefined;
        this._formControlKey = undefined;
        this._ownsFormControl = false;
        this._disabledManaged = false;
        this._disabledBeforeManagement = undefined;
        this._wiredFormGroup = undefined;
        this._wiredControlName = undefined;
        this._managedValidatorFns = [];
        this._appliedAttributes.clear();
        this._appliedInputs.clear();

        // Destroys the component instance and all of the data structures associated with it.
        if (this._componentRef) {
            try {
                this._componentRef.destroy();
            } catch (e) {
                // Ignore
            }
        }

        this._componentRef = undefined;
    }

    /**
     * A callback method that performs custom clean-up, invoked immediately before a directive, pipe, or service instance is destroyed.
     */
	ngOnDestroy(): void {
        this.cleanup();
	}
}
