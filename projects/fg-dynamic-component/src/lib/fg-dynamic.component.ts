import { ChangeDetectionStrategy, Component, ComponentRef, ElementRef, EventEmitter, Injector, InputSignal, ModelSignal, OnChanges, OnDestroy, Renderer2, Signal, SimpleChanges, Type, ViewContainerRef, computed, inject, input, isDevMode, model, viewChild, viewChildren } from '@angular/core';
import { AbstractControl, ControlValueAccessor, FormControl, FormControlDirective, FormGroup, NG_VALUE_ACCESSOR, NgControl, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';
import { Subscription } from 'rxjs';
import { evaluateSafeExpression } from './safe-expression';

export type FGDynamicType = Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>);

export interface IFGDynamicItem {
    type?: string | FGDynamicType;
    inputs?: Record<string, string | unknown>;
    outputs?: Record<string, string | Function>;
    attributes?: Record<string, string | unknown>;
    items?: IFGDynamicItem[];
}

const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PATH_DEPTH = 32;
const MAX_PATH_SEGMENT_LENGTH = 128;
const MAX_CONFIGURATION_ITEMS = 1000;
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
            <fg-dynamic #dynamicItem [configuration]="item" [(viewModel)]="viewModel" [formGroup]="formGroup()" [registry]="registry()" />
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

    /**
     * Validated child items. Invalid entries are ignored and the list is capped
     * to avoid pathological configurations blocking the renderer.
     */
    protected readonly items: Signal<readonly IFGDynamicItem[]> = computed((): readonly IFGDynamicItem[] => {
        const configuration = this.configuration();
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
	private _componentRef: ComponentRef<unknown>;
    private _renderer: Renderer2 = inject(Renderer2);
    private _outputsSubscriptions: Subscription[] = [];
    private _currentOutputsConfig?: Record<string, string | Function>;
    private _formControl: FormControl;
    private _formControlDirective: FormControlDirective;
    private _formControlSubscription: Subscription;
    private _managedValidatorFns: ValidatorFn[] = [];
    private _component: Type<unknown>;
    private _injector: Injector = inject(Injector);
    private _ngOnChangesCounter = 0;
    private _lastProjectedItemsSignature: string;

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
                return;
            }

            // Lazy-load a component.
            await this.loadComponentAsync();

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
            this.logError('Error during component initialization.', error);
        }
    }

    /**
     * A method to lazy-load a component.
     */
    private async loadComponentAsync(): Promise<void> {
        const configurationType = this.configuration()?.type;

        if (configurationType == null) {
            return;
        }

        let candidate: FGDynamicType | undefined;

        if (typeof configurationType === 'string') {
            candidate = this.getRegistry().get(configurationType);
            if (candidate == null) {
                this.logWarning(`Component type "${configurationType}" not found in the registry.`);
                return;
            }
        } else {
            candidate = configurationType;
        }

        try {
            const resolved = this.resolveCandidate(candidate);

            // Resolve synchronous types without an extra microtask hop so that
            // attribute/form updates happen within the same change-detection pass.
            const resolvedType = resolved instanceof Promise ? await resolved : resolved;

            // Only re-assign when the resolved type actually changed, so that subsequent
            // input/attribute updates don't tear down the already-instantiated component.
            if (resolvedType && this._component !== resolvedType) {
                this._component = resolvedType;
            }
        } catch (error) {
            this.logError('Unable to resolve the dynamic component type.', error);
        }
    }

    private resolveCandidate(candidate: unknown): Type<unknown> | Promise<Type<unknown> | undefined> | undefined {
        if (candidate == null) {
            return undefined;
        }

        if (candidate instanceof Promise) {
            return candidate.then((resolved: unknown): Type<unknown> | undefined => this.toComponentType(resolved));
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

            if (result instanceof Promise) {
                return result.then((resolved: unknown): Type<unknown> | undefined => this.toComponentType(resolved));
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
            const attributes = this.configuration()?.attributes;
            const nameAttr = attributes && Object.hasOwn(attributes, 'name') ? attributes['name'] : undefined;

            if (this.formGroup() && nameAttr != null && this.viewModel() != null) {
                const evaluatedName = this.evaluateExpression(nameAttr, this.viewModel);
                if (typeof evaluatedName === 'string' && this.isSafePath(evaluatedName)) {
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
                } else if (typeof evaluatedName === 'string') {
                    this.logWarning('Unsafe form control name was ignored.');
                }
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
            // Construct a FormControl with an initial value.
            this.createFormControl();
        }
    }

    /**
     * Register handlers for those events by subscribing to an instance.
     */
    private handleOutputs(): void {
        // Clean up existing subscriptions
        if (this._outputsSubscriptions && this._outputsSubscriptions.length > 0) {
            this._outputsSubscriptions.forEach((s: Subscription): void => {
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

                if (!(emitter instanceof EventEmitter)) {
                    continue;
                }

                this._outputsSubscriptions.push(emitter.subscribe(($event: unknown): void => {
                    try {
                        const expr = outputs[outputName];
                        const viewModelValue = this.getViewModelValue();
                        const result: unknown = typeof expr === 'string'
                            ? this.evaluateExpression(expr, this.viewModel, $event)
                            : expr;

                        if (typeof result === 'function') {
                            (result as Function).call(viewModelValue, $event);
                        } else if (typeof expr === 'function') {
                            (expr as Function).call(viewModelValue, $event);
                        }
                    } catch (error) {
                        this.logError('Error handling output.', error);
                    }
                }));
            }
        }
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
     * Construct a FormControl with an initial value.
     */
    private createFormControl(): void {
        const attributes = this.configuration()?.attributes;
        const nameAttr = attributes && Object.hasOwn(attributes, 'name') ? attributes['name'] : undefined;

        if (this.formGroup() && nameAttr != null && this.viewModel() != null) {
            const name = this.evaluateExpression(nameAttr, this.viewModel);

            if (typeof name === 'string' && name.length > 0 && this.isSafePath(name)) {
                const formGroup = this.formGroup();

                // Check if control with same name already exists
                const existingControl = formGroup.get(name);
                if (existingControl && existingControl !== this._formControl) {
                    this.logWarning('A form control with the requested name already exists; reusing it.');
                    this._formControl = existingControl as FormControl;
                    // Still need to attach directive if needed
                    if (this._formControlDirective) {
                        this.attachFormControlDirective();
                    }
                    return;
                }

                // Construct a FormControl with an initial value.
                this._formControl = new FormControl(this.getModelPropertyValue(this.viewModel(), name, null));

                // Add a control to this group.
                try {
                    if (existingControl === this._formControl) {
                        // Already added
                    } else if (existingControl) {
                        formGroup.setControl(name, this._formControl);
                    } else {
                        formGroup.addControl(name, this._formControl);
                    }
                } catch (error) {
                    this.logError('Error adding form control.', error);
                }

                // A multicasting observable that emits an event every time the value of the control changes, in the UI or programmatically.
                if (this._formControlSubscription) {
                    this._formControlSubscription.unsubscribe();
                }
                this._formControlSubscription = this._formControl.valueChanges.subscribe((value: unknown): void => {
                    // Creates a deep clone of an object, falling back to a JSON round-trip
                    // when the view model contains non-cloneable values (functions, DOM nodes, ...).
                    let viewModel: unknown;

                    try {
                        viewModel = structuredClone(this.viewModel());
                    } catch {
                        try {
                            viewModel = JSON.parse(JSON.stringify(this.viewModel()));
                        } catch {
                            viewModel = this.viewModel();
                        }
                    }

                    // Sets the value at path of object.
                    this.setModelPropertyValue(viewModel, name, value);
                    // Directly set the signal to a new value, and notify any dependents.
                    try {
                        this.viewModel.set(viewModel);
                    } catch (error) {
                        this.logError('Error updating view model.', error);
                    }
                });

                // Synchronizes a standalone FormControl instance to a form control element.
                this.attachFormControlDirective();
            } else if (typeof name === 'string') {
                this.logWarning('Unsafe form control name was ignored.');
            }
        }
    }

    /**
     * Disables/enables the control.
     */
    private setFormControlStatus(): void {
        if (!this._formControl) {
            return;
        }
        const attributes = this.configuration()?.attributes;
        if (!attributes) {
            return;
        }
        
        if (Object.hasOwn(attributes, 'disabled')) {
            const disabledAttr = attributes['disabled'];
            if (disabledAttr == null || disabledAttr === false || disabledAttr === '') {
                // Remove disabled state
                if (this._formControl.disabled) {
                    try {
                        this._formControl.enable({
                            onlySelf: true,
                            emitEvent: false
                        });
                    } catch (e) {
                        // Ignore
                    }
                }
                try {
                    this._formControl.updateValueAndValidity({ onlySelf: true, emitEvent: false });
                } catch (e) {
                }
                return;
            }
            // Evaluates JavaScript code and executes it.
            const isDisabled = this.evaluateExpression(disabledAttr, this.viewModel);
            if (isDisabled === true || (typeof isDisabled === 'string' && isDisabled === 'true')) {
                if (this._formControl.enabled || !this._formControl.disabled) {
                    try {
                        // Disables the control.
                        this._formControl.disable({
                            onlySelf: true,
                            emitEvent: false
                        });
                    } catch (e) {
                        // Ignore
                    }
                }
            } else if (isDisabled === false || isDisabled === '' || isDisabled === null || isDisabled === undefined || (typeof isDisabled === 'string' && isDisabled === 'false')) {
                if (this._formControl.disabled) {
                    try {
                        // Enables the control.
                        this._formControl.enable({
                            onlySelf: true,
                            emitEvent: false
                        });
                    } catch (e) {
                        // Ignore
                    }
                }
            } else if (typeof isDisabled === 'boolean') {
                if (isDisabled && this._formControl.enabled) {
                    try {
                        this._formControl.disable({
                            onlySelf: true,
                            emitEvent: false
                        });
                    } catch (e) {
                        // Ignore
                    }
                } else if (!isDisabled && this._formControl.disabled) {
                    try {
                        this._formControl.enable({
                            onlySelf: true,
                            emitEvent: false
                        });
                    } catch (e) {
                        // Ignore
                    }
                }
            }
        }
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
            } catch (e) {
                // Ignore
            }
            
            this._managedValidatorFns = [];
            
            try {
                this._formControl.updateValueAndValidity({
                    onlySelf: true,
                    emitEvent: false
                });
            } catch (e) {
                // Ignore
            }
        }

        const attributes = this.configuration()?.attributes;
        if (attributes && Object.keys(attributes).length > 0 && this._componentRef?.location?.nativeElement) {
            const validators: ValidatorFn[] = [];
            // Validator that requires the control's value to be greater than or equal to the provided number.
            if (Object.hasOwn(attributes, 'min')) {
                const min = this.evaluateExpression(attributes['min'], this.viewModel);
                if (typeof(min) === 'number' && !isNaN(min)) {
                    validators.push(Validators.min(min));
                }
            }

            // Validator that requires the control's value to be less than or equal to the provided number.
            if (Object.hasOwn(attributes, 'max')) {
                const max = this.evaluateExpression(attributes['max'], this.viewModel);
                if (typeof(max) === 'number' && !isNaN(max)) {
                    validators.push(Validators.max(max));
                }
            }

            // Validator that requires the control have a non-empty value.
            if (Object.hasOwn(attributes, 'required')) {
                const required = this.evaluateExpression(attributes['required'], this.viewModel);
                if (required === true) {
                    validators.push(Validators.required);
                }
            }

            // Validator that requires the control's value pass an email validation test.
            if (Object.hasOwn(attributes, 'email')) {
                const email = this.evaluateExpression(attributes['email'], this.viewModel);
                if (email === true) {
                    validators.push(Validators.email);
                }
            }

            // Validator that requires the length of the control's value to be less than or equal to the provided maximum length.
            if (Object.hasOwn(attributes, 'maxlength')) {
                const maxLength = this.evaluateExpression(attributes['maxlength'], this.viewModel);
                if (typeof(maxLength) === 'number' && !isNaN(maxLength) && maxLength >= 0) {
                    validators.push(Validators.maxLength(maxLength));
                }
            }

            // Validator that requires the length of the control's value to be greater than or equal to the provided minimum length.
            if (Object.hasOwn(attributes, 'minlength')) {
                const minLength = this.evaluateExpression(attributes['minlength'], this.viewModel);
                if (typeof(minLength) === 'number' && !isNaN(minLength) && minLength >= 0) {
                    validators.push(Validators.minLength(minLength));
                }
            }

            // Validator that requires the control's value to match a regex pattern.
            // Configuration patterns are untrusted: cap their size and reject
            // nested quantifiers that can trigger catastrophic backtracking.
            if (Object.hasOwn(attributes, 'pattern')) {
                const pattern = this.evaluateExpression(attributes['pattern'], this.viewModel);
                const patternValidator = this.createPatternValidator(pattern);
                if (patternValidator) {
                    validators.push(patternValidator);
                }
            }

            // Track and add the newly built managed validators.
            if (validators.length > 0) {
                this._managedValidatorFns = validators;
                try {
                    this._formControl.addValidators(this._managedValidatorFns);
                } catch (e) {
                    // Ignore
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
            } catch (e) {
                // Ignore
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
            regex = pattern;
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
     * Heuristic check for regular expressions with nested/ambiguous quantifiers
     * (e.g. `(a+)+`, `(a*)*`, `(\d+){2,}`) that can cause exponential backtracking.
     */
    private isUnsafeRegex(source: string): boolean {
        if (source.length > MAX_PATTERN_LENGTH) {
            return true;
        }
        if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d)/.test(source)) {
            return true;
        }
        if (/\\[1-9][+*{]/.test(source)) {
            return true;
        }
        if (/\((?:\.\*|\.\+)[^)]*\)[+*{]/.test(source)) {
            return true;
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
            // Regex: ensure that we do not have '.' and brackets inside a segment.
            pathArray = property.match(/([^[.\]])+/g);
        }

        if (!pathArray || pathArray.length === 0 || pathArray.length > MAX_PATH_DEPTH) {
            return null;
        }

        for (const segment of pathArray) {
            if (segment.length > MAX_PATH_SEGMENT_LENGTH) {
                return null;
            }
            if (FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase())) {
                return null;
            }
        }

        return pathArray;
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

                if (current == null || (typeof current !== 'object' && typeof current !== 'function')) {
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
                    // Try to convert to array if needed.
                    if (typeof existing !== 'object') {
                        return;
                    }
                    const next: unknown[] = [];
                    this.defineOwn(current, key, next);
                    current = next;
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
     * Updates specified input names to new values.
     */
    private setInputs(): void {
        const inputs = this.configuration()?.inputs;

        if (!inputs || typeof inputs !== 'object' || !this._componentRef) {
            return;
        }

        for (const inputName of Object.keys(inputs)) {
            try {
                // Updates a specified input name to a new value.
                this._componentRef.setInput(inputName, this.evaluateExpression(inputs[inputName], this.viewModel));
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
     */
    private setAttributes(): void {
        const attributes = this.configuration()?.attributes;
        const element = this._componentRef?.location?.nativeElement;

        if (!attributes || typeof attributes !== 'object' || !element) {
            return;
        }

        for (const attributeName of Object.keys(attributes)) {
            if (!this.isAllowedAttribute(attributeName)) {
                this.logWarning(`Attribute "${attributeName}" is not allowed and was skipped.`);
                continue;
            }

            try {
                const value = this.evaluateExpression(attributes[attributeName], this.viewModel);
                const stringValue = this.attributeValueToString(value);

                if (stringValue === undefined) {
                    continue;
                }

                // Returns element's first attribute whose qualified name is qualifiedName, and null if there is no such attribute otherwise.
                const currentAttr = element.getAttribute(attributeName) as string | null;
                if (stringValue === currentAttr) {
                    continue;
                }

                if (stringValue === null) {
                    this._renderer.removeAttribute(element, attributeName);
                    continue;
                }

                if (URL_ATTRIBUTES.has(attributeName.toLowerCase()) && !this.isSafeUrl(stringValue)) {
                    this.logWarning(`Unsafe URL for attribute "${attributeName}" was ignored.`);
                    continue;
                }

                this._renderer.setAttribute(element, attributeName, stringValue);
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
     * Evaluates an expression with a small, allowlisted interpreter. No `eval`,
     * `Function` or other string-to-code primitive is used.
     * @param value The expression or literal value.
     * @param vmParam The view model (signal or plain value).
     * @param eventParam The event payload.
     * @returns Evaluated expression, `undefined` when the expression is rejected,
     *          or the original value when it is a literal.
     */
    private evaluateExpression(value: unknown, vmParam?: unknown, eventParam?: unknown): unknown {
        if (typeof value !== 'string') {
            return value;
        }

        const hasVm = value.includes('$vm');
        const hasEvent = value.includes('$event');

        if (!hasVm && !hasEvent) {
            return value;
        }

        if ((hasVm && vmParam == null) || (hasEvent && eventParam == null)) {
            return value;
        }

        try {
            const viewModelInput = vmParam;
            const $vm = typeof viewModelInput === 'function' ? viewModelInput : (): unknown => viewModelInput;

            return evaluateSafeExpression(value, {
                $vm,
                $event: eventParam,
                $ev: eventParam
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
            this._outputsSubscriptions.forEach((s: Subscription): void => {
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

        // Remove the managed control from the form group.
        if (this._formControl && this.formGroup()) {
            try {
                const attributes = this.configuration()?.attributes;
                const attributeName = attributes?.['name'];

                if (attributeName) {
                    const controlName = this.evaluateExpression(attributeName, this.viewModel) as string;

                    // Only remove the control if it is the one this component created, so that
                    // a pre-existing control registered under the same name is left untouched.
                    // Unsafe names (prototype segments) are never passed to `FormGroup`.
                    if (typeof controlName === 'string' && controlName.length > 0 && this.isSafePath(controlName)) {
                        const formGroup = this.formGroup();
                        if (formGroup.get(controlName) === this._formControl) {
                            try {
                                formGroup.removeControl(controlName);
                            } catch (e) {
                                // Ignore
                            }
                        }
                    }
                }
            } catch (e) {
                // Ignore
            }
        }

        this._formControl = undefined;
        this._managedValidatorFns = [];

        // A callback method that performs custom clean-up, invoked immediately before a directive, pipe, or service instance is destroyed.
        if (this._formControlDirective) {
            try {
                this._formControlDirective.ngOnDestroy();
            } catch (e) {
                // Ignore
            }
        }

        this._formControlDirective = undefined;

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
