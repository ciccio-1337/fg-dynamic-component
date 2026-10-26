import { ChangeDetectionStrategy, Component, ComponentRef, ElementRef, EventEmitter, Injector, InputSignal, ModelSignal, OnChanges, OnDestroy, Renderer2, Signal, SimpleChanges, Type, ViewContainerRef, inject, input, model, viewChild, viewChildren } from '@angular/core';
import { ControlValueAccessor, FormControl, FormControlDirective, FormGroup, NG_VALUE_ACCESSOR, NgControl, ValidatorFn, Validators } from '@angular/forms';
import { Subscription } from 'rxjs';

export interface IFGDynamicItem {
    type?: string | Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>);
    inputs?: Record<string, string | unknown>;
    outputs?: Record<string, string | Function>;
    attributes?: Record<string, string | unknown>;
    items?: IFGDynamicItem[];
}

/**
 * Declare components to dynamically load in static and/or dynamic way using the FGDynamicService.
 */
export class FGDynamicService {
    private static _components: Record<string, Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>)> = {};

    static registerComponent(name: string, type: Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>)): void {
        if (name && type) {
            FGDynamicService._components[name] = type;
        }
    }

    static getComponent(name: string): Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>) {
        return FGDynamicService._components[name];
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
        @for (item of configuration()?.items; track $index) {
            <fg-dynamic #dynamicItem [configuration]="item" [(viewModel)]="viewModel" [formGroup]="formGroup()" />
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
            // Lazy-load a component.
            await this.loadComponentAsync();

            if (counter !== this._ngOnChangesCounter) {
                return;
            }

            // If projected items changed, we need to recreate the component to update projectableNodes
            const items = this.configuration()?.items;
            const itemsSignature = items ? `${items.length}:${items.map((i, idx) => `${idx}:${i?.type}`).join('|')}` : '';
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
            console.error('[fg-dynamic] Error during component initialization:', error);
        }
    }

    /**
     * A method to lazy-load a component.
     */
    private async loadComponentAsync(): Promise<void> {
        const configurationType: string | Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>) = this.configuration()?.type;

        if (configurationType != null) {
            const requestedType: Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>) | undefined = typeof configurationType === 'string'
                ? FGDynamicService.getComponent(configurationType)
                : configurationType as Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>);

            if (requestedType == null && typeof configurationType !== 'string') {
                // Maybe it's passed directly
            }
            if (requestedType == null && typeof configurationType === 'string') {
                console.warn(`[fg-dynamic] Component type "${configurationType}" not found in FGDynamicService registry.`);
                return;
            }

            const toResolve = requestedType == null && typeof configurationType !== 'string' ? configurationType : requestedType;

            let resolvedType: Type<unknown>;

            if (typeof toResolve === 'function') {
                // Try to invoke as a lazy loader function: () => Promise<Type<unknown>>
                try {
                    const result: unknown = (toResolve as () => unknown)();

                    if (result instanceof Promise) {
                        resolvedType = await result;
                    } else if (typeof result === 'function') {
                        // Could be a constructor - check if it's constructable by trying
                        resolvedType = result as Type<unknown>;
                    } else {
                        // Not a loader function, treat it as a direct Type
                        resolvedType = toResolve as Type<unknown>;
                    }
                } catch (error) {
                    console.warn('[fg-dynamic] Failed to invoke loader function, treating as component type:', error);
                    // Not a lazy loader function, treat it as a direct Type
                    resolvedType = toResolve as Type<unknown>;
                }
            } else if (toResolve instanceof Promise) {
                resolvedType = await toResolve;
            } else {
                resolvedType = toResolve as Type<unknown>;
            }

            // Only re-assign when the resolved type actually changed, so that subsequent
            // input/attribute updates don't tear down the already-instantiated component.
            if (this._component !== resolvedType) {
                this._component = resolvedType;
            }
        }
    }

    /**
     * Instantiates a single component and inserts its host view into this container.
     */
    private createComponent(): void {
        // If the component type changed, clean up and recreate it.
        if (this._componentRef && this._component !== this._componentRef.componentType) {
            this.cleanup();
        }

        if (this._component && !this._componentRef && this._viewContainerRef() && !this._formControlDirective) {
            let injector: Injector | undefined = undefined;

            if (this.formGroup() && this.configuration()?.attributes && this.configuration().attributes['name'] && this.viewModel() != null) {
                const nameAttr = this.configuration().attributes['name'];
                const evaluatedName = this.evaluateExpression(nameAttr, this.viewModel);
                if (typeof(evaluatedName) === 'string') {
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

        if (outputs && Object.keys(outputs).length > 0 && this._componentRef?.instance) {
            for (const outputName in outputs) {
                if (outputs.hasOwnProperty(outputName) && this._componentRef.instance[outputName] instanceof EventEmitter) {
                    this._outputsSubscriptions.push(this._componentRef.instance[outputName].subscribe(($event: unknown): void => {
                        try {
                            // Evaluates JavaScript code and executes it.
                            const expr = outputs[outputName];
                            const result: unknown = this.evaluateExpression(expr, this.viewModel, $event);

                            if (typeof result === 'function') {
                                // Executes a function.
                                try {
                                    (result as Function).call(this.viewModel(), $event);
                                } catch (e) {
                                    (result as Function)($event);
                                }
                            } else if (typeof expr === 'function') {
                                try {
                                    (expr as Function).call(this.viewModel(), $event);
                                } catch (e) {
                                    (expr as Function)($event);
                                }
                            } else if (typeof expr === 'string') {
                                try {
                                    const vmParam = (this as any).viewModel;
                                    const evParam = $event;
                                    const vmVal = typeof vmParam === 'function' ? vmParam() : (vmParam && typeof vmParam === 'object' && typeof (vmParam as any)() === 'function' ? (vmParam as any)() : vmParam);
                                    const $vm = typeof vmParam === 'function' ? vmParam : (() => vmVal);
                                    const $ev = evParam;
                                    const fn = (0, eval)('(' + expr.replace(/\$event/g, '$ev') + ')');
                                    if (typeof fn === 'function') {
                                        fn.call(vmVal || (typeof $vm === 'function' ? $vm() : $vm), evParam);
                                    }
                                } catch (e) {
                                    // ignore
                                }
                            }
                        } catch (error) {
                            console.error('[fg-dynamic] Error handling output:', error);
                        }
                    }));
                }
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
        if (this.formGroup() && this.configuration()?.attributes && this.configuration().attributes['name'] && this.viewModel() != null) {
            // Evaluates JavaScript code and executes it.
            const nameAttr = this.configuration().attributes['name'];
            const name = this.evaluateExpression(nameAttr, this.viewModel) as string;

            if (typeof(name) === 'string' && name.length > 0) {
                const formGroup = this.formGroup();
                
                // Check if control with same name already exists
                const existingControl = formGroup.get(name);
                if (existingControl && existingControl !== this._formControl) {
                    console.warn(`[fg-dynamic] Form control with name "${name}" already exists in FormGroup. Using existing control.`);
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
                    console.error('[fg-dynamic] Error adding form control:', error);
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
                        console.error('[fg-dynamic] Error updating view model:', error);
                    }
                });

                // Synchronizes a standalone FormControl instance to a form control element.
                this.attachFormControlDirective();
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
        
        if (attributes.hasOwnProperty('disabled')) {
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
                return;
            }
            // Evaluates JavaScript code and executes it.
            const isDisabled = this.evaluateExpression(disabledAttr, this.viewModel);
            if (typeof(isDisabled) === 'boolean') {
                if (isDisabled && this._formControl.enabled) {
                    try {
                        // Disables the control.
                        this._formControl.disable({
                            onlySelf: true,
                            emitEvent: false
                        });
                    } catch (e) {
                        // Ignore
                    }
                } else if (!isDisabled && this._formControl.disabled) {
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
            if (attributes.hasOwnProperty('min')) {
                const min = this.evaluateExpression(attributes['min'], this.viewModel);
                if (typeof(min) === 'number' && !isNaN(min)) {
                    validators.push(Validators.min(min));
                }
            }

            // Validator that requires the control's value to be less than or equal to the provided number.
            if (attributes.hasOwnProperty('max')) {
                const max = this.evaluateExpression(attributes['max'], this.viewModel);
                if (typeof(max) === 'number' && !isNaN(max)) {
                    validators.push(Validators.max(max));
                }
            }

            // Validator that requires the control have a non-empty value.
            if (attributes.hasOwnProperty('required')) {
                const required = this.evaluateExpression(attributes['required'], this.viewModel);
                if (required === true) {
                    validators.push(Validators.required);
                }
            }

            // Validator that requires the control's value pass an email validation test.
            if (attributes.hasOwnProperty('email')) {
                const email = this.evaluateExpression(attributes['email'], this.viewModel);
                if (email === true) {
                    validators.push(Validators.email);
                }
            }

            // Validator that requires the length of the control's value to be less than or equal to the provided maximum length.
            if (attributes.hasOwnProperty('maxlength')) {
                const maxLength = this.evaluateExpression(attributes['maxlength'], this.viewModel);
                if (typeof(maxLength) === 'number' && !isNaN(maxLength) && maxLength >= 0) {
                    validators.push(Validators.maxLength(maxLength));
                }
            }

            // Validator that requires the length of the control's value to be greater than or equal to the provided minimum length.
            if (attributes.hasOwnProperty('minlength')) {
                const minLength = this.evaluateExpression(attributes['minlength'], this.viewModel);
                if (typeof(minLength) === 'number' && !isNaN(minLength) && minLength >= 0) {
                    validators.push(Validators.minLength(minLength));
                }
            }

            // Validator that requires the control's value to match a regex pattern.
            if (attributes.hasOwnProperty('pattern')) {
                const pattern = this.evaluateExpression(attributes['pattern'], this.viewModel);
                if (typeof(pattern) === 'string' && pattern.length > 0) {
                    validators.push(Validators.pattern(pattern));
                } else if (pattern instanceof RegExp) {
                    validators.push(Validators.pattern(pattern));
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
                console.error('[fg-dynamic] Error attaching form control directive:', error);
            }
        }
    }

    /**
     * Gets the value at path of object. If the resolved value is undefined, the defaultValue is returned in its place.
     * @param model The object.
     * @param property The path.
     * @param defaultValue The resolved value.
     */
    private getModelPropertyValue(model: unknown, property: Array<string> | string, defaultValue: unknown): unknown {
        // If path is not defined or it has false value
        if (!property) {
            return defaultValue;
        }

        if (model == null) {
            return defaultValue;
        }

        // Check if path is string or array. Regex : ensure that we do not have '.' and brackets.
        let pathArray: string[] | null = null;
        if (Array.isArray(property)) {
            pathArray = property.filter(p => p != null && p !== '');
        } else if (typeof property === 'string') {
            const matches = property.match(/([^[.\]])+/g);
            pathArray = matches;
        }

        if (!pathArray || pathArray.length === 0) {
            return defaultValue;
        }

        try {
            // Find value
            const result: unknown = pathArray.reduce((prevObj: any, key: string): unknown => {
                if (prevObj == null) {
                    return undefined;
                }
                return prevObj[key];
            }, model);

            // If found value is undefined return default value; otherwise return the value
            return result != null ? result : defaultValue;
        } catch (error) {
            console.error('[fg-dynamic] Error getting model property value:', error);
            return defaultValue;
        }
    }

    /**
     * Sets the value at path of object. If a portion of path doesn't exist, it's created.
     * Arrays are created for missing index properties while objects are created for all other missing properties.
     * This method mutates object.
     * @param model The object.
     * @param property The path.
     * @param value The value.
     */
    private setModelPropertyValue(model: unknown, property: Array<string> | string, value: unknown): void {
        if (!property || model == null) {
            return;
        }

        let pathArray: string[] | null = null;
        if (Array.isArray(property)) {
            pathArray = property.filter(p => p != null && p !== '');
        } else if (typeof property === 'string') {
            const matches = property.match(/([^[.\]])+/g);
            pathArray = matches;
        }

        if (!pathArray || pathArray.length === 0) {
            return;
        }

        try {
            pathArray.reduce((acc: any, key: string, i: number): unknown => {
                if (acc == null || typeof acc !== 'object') {
                    return acc;
                }

                const isLast = i === pathArray.length - 1;
                const isNumericKey = /^\d+$/.test(key);

                if (isLast) {
                    acc[key] = value;
                    return acc[key];
                }

                if (acc[key] === undefined || acc[key] === null) {
                    // Create array if key is numeric, otherwise object
                    acc[key] = isNumericKey ? [] : {};
                } else if (isNumericKey && !Array.isArray(acc[key])) {
                    // Try to convert to array if needed
                    if (typeof acc[key] === 'object') {
                        acc[key] = [];
                    }
                } else if (!isNumericKey && typeof acc[key] !== 'object') {
                    acc[key] = {};
                }

                return acc[key];
            }, model);
        } catch (error) {
            console.error('[fg-dynamic] Error setting model property value:', error);
        }
    }

    /**
     * Updates specified input names to new values.
     */
    private setInputs(): void {
        if (this.configuration()?.inputs && Object.keys(this.configuration().inputs).length > 0 && this._componentRef) {
            const inputs = this.configuration().inputs;
            for (const inputName in inputs) {
                if (inputs.hasOwnProperty(inputName)) {
                    try {
                        // Updates a specified input name to a new value.
                        this._componentRef.setInput(inputName, this.evaluateExpression(inputs[inputName], this.viewModel));
                    } catch (error) {
                        console.error(`[fg-dynamic] Error setting input ${inputName}:`, error);
                    }
                }
            }
        }
    }

    /**
     * Set attribute values for an element in the DOM.
     */
    private setAttributes(): void {
        if (this.configuration()?.attributes && Object.keys(this.configuration().attributes).length > 0 && this._componentRef?.location?.nativeElement) {
            const attributes = this.configuration().attributes;
            for (const attributeName in attributes) {
                if (attributes.hasOwnProperty(attributeName)) {
                    try {
                        // Evaluates JavaScript code and executes it.
                        const value = this.evaluateExpression(attributes[attributeName], this.viewModel);
                        // Convert non-string values to their string form; null/undefined mean "remove the attribute".
                        const stringValue: string | null = value != null ? String(value) : null;

                        // Returns element's first attribute whose qualified name is qualifiedName, and null if there is no such attribute otherwise.
                        const currentAttr = this._componentRef.location.nativeElement.getAttribute(attributeName);
                        if (stringValue !== currentAttr) {
                            // Implement this callback to set an attribute value for an element in the DOM.
                            if (stringValue != null) {
                                this._renderer.setAttribute(this._componentRef.location.nativeElement, attributeName, stringValue);
                            } else {
                                this._renderer.removeAttribute(this._componentRef.location.nativeElement, attributeName);
                            }
                        }
                    } catch (error) {
                        console.error(`[fg-dynamic] Error setting attribute ${attributeName}:`, error);
                    }
                }
            }
        }
    }

    /**
     * Evaluates JavaScript code and executes it.
     * @param value The JavaScript code.
     * @param $vm The view model.
     * @param $event The event.
     * @returns Evaluated expression.
     */
    private evaluateExpression(value: unknown, vmParam?: any, eventParam?: unknown): unknown {
        if (typeof(value) === 'string') {
            const hasVm = value.includes('$vm');
            const hasEvent = value.includes('$event');
            if ((hasVm && vmParam != null) || (hasEvent && eventParam != null)) {
                try {
                    // NOTE: This uses eval() by design to support expression binding via the $vm and $event placeholders.
                    const vmInput = vmParam;
                    const evInput = eventParam;
                    const vmVal = typeof vmInput === 'function' ? vmInput() : vmInput;
                    const $vm = typeof vmInput === 'function' ? vmInput : (() => vmVal);
                    const $event = evInput;
                    // Use indirect eval
                    const result = (0, eval)(value);
                    return result;
                } catch (error) {
                    try {
                        const vmInput = vmParam;
                        const evInput = eventParam;
                        const vmVal = typeof vmInput === 'function' ? vmInput() : vmInput;
                        const $vm = () => vmVal;
                        const $ev2 = evInput;
                        const result = (0, eval)(value.replace(/\$event/g, '$ev2'));
                        return result;
                    } catch (error2) {
                        console.error('[fg-dynamic] Error evaluating expression:', error2);
                        return undefined;
                    }
                }
            }
        }
        return value;
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
                    if (typeof controlName === 'string' && controlName.length > 0) {
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
