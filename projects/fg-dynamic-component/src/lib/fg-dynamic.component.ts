import { ChangeDetectionStrategy, Component, ComponentRef, ElementRef, EventEmitter, Injector, InputSignal, ModelSignal, OnChanges, OnDestroy, Renderer2, Signal, Type, ViewContainerRef, inject, input, model, viewChild, viewChildren } from '@angular/core';
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
    private _formControl: FormControl;
    private _formControlDirective: FormControlDirective;
    private _formControlSubscription: Subscription;
    private _managedValidatorFns: ValidatorFn[] = [];
    private _component: Type<unknown>;
    private _injector: Injector = inject(Injector);

    /**
     * A callback method that is invoked immediately after the default change
     * detector has checked data-bound properties if at least one has changed,
     * and before the view and content children are checked.
     */
    async ngOnChanges(): Promise<void> {
        // Lazy-load a component.
        await this.loadComponentAsync();
        // Instantiates a single component and inserts its host view into this container.
        this.createComponent();
        // Updates specified input names to new values.
        this.setInputs();
        // Disables/enables the control.
        this.setFormControlStatus();
        // Add synchronous validators to this control.
        this.setFormControlValidators();
        // Set attribute values for an element in the DOM.
        this.setAttributes();
    }

    /**
     * A method to lazy-load a component.
     */
    private async loadComponentAsync(): Promise<void> {
        const configurationType: string | Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>) = this.configuration().type;

        if (configurationType != null) {
            const requestedType: Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>) | undefined = typeof configurationType === 'string'
                ? FGDynamicService.getComponent(configurationType)
                : configurationType as Type<unknown> | Promise<Type<unknown>> | (() => Promise<Type<unknown>>);

            if (requestedType == null) {
                return;
            }

            let resolvedType: Type<unknown>;

            if (typeof requestedType === 'function') {
                // Try to invoke as a lazy loader function: () => Promise<Type<unknown>>
                try {
                    const result: Promise<Type<unknown>> = (requestedType as () => Promise<Type<unknown>>)();

                    resolvedType = result instanceof Promise ? await result : result as Type<unknown>;
                } catch {
                    // Not a lazy loader function, treat it as a direct Type
                    resolvedType = requestedType as Type<unknown>;
                }
            } else if (requestedType instanceof Promise) {
                resolvedType = await requestedType;
            } else {
                resolvedType = requestedType as Type<unknown>;
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
            let injector: Injector;

            if (this.formGroup() && this.configuration()?.attributes && this.configuration().attributes['name'] && typeof(this.evaluateExpression(this.configuration().attributes['name'], this.viewModel)) === 'string' && this.viewModel()) {
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
            this._componentRef = this._viewContainerRef().createComponent(this._component, {
                projectableNodes: this._dynamicItems()?.length > 0 ? [this._dynamicItems().map((e: ElementRef<unknown>): Node => e.nativeElement as Node)] : undefined,
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
        if (this.configuration()?.outputs && Object.keys(this.configuration().outputs).length > 0 && this._componentRef?.instance) {
            for (const outputName in this.configuration().outputs) {
                if (this._componentRef.instance[outputName] instanceof EventEmitter) {
                    this._outputsSubscriptions.push(this._componentRef.instance[outputName].subscribe(($event: unknown): void => {
                        // Evaluates JavaScript code and executes it.
                        const result: unknown = this.evaluateExpression(this.configuration().outputs[outputName], this.viewModel, $event);

                        if (result instanceof Function) {
                            // Executes a function.
                            result($event);
                        }
                    }));
                }
            }
        }
    }

    /**
     * Construct a FormControl with an initial value.
     */
    private createFormControl(): void {
        if (this.formGroup() && this.configuration()?.attributes && this.configuration().attributes['name'] && this.viewModel()) {
            // Evaluates JavaScript code and executes it.
            const name = this.evaluateExpression(this.configuration().attributes['name'], this.viewModel) as string;

            if (typeof(name) === 'string') {
                // Construct a FormControl with an initial value.
                this._formControl = new FormControl(this.getModelPropertyValue(this.viewModel(), name, null));

                // Add a control to this group. In a strongly-typed group, the control must be in the group's type (possibly as an optional key).
                // If a control with a given name already exists, it would not be replaced with a new one.
                // If you want to replace an existing control, use the FormGroup#setControl setControl method instead.
                // This method also updates the value and validity of the control.
                this.formGroup().addControl(name, this._formControl);

                // A multicasting observable that emits an event every time the value of the control changes, in the UI or programmatically.
                this._formControlSubscription = this._formControl.valueChanges.subscribe((value: unknown): void => {
                    // Creates a deep clone of an object, falling back to a JSON round-trip
                    // when the view model contains non-cloneable values (functions, DOM nodes, ...).
                    let viewModel: unknown;

                    try {
                        viewModel = structuredClone(this.viewModel());
                    } catch {
                        viewModel = JSON.parse(JSON.stringify(this.viewModel()));
                    }

                    // Sets the value at path of object.
                    // If a portion of path doesn't exist, it's created.
                    // Arrays are created for missing index properties while objects are created for all other missing properties.
                    // This method mutates object.
                    this.setModelPropertyValue(viewModel, name, value);
                    // Directly set the signal to a new value, and notify any dependents.
                    this.viewModel.set(viewModel);
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
        if (this._formControl && this.configuration().attributes && this.configuration().attributes['disabled'] != null) {
            // Evaluates JavaScript code and executes it.
            const isDisabled: boolean = this.evaluateExpression(this.configuration().attributes['disabled'], this.viewModel) as boolean;

            if (typeof(isDisabled) === 'boolean' && ((isDisabled && this._formControl.enabled) || (!isDisabled && this._formControl.disabled))) {
                if (isDisabled) {
                    // Disables the control.
                    this._formControl.disable({
                        onlySelf: true,
                        emitEvent: false
                    });
                } else {
                    // Enables the control.
                    this._formControl.enable({
                        onlySelf: true,
                        emitEvent: false
                    });
                }
            }
        }
    }

    /**
     * Add synchronous validators to this control.
     */
    private setFormControlValidators(): void {
        if (this._formControl && this.configuration()?.attributes && Object.keys(this.configuration().attributes).length > 0 && this._componentRef?.location?.nativeElement) {
            const validators: ValidatorFn[] = [];
            // Validator that requires the control's value to be greater than or equal to the provided number.
            const min = this.evaluateExpression(this.configuration().attributes['min'], this.viewModel) as number;

            if (typeof(min) === 'number' && min.toString() !== this._componentRef.location.nativeElement.getAttribute('min')) {
                validators.push(Validators.min(min));
            }

            // Validator that requires the control's value to be less than or equal to the provided number.
            const max = this.evaluateExpression(this.configuration().attributes['max'], this.viewModel) as number;

            if (typeof(max) === 'number' && max.toString() !== this._componentRef.location.nativeElement.getAttribute('max')) {
                validators.push(Validators.max(max));
            }

            // Validator that requires the control have a non-empty value.
            const required = this.evaluateExpression(this.configuration().attributes['required'], this.viewModel) as boolean;

            if (required === true && required.toString() !== this._componentRef.location.nativeElement.getAttribute('required')) {
                validators.push(Validators.required);
            }

            // Validator that requires the control's value pass an email validation test.
            const email = this.evaluateExpression(this.configuration().attributes['email'], this.viewModel) as boolean;

            if (email === true && email.toString() !== this._componentRef.location.nativeElement.getAttribute('email')) {
                validators.push(Validators.email);
            }

            // Validator that requires the length of the control's value to be less than or equal to the provided maximum length.
            const maxLength = this.evaluateExpression(this.configuration().attributes['maxlength'], this.viewModel) as number;

            if (maxLength >= 0 && maxLength.toString() !== this._componentRef.location.nativeElement.getAttribute('maxlength')) {
                validators.push(Validators.maxLength(maxLength));
            }

            // Validator that requires the length of the control's value to be greater than or equal to the provided minimum length.
            const minLength = this.evaluateExpression(this.configuration().attributes['minlength'], this.viewModel) as number;

            if (minLength >= 0 && minLength.toString() !== this._componentRef.location.nativeElement.getAttribute('minlength')) {
                validators.push(Validators.minLength(minLength));
            }

            // Validator that requires the control's value to match a regex pattern.
            const pattern = this.evaluateExpression(this.configuration().attributes['pattern'], this.viewModel) as string;

            if (typeof(pattern) === 'string' && pattern !== this._componentRef.location.nativeElement.getAttribute('pattern')) {
                validators.push(Validators.pattern(pattern));
            }

            // Remove only previously managed validators, preserving any programmatic ones
            // added outside of this component's configuration.
            if (this._managedValidatorFns.length > 0) {
                this._formControl.removeValidators(this._managedValidatorFns);
            }

            this._managedValidatorFns = validators;

            this._formControl.addValidators(this._managedValidatorFns);
            // Recalculates the value and validation status of the control whenever the
            // managed validator set changes (including when it becomes empty).
            this._formControl.updateValueAndValidity({
                onlySelf: true,
                emitEvent: false
            });
        }
    }

    /**
     * Synchronizes a standalone FormControl instance to a form control element.
     */
    private attachFormControlDirective(): void {
        if (this._formControlDirective && this._componentRef?.injector && this._formControl) {
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
            return undefined
        }

        // Check if path is string or array. Regex : ensure that we do not have '.' and brackets.
        const pathArray: string[] = Array.isArray(property) ? property : property.match(/([^[.\]])+/g);
        // Find value
        const result: unknown = pathArray.reduce((prevObj: unknown, key: string): unknown => prevObj && prevObj[key], model);

        // If found value is undefined return default value; otherwise return the value
        return result != null ? result : defaultValue
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
        const pathArray: string[] = Array.isArray(property) ? property : property.match(/([^[.\]])+/g);

        pathArray.reduce((acc: unknown, key: string, i: number): unknown => {
            if (acc[key] === undefined) {
                acc[key] = {};
            }

            if (i === pathArray.length - 1) {
                acc[key] = value;
            }

            return acc[key]
        }, model);
    }

    /**
     * Updates specified input names to new values.
     */
    private setInputs(): void {
        if (this.configuration()?.inputs && Object.keys(this.configuration().inputs).length > 0 && this._componentRef) {
            for (const inputName in this.configuration().inputs) {
                // Updates a specified input name to a new value.
                // Using this method will properly mark for check component using the OnPush change detection strategy.
                // It will also assure that the OnChanges lifecycle hook runs when a dynamically created component is change-detected.
                this._componentRef.setInput(inputName, this.evaluateExpression(this.configuration().inputs[inputName], this.viewModel));
            }
        }
    }

    /**
     * Set attribute values for an element in the DOM.
     */
    private setAttributes(): void {
        if (this.configuration()?.attributes && Object.keys(this.configuration().attributes).length > 0 && this._componentRef?.location?.nativeElement) {
            for (const attributeName in this.configuration().attributes) {
                // Evaluates JavaScript code and executes it.
                const value = this.evaluateExpression(this.configuration().attributes[attributeName], this.viewModel);
                // Convert non-string values to their string form; null/undefined mean "remove the attribute".
                const stringValue: string | null = value != null ? String(value) : null;

                // Returns element's first attribute whose qualified name is qualifiedName, and null if there is no such attribute otherwise.
                if (stringValue !== this._componentRef.location.nativeElement.getAttribute(attributeName)) {
                    // Implement this callback to set an attribute value for an element in the DOM.
                    if (stringValue != null) {
                        this._renderer.setAttribute(this._componentRef.location.nativeElement, attributeName, stringValue);
                    } else {
                        this._renderer.removeAttribute(this._componentRef.location.nativeElement, attributeName);
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
    private evaluateExpression(value: unknown, $vm?: ModelSignal<unknown>, $event?: unknown): unknown {
        if (typeof(value) === 'string' && ((value.includes('$vm') && $vm != null && $vm() != null) || (value.includes('$event') && $event != null))) {
            // NOTE: This uses eval() by design to support expression binding via the $vm and $event placeholders.
            // Only evaluate expressions from trusted configuration sources — arbitrary JavaScript can be executed here.
            return eval(value);
        } else {
            return value;
        }
    }

    /**
     * Cleans up every dynamically created resource: subscriptions, form control, value accessor directive and component reference.
     * Used both on component type change and on destroy.
     */
    private cleanup(): void {
        // Disposes the resources held by the output subscriptions.
        this._outputsSubscriptions?.forEach((s: Subscription): void => s.unsubscribe());

        this._outputsSubscriptions = [];

        // Disposes the resources held by the form control subscription.
        this._formControlSubscription?.unsubscribe();

        this._formControlSubscription = undefined;

        // Remove the managed control from the form group.
        if (this._formControl && this.formGroup()) {
            const attributeName = this.configuration()?.attributes?.['name'];

            if (attributeName) {
                const controlName = this.evaluateExpression(attributeName, this.viewModel) as string;

                // Only remove the control if it is the one this component created, so that
                // a pre-existing control registered under the same name is left untouched.
                if (typeof controlName === 'string' && this.formGroup().get(controlName) === this._formControl) {
                    this.formGroup().removeControl(controlName);
                }
            }
        }

        this._formControl = undefined;
        this._managedValidatorFns = [];

        // A callback method that performs custom clean-up, invoked immediately before a directive, pipe, or service instance is destroyed.
        this._formControlDirective?.ngOnDestroy();

        this._formControlDirective = undefined;

        // Destroys the component instance and all of the data structures associated with it.
        this._componentRef?.destroy();
        
        this._componentRef = undefined;
    }

    /**
     * A callback method that performs custom clean-up, invoked immediately before a directive, pipe, or service instance is destroyed.
     */
	ngOnDestroy(): void {
        this.cleanup();
	}
}
