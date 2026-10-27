# fg-dynamic-component

Create an Angular standalone signals based dynamic components tree through a JSON configuration with full life-cycle support for inputs, outputs, attributes, reactive forms and expressions binding evaluation.

<details>
  <summary>Compatibility with Angular</summary>

| Angular | fg-dynamic-component | NPM package                   |
| ------- | -------------------- | ----------------------------- |
| 22.2.3  | 3.0.0                | `fg-dynamic-component@^3.0.0` |
| 22.1.6  | 2.0.0                | `fg-dynamic-component@^2.0.0` |
| 17.2.4  | 1.1.1                | `fg-dynamic-component@^1.1.1` |
| 17.2.4  | 1.1.0                | `fg-dynamic-component@^1.1.0` |
| 17.2.4  | 1.0.2                | `fg-dynamic-component@^1.0.2` |
| 17.2.4  | 1.0.1                | `fg-dynamic-component@^1.0.1` |

</details>

## Installation

```bash
$ npm install fg-dynamic-component --save
```

## Usage

### FGDynamicComponent

Import `FGDynamicComponent` where you need to render dynamic components:

```ts
import { FGDynamicComponent } from "fg-dynamic-component";

@NgModule({
    imports: [FGDynamicComponent]
})
export class MyModule {}
```

Then in your component's template include `<fg-dynamic>` where you want to render component
and bind from your component class type of component to render:

```ts
import { FGDynamicService, IFGDynamicItem } from "fg-dynamic-component";

FGDynamicService.registerComponent("MyDynamicComponent1", MyDynamicComponent1);
FGDynamicService.registerComponent("MyDynamicComponent4", import("...").then(m => m.MyDynamicComponent4));
FGDynamicService.registerComponent("MyDynamicComponent5", async () => (await import("...")).MyDynamicComponent5);

@Component({
    selector: "my-component",
    template: `<fg-dynamic [configuration]="configuration()" />`
})
class MyComponent {
    configuration = signal({
        type: "MyDynamicComponent1",
        items: [
            {
                type: MyDynamicComponent2
            },
            {
                type: import("...").then(m => m.MyDynamicComponent3)
            },
            {
                type: "MyDynamicComponent4"
            },
            {
                type: "MyDynamicComponent5"
            },
            {
                type: async () => (await import("...")).MyDynamicComponent6
            },
            {
                type: () => import("...").then(m => m.MyDynamicComponent7)
            }
        ]
    } as IFGDynamicItem);
}
```

#### Standalone API

You may use `<fg-dynamic>` as a standalone component:

```ts
import { FGDynamicComponent, FGDynamicService, IFGDynamicItem } from "fg-dynamic-component";

FGDynamicService.registerComponent("MyDynamicComponent4", import("...").then(m => m.MyDynamicComponent4));
FGDynamicService.registerComponent("MyDynamicComponent5", async () => (await import("...")).MyDynamicComponent5);

@Component({
    selector: "my-component",
    template: `<fg-dynamic [configuration]="configuration()" />`,
    imports: [FGDynamicComponent],
    standalone: true
})
class MyComponent {
    configuration = signal({
        items: [
            {
                type: MyDynamicComponent2
            },
            {
                type: import("...").then(m => m.MyDynamicComponent3)
            },
            {
                type: "MyDynamicComponent4"
            },
            {
                type: "MyDynamicComponent5"
            },
            {
                type: async () => (await import("...")).MyDynamicComponent6
            },
            {
                type: () => import("...").then(m => m.MyDynamicComponent7)
            }
        ]
    } as IFGDynamicItem);
}
```

_NOTE:_ You can declare components to dynamically load in static and/or dynamic way using or not the FGDynamicService.

#### Scoped registry

`FGDynamicService` uses a global registry. When configurations are not fully trusted
(for example multi-tenant or plugin scenarios), create a scoped registry and pass it
to the component. Scoped registries are propagated to nested items as well:

```ts
import { FGDynamicComponent, FGDynamicRegistry, FGDynamicService } from "fg-dynamic-component";

const registry: FGDynamicRegistry = FGDynamicService.createRegistry();
registry.register("MyDynamicComponent1", MyDynamicComponent1);

@Component({
    selector: "my-component",
    template: `<fg-dynamic [configuration]="configuration()" [registry]="registry" />`,
    imports: [FGDynamicComponent],
    standalone: true
})
class MyComponent {
    registry = registry;
    configuration = signal({ type: "MyDynamicComponent1" });
}
```

A configuration can only resolve component names that were explicitly registered in
the registry it receives. Names such as `constructor`, `__proto__` or `toString` are
never resolved from the registry prototype chain.

### Inputs and Outputs

You can pass `inputs` and `outputs` to your dynamic components:

```ts
@Component({
    selector: "my-component",
    template: `<fg-dynamic [configuration]="configuration()" />`,
    imports: [FGDynamicComponent],
    standalone: true
})
class MyComponent {
    configuration = signal({
        type: MyDynamicComponent1,
        inputs: {
            hello: "world",
            something: () => "can be really complex"
        },
        outputs: {
            onSomething: (type) => alert(type)
        }
    } as IFGDynamicItem);
}

@Component({
    selector: "my-dynamic-component1",
    template: "Dynamic Component 1"
})
class MyDynamicComponent1 {
    @Input()
    hello: string;
    @Input()
    something: Function;
    @Output()
    onSomething = new EventEmitter<string>();
}
```

You can update your inputs passing expressions binding using a view model and they will trigger standard Angular's life-cycle hooks
(of course you should consider which change detection strategy you are using).

```ts
@Component({
  selector: 'my-component',
  template: `<fg-dynamic [configuration]="configuration()" [(viewModel)]="viewModel" />`,
  imports: [FGDynamicComponent],
  standalone: true
})
class MyComponent {
  configuration = signal({
    type: MyDynamicComponent1,
    inputs: {
        hello: '$vm().count % 2 === 0 ? $vm().message : \'Hello World!\''
    },
    outputs: {
        onSomething: '$vm().handleSomething($event)'
    }
  } as IFGDynamicItem);
  viewModel = model({
    message: 'Hello World!',
    count: 0,
    handleSomething: (value: string) => { /* ... */ }
  });
}

@Component({
  selector: 'my-dynamic-component1',
  template: 'Dynamic Component 1'
})
class MyDynamicComponent1 {
  @Input()
  hello: string;
  @Input()
  something: Function;
  @Output()
  onSomething = new EventEmitter<string>();
}
```

### Attributes

You can declaratively set attributes, as you would inputs.

```ts
@Component({
    selector: "my-component",
    template: `<fg-dynamic [configuration]="configuration()" [(viewModel)]="viewModel" />`
})
class MyComponent {
    configuration = signal({
        type: MyDynamicComponent1,
        attributes: {
            "data-my-attribute": "attribute-value",
            class: "some classes",
            disabled: "$vm().isDisabled"
        }
    } as IFGDynamicItem);
    viewModel = model({ isDisabled: true });
}
```

> **Allowed attributes**
>
> Only a safe allowlist of attributes is applied: `id`, `class`, `name`, `role`,
> `title`, `tabindex`, `hidden`, `dir`, `lang`, `for`, `href`, `src`, the common
> form attributes (`disabled`, `readonly`, `required`, `placeholder`, …) and any
> `data-*` or `aria-*` attribute.
>
> Event handlers (`on*`), `style`, `srcdoc`, `formaction`, namespaced attributes
> and non-primitive values are ignored. `href` and `src` only accept `http`,
> `https`, `mailto`, `tel` and relative URLs, so `javascript:` URLs are blocked
> even when they come from an expression.

### Reactive Forms

You can declaratively set attributes to activate model binding, form control status (enabled/disabled) and validations with your ControlValueAccessor components.

> **Attributes**:
>
>-   name: used to attach the new control to the input form group (must match the view model property name).
>-   disabled: specifies that an input field should be disabled.
>-   maxlength: specifies the maximum number of characters allowed in an input field.
>-   minlength: specifies the minimum number of characters allowed in an input field.
>-   min: specifies the minimum value for an input field.
>-   max: specifies the maximum value for an input field.
>-   pattern: specifies a regular expression that the input field's value is checked against.
>-   required: specifies that an input field must be filled.
>-   email: defines a field automatically validated to ensure it is a properly formatted e-mail address.

```ts
@Component({
    selector: "my-component",
    template: `<fg-dynamic [configuration]="configuration()" [(viewModel)]="viewModel" [formGroup]="formGroup()" />`
})
class MyComponent {
    configuration = signal({
        type: MyDynamicComponent1,
        attributes: {
            name: "data.firstName",
            disabled: "$vm().metadata.firstName.disabled",
            maxlength: 20,
            required: true
        }
    } as IFGDynamicItem);
    viewModel = model({ data: { firstName: "Jhon" }, metadata: { firstName: { disabled: false } } });
    formGroup = signal(new FormGroup({}));
}
```

> **Security note**
>
> `disabled` and the form validators are configured by the same configuration that
> renders the form. They are **UX-only**: a client can always bypass them. Never use
> them for authorization or as the only validation layer. Enforce permissions,
> required fields, ranges and formats again on the server.
>
> Control names are interpreted as dot/bracket paths into the view model. Paths that
> contain `__proto__`, `prototype` or `constructor` are rejected, so a configuration
> cannot pollute object prototypes or register such names in a `FormGroup`.

## Security

### Expressions are interpreted, never evaluated

`inputs`, `outputs` and `attributes` values that contain `$vm` or `$event` are
evaluated by a small, self-contained interpreter. No `eval`, `new Function` or
other string-to-code primitive is used. The supported subset is:

- literals (`'text'`, `42`, `true`, `false`, `null`, `undefined`), arrays and objects;
- member access `$vm().name`, `$vm()['name']` and optional chaining `$vm().a?.b`;
- calls such as `$vm().save($event)` and expression-bodied arrow functions
  (for example `$vm().items.map(item => item.id)`);
- unary, arithmetic, comparison, logical, nullish and ternary operators;
- array/object spread and arrow functions whose body returns an expression or
  contains a `return` statement.

Anything else is ignored at runtime (a warning is printed only in development mode).
In particular globals (`window`, `fetch`, …), assignments, `new`, `this`, template
literals, regular-expression literals and access to `__proto__`, `prototype`,
`constructor`, `caller`, `callee` or `arguments` are rejected. Expressions are also
limited in size, token count, nesting depth and evaluation steps.

A value that contains neither `$vm` nor `$event` is used as a plain literal.

> Expressions are configuration data, not sandboxed user code: a trusted
> configuration can still call methods that exist on the view model. Only load
> configurations from sources you trust.

### Other hardening

- Attribute names/values are validated (see [Attributes](#attributes)) and URL
  schemes are checked.
- The component registry uses a `Map` and never resolves inherited properties
  (`constructor`, `__proto__`, …). Prefer a scoped registry for untrusted
  configurations.
- Angular component classes are never invoked as loader functions.
- Dev-mode diagnostics never include expression sources, configuration values or
  raw error objects.

## Contributing

You are welcome to contribute to this project.
Simply follow the [contribution guide](/CONTRIBUTING.md).

## License

MIT © [Francesco Guagnano](guagnanofrancesco11@gmail.com)
