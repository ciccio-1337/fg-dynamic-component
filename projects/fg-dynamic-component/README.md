# fg-dynamic-component

Create an Angular standalone signals based dynamic components tree through a JSON configuration with full life-cycle support for inputs, outputs, attributes, reactive forms and expressions binding evaluation.

<details>
  <summary>Compatibility with Angular</summary>

| Angular | fg-dynamic-component | NPM package                   |
| ------- | -------------------- | ----------------------------- |
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
        onSomething: '$vm.update(viewModel => { ...viewModel, message: $event, count: viewModel.count + 1 })'
    }
  } as IFGDynamicItem);
  viewModel = model({ message: 'Hello World!', count: 0  });
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
            "my-attribute": "attribute-value",
            class: "some classes",
            disabled: "$vm().isDisabled"
        }
    } as IFGDynamicItem);
    viewModel = model({ isDisabled: true });
}
```

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

## Contributing

You are welcome to contribute to this project.
Simply follow the [contribution guide](/CONTRIBUTING.md).

## License

MIT © [Francesco Guagnano](guagnanofrancesco11@gmail.com)
