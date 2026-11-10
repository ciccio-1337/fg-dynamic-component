import { Component, EventEmitter, Input, Output, forwardRef, output, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { AbstractControl, ControlValueAccessor, FormControl, FormGroup, NG_VALUE_ACCESSOR, ReactiveFormsModule } from '@angular/forms';
import { FGDynamicComponent, FGDynamicService, IFGDynamicItem } from './fg-dynamic.component';

@Component({
  selector: 'test-simple',
  standalone: true,
  template: '<div>simple</div>'
})
class TestSimpleComponent {}

@Component({
  selector: 'test-with-inputs',
  standalone: true,
  template: '<div>{{ value }}-{{ count }}</div>'
})
class TestWithInputsComponent {
  @Input() value: string = '';
  @Input() count: number = 0;
}

@Component({
  selector: 'test-with-outputs',
  standalone: true,
  template: '<button (click)="click()">click</button>'
})
class TestWithOutputsComponent {
  @Output() clicked = new EventEmitter<string>();
  click() {
    this.clicked.emit('hello');
  }
}

@Component({
  selector: 'test-with-ngcontent',
  standalone: true,
  template: '<div><ng-content></ng-content></div>'
})
class TestWithNgContentComponent {}

@Component({
  selector: 'test-alternate',
  standalone: true,
  template: '<div>alternate</div>'
})
class TestAlternateComponent {}

@Component({
  selector: 'test-signal-output',
  standalone: true,
  template: '<button (click)="click()">signal-click</button>'
})
class TestSignalOutputComponent {
  readonly clicked = output<string>();

  click(): void {
    this.clicked.emit('signal-hello');
  }
}

@Component({
  selector: 'test-void-output',
  standalone: true,
  template: '<button (click)="click()">void-click</button>'
})
class TestVoidOutputComponent {
  @Output() done = new EventEmitter<void>();

  click(): void {
    this.done.emit();
  }
}

@Component({
  selector: 'test-dom-output',
  standalone: true,
  template: '<button (click)="click($event)">dom-click</button>'
})
class TestDomOutputComponent {
  @Output() clicked = new EventEmitter<Event>();

  click(event: Event): void {
    this.clicked.emit(event);
  }
}

@Component({
  selector: 'test-cva',
  standalone: true,
  template: '<input [value]="value" (input)="handleInput($event)" />',
  providers: [{
    provide: NG_VALUE_ACCESSOR,
    useExisting: forwardRef(() => TestCvaComponent),
    multi: true
  }]
})
class TestCvaComponent implements ControlValueAccessor {
  value = '';
  private _onChange: (value: string) => void = () => {};
  private _onTouched: () => void = () => {};

  writeValue(value: unknown): void {
    this.value = value == null ? '' : String(value);
  }

  registerOnChange(fn: (value: string) => void): void {
    this._onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this._onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    // No-op for the test value accessor.
  }

  handleInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.value = value;
    this._onChange(value);
    this._onTouched();
  }
}

class TestMarker {
  constructor(public readonly label: string) {}
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let index = 0; index < 3; index++) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}

describe('FGDynamicService', () => {
  beforeEach(() => {
    FGDynamicService.clearRegistry();
  });

  it('should register and get component', () => {
    FGDynamicService.registerComponent('TestComp', TestSimpleComponent);
    expect(FGDynamicService.getComponent('TestComp')).toBe(TestSimpleComponent);
  });

  it('should not register if name or type is falsy', () => {
    FGDynamicService.registerComponent('', TestSimpleComponent);
    FGDynamicService.registerComponent('Test', null as any);
    expect(FGDynamicService.getComponent('')).toBeUndefined();
    expect(FGDynamicService.getComponent('Test')).toBeUndefined();
  });

  it('should overwrite existing registration', () => {
    FGDynamicService.registerComponent('Test', TestSimpleComponent);
    FGDynamicService.registerComponent('Test', TestWithInputsComponent);
    expect(FGDynamicService.getComponent('Test')).toBe(TestWithInputsComponent);
  });
});

describe('FGDynamicComponent', () => {
  let fixture: ComponentFixture<FGDynamicComponent>;
  let component: FGDynamicComponent;

  beforeEach(async () => {
    FGDynamicService.clearRegistry();
    await TestBed.configureTestingModule({
      imports: [FGDynamicComponent, ReactiveFormsModule]
    }).compileComponents();

    fixture = TestBed.createComponent(FGDynamicComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent } as IFGDynamicItem);
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should create component from direct type', async () => {
    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement;
    expect(el.textContent).toContain('simple');
  });

  it('should create component from registered name', async () => {
    FGDynamicService.registerComponent('Simple', TestSimpleComponent);
    fixture.componentRef.setInput('configuration', { type: 'Simple' } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('simple');
  });

  it('should handle Promise type', async () => {
    fixture.componentRef.setInput('typePolicy', { allowFunctionTypes: true });
    fixture.componentRef.setInput('configuration', { type: Promise.resolve(TestSimpleComponent) } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await new Promise(r => setTimeout(r, 50));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('simple');
  });

  it('should handle loader function returning Promise', async () => {
    fixture.componentRef.setInput('typePolicy', { allowFunctionTypes: true });
    fixture.componentRef.setInput('configuration', { type: () => Promise.resolve(TestSimpleComponent) } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await new Promise(r => setTimeout(r, 50));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('simple');
  });

  it('should set inputs', async () => {
    fixture.componentRef.setInput('configuration', { type: TestWithInputsComponent, inputs: { value: 'test', count: 5 } } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('test-5');
  });

  it('should set inputs with expression evaluation', async () => {
    fixture.componentRef.setInput('viewModel', { name: 'hello' });
    fixture.componentRef.setInput('configuration', { type: TestWithInputsComponent, inputs: { value: '$vm().name' } } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await new Promise(r => setTimeout(r, 30));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('hello-0');
  });

  it('should set attributes', async () => {
    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent, attributes: { id: 'test-id', 'data-test': 'value' } } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('test-simple') || fixture.nativeElement.firstElementChild;
    if (host) {
      expect(host.getAttribute('id')).toBe('test-id');
      expect(host.getAttribute('data-test')).toBe('value');
    }
  });

  it('should remove attributes when value is null', async () => {
    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent, attributes: { id: 'test' } } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    
    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent, attributes: { id: null } } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    
    const host = fixture.nativeElement.querySelector('test-simple') || fixture.nativeElement.firstElementChild;
    if (host) {
      expect(host.getAttribute('id')).toBeNull();
    }
  });

  it('should handle outputs', async () => {
    const host: any = {};
    fixture.componentRef.setInput('configuration', { 
      type: TestWithOutputsComponent, 
      outputs: { clicked: function(e: any){ this.received = e; } } 
    } as IFGDynamicItem);
    fixture.componentRef.setInput('viewModel', host);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    
    const button = fixture.nativeElement.querySelector('button');
    if (button) {
      button.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(host.received).toBe('hello');
    }
  });

  it('should handle nested items', async () => {
    fixture.componentRef.setInput('configuration', { 
      type: TestWithNgContentComponent,
      items: [
        { type: TestSimpleComponent }
      ]
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('simple');
  });

  it('should work with formGroup and form control', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'test' });
    fixture.componentRef.setInput('configuration', { 
      type: TestSimpleComponent, 
      attributes: { name: 'name' } 
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    
    expect(formGroup.get('name')).toBeTruthy();
  });

  it('should handle disabled attribute', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'test' });
    fixture.componentRef.setInput('configuration', { 
      type: TestSimpleComponent, 
      attributes: { name: 'name', disabled: true } 
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    
    const control = formGroup.get('name');
    expect(control?.disabled).toBe(true);
  });

  it('should re-enable when disabled removed', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'test' });
    fixture.componentRef.setInput('configuration', { 
      type: TestSimpleComponent, 
      attributes: { name: 'name', disabled: true } 
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    
    fixture.componentRef.setInput('configuration', { 
      type: TestSimpleComponent, 
      attributes: { name: 'name', disabled: null } 
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    
    const control = formGroup.get('name');
    expect(control?.disabled).toBe(false);
  });

  it('should handle validators', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: '' });
    fixture.componentRef.setInput('configuration', { 
      type: TestSimpleComponent, 
      attributes: { name: 'name', required: true } 
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    
    const control = formGroup.get('name');
    expect(control?.hasError('required')).toBe(true);
  });

  it('should cleanup on destroy', () => {
    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent } as IFGDynamicItem);
    fixture.detectChanges();
    expect(() => fixture.destroy()).not.toThrow();
  });

  it('should handle modelSignal updates', async () => {
    fixture.componentRef.setInput('viewModel', { count: 1 });
    fixture.componentRef.setInput('configuration', { type: TestWithInputsComponent, inputs: { count: '$vm().count' } } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await new Promise(r => setTimeout(r, 10));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('-1');
  });

  it('should not resolve inherited registry keys', () => {
    expect(FGDynamicService.getComponent('constructor')).toBeUndefined();
    expect(FGDynamicService.getComponent('__proto__')).toBeUndefined();
    expect(FGDynamicService.getComponent('toString')).toBeUndefined();
    expect(FGDynamicService.getComponent('hasOwnProperty')).toBeUndefined();
  });

  it('should resolve component types from a scoped registry', async () => {
    const scoped = FGDynamicService.createRegistry();
    scoped.register('ScopedSimple', TestSimpleComponent);

    fixture.componentRef.setInput('registry', scoped);
    fixture.componentRef.setInput('configuration', { type: 'ScopedSimple' } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('simple');
    expect(FGDynamicService.getComponent('ScopedSimple')).toBeUndefined();
  });

  it('should ignore event handler, standalone style and namespaced attributes', async () => {
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: {
        onclick: 'alert(1)',
        onerror: 'alert(1)',
        style: 'color: red',
        srcdoc: '<script>alert(1)</script>',
        formaction: 'javascript:alert(1)',
        'xml:lang': 'en',
        'data-safe': 'ok',
        'aria-label': 'safe'
      }
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const host: HTMLElement = fixture.nativeElement.querySelector('test-simple') || fixture.nativeElement.firstElementChild;
    expect(host).toBeTruthy();
    expect(host.getAttribute('onclick')).toBeNull();
    expect(host.getAttribute('onerror')).toBeNull();
    expect(host.getAttribute('style')).toBeNull();
    expect(host.getAttribute('srcdoc')).toBeNull();
    expect(host.getAttribute('formaction')).toBeNull();
    expect(host.getAttribute('xml:lang')).toBeNull();
    expect(host.getAttribute('data-safe')).toBe('ok');
    expect(host.getAttribute('aria-label')).toBe('safe');
  });

  it('should enforce attribute strict mode', async () => {
    fixture.componentRef.setInput('attributePolicy', { strict: true });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: {
        id: 'tenant-id',
        class: 'app-modal-overlay',
        href: 'https://example.com',
        name: 'field-name',
        'data-safe': 'ok'
      }
    } as IFGDynamicItem);
    await settle(fixture);

    const host: HTMLElement = fixture.nativeElement.querySelector('test-simple') || fixture.nativeElement.firstElementChild;
    expect(host).toBeTruthy();
    expect(host.getAttribute('id')).toBeNull();
    expect(host.getAttribute('class')).toBeNull();
    expect(host.getAttribute('href')).toBeNull();
    expect(host.getAttribute('data-safe')).toBe('ok');
    // `name` remains available because it also drives form control wiring.
    expect(host.getAttribute('name')).toBe('field-name');
  });

  it('should block unsafe URL schemes in href/src attributes', async () => {
    fixture.componentRef.setInput('viewModel', { url: 'javascript:alert(1)' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { href: '$vm().url', src: 'java\nscript:alert(1)' }
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const host: HTMLElement = fixture.nativeElement.querySelector('test-simple') || fixture.nativeElement.firstElementChild;
    expect(host.getAttribute('href')).toBeNull();
    expect(host.getAttribute('src')).toBeNull();
  });

  it('should allow safe absolute and relative URLs', async () => {
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { href: 'https://example.com/docs', src: '/assets/icon.svg' }
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const host: HTMLElement = fixture.nativeElement.querySelector('test-simple') || fixture.nativeElement.firstElementChild;
    expect(host.getAttribute('href')).toBe('https://example.com/docs');
    expect(host.getAttribute('src')).toBe('/assets/icon.svg');
  });

  it('should not allow prototype pollution through attribute paths', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'test' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: '__proto__.polluted' }
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(formGroup.get('__proto__.polluted')).toBeNull();

    (component as any).setModelPropertyValue({}, '__proto__.polluted', 'xss');
    (component as any).setModelPropertyValue({}, 'constructor.prototype.polluted', 'xss');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('should not execute JavaScript from output expressions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((): Promise<Response> => Promise.reject(new Error('fetch must not be called')));

    try {
      fixture.componentRef.setInput('viewModel', {});
      fixture.componentRef.setInput('configuration', {
        type: TestWithOutputsComponent,
        outputs: {
          clicked: "fetch('https://evil.example/'), $vm",
          other: "globalThis.__fgPolluted = true, $vm"
        }
      } as IFGDynamicItem);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const button: HTMLButtonElement | null = fixture.nativeElement.querySelector('button');
      expect(button).toBeTruthy();
      button!.click();
      fixture.detectChanges();
      await fixture.whenStable();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect((globalThis as any).__fgPolluted).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('should not let output expressions escape through DOM event objects', async () => {
    fixture.componentRef.setInput('viewModel', {});
    fixture.componentRef.setInput('configuration', {
      type: TestDomOutputComponent,
      outputs: {
        clicked: '$event.target.ownerDocument.createElement("img")'
      }
    } as IFGDynamicItem);
    await settle(fixture);

    const createElement = vi.spyOn(document, 'createElement');
    try {
      const callsBefore = createElement.mock.calls.length;
      const button: HTMLButtonElement | null = fixture.nativeElement.querySelector('button');
      expect(button).toBeTruthy();
      button!.click();
      await settle(fixture);

      expect(createElement.mock.calls.length).toBe(callsBefore);
    } finally {
      createElement.mockRestore();
    }
  });

  it('should block custom view-model methods by default', async () => {
    const save = vi.fn();
    fixture.componentRef.setInput('viewModel', { save });
    fixture.componentRef.setInput('configuration', {
      type: TestWithOutputsComponent,
      outputs: { clicked: '$vm().save($event)' }
    } as IFGDynamicItem);
    await settle(fixture);

    const button: HTMLButtonElement | null = fixture.nativeElement.querySelector('button');
    button!.click();
    await settle(fixture);

    expect(save).not.toHaveBeenCalled();
  });

  it('should not expose $vm.set/$vm.update by default', () => {
    fixture.componentRef.setInput('viewModel', { count: 1 });

    (component as any).evaluateExpression('$vm.set({ count: 2 })', { count: 1 });
    (component as any).evaluateExpression('$vm.update(current => ({ ...current, count: 3 }))', { count: 1 });

    expect((component.viewModel() as any).count).toBe(1);
  });

  it('should evaluate the allowlisted expression subset', async () => {
    fixture.componentRef.setInput('viewModel', { flag: true, nested: { label: 'ok' }, items: [1, 2] });
    fixture.componentRef.setInput('configuration', {
      type: TestWithInputsComponent,
      inputs: {
        value: "$vm().flag ? $vm().nested?.label : 'no'",
        count: "$vm().missing ?? 7"
      }
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('ok-7');
  });

  it('should evaluate expression-bodied arrows against the view model', async () => {
    fixture.componentRef.setInput('viewModel', { items: [1, 2] });
    fixture.componentRef.setInput('configuration', {
      type: TestWithInputsComponent,
      inputs: { value: "$vm().items.map(item => item * 2).join(',')" }
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('2,4');
  });

  it('should ignore potentially catastrophic pattern validators', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: '' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name', pattern: '(a+)+$' }
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const control = formGroup.get('name') as AbstractControl;
    expect(control).toBeTruthy();
    control.setValue('a'.repeat(2000) + '!');
    expect(control.hasError('pattern')).toBe(false);
  });

  it('should apply safe pattern validators', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: '' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name', pattern: '^\\d+$' }
    } as IFGDynamicItem);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const control = formGroup.get('name') as AbstractControl;
    expect(control).toBeTruthy();
    control.setValue('abc');
    expect(control.hasError('pattern')).toBe(true);
  });

  it('should support dotted form control names through nested groups', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { data: { firstName: 'Jhon' } });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'data.firstName' }
    } as IFGDynamicItem);
    await settle(fixture);

    const nested = formGroup.get('data');
    expect(nested).toBeInstanceOf(FormGroup);
    const control = formGroup.get('data.firstName') as unknown as FormControl;
    expect(control).toBeInstanceOf(FormControl);
    expect(control.value).toBe('Jhon');

    control.setValue('Jane');
    await settle(fixture);
    expect((component.viewModel() as any).data.firstName).toBe('Jane');

    fixture.destroy();
    expect(formGroup.get('data.firstName')).toBeNull();
    expect(formGroup.get('data')).toBeNull();
  });

  it('should not remove a pre-existing dotted control on cleanup', async () => {
    const firstName = new FormControl('pre-existing');
    const data = new FormGroup({ firstName });
    const formGroup = new FormGroup({ data });

    fixture.componentRef.setInput('formControlPolicy', { allowExistingControls: true });
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { data: { firstName: 'pre-existing' } });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'data.firstName' }
    } as IFGDynamicItem);
    await settle(fixture);

    expect(formGroup.get('data.firstName')).toBe(firstName);
    fixture.destroy();
    expect(formGroup.get('data.firstName')).toBe(firstName);
    expect(firstName.value).toBe('pre-existing');
  });

  it('should subscribe to valueChanges on reused controls', async () => {
    const existing = new FormControl('initial');
    const formGroup = new FormGroup({ name: existing });

    fixture.componentRef.setInput('formControlPolicy', { allowExistingControls: true });
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'initial' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name' }
    } as IFGDynamicItem);
    await settle(fixture);

    existing.setValue('updated');
    await settle(fixture);

    expect(formGroup.get('name')).toBe(existing);
    expect((component.viewModel() as any).name).toBe('updated');
  });

  it('should restore the disabled state of a reused control', async () => {
    const existing = new FormControl({ value: 'pre', disabled: true });
    const formGroup = new FormGroup({ name: existing });

    fixture.componentRef.setInput('formControlPolicy', { allowExistingControls: true });
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'pre' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name', disabled: false }
    } as IFGDynamicItem);
    await settle(fixture);
    expect(existing.disabled).toBe(false);

    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name' }
    } as IFGDynamicItem);
    await settle(fixture);
    expect(existing.disabled).toBe(true);
  });

  it('should not reuse pre-existing controls by default', async () => {
    const existing = new FormControl('initial');
    const formGroup = new FormGroup({ name: existing });

    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'initial' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name' }
    } as IFGDynamicItem);
    await settle(fixture);

    existing.setValue('changed-outside');
    await settle(fixture);

    expect(formGroup.get('name')).toBe(existing);
    expect((component.viewModel() as any).name).toBe('initial');
  });

  it('should enforce allowedControlNames', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('formControlPolicy', { allowedControlNames: ['allowed'] });
    fixture.componentRef.setInput('viewModel', { secret: 'value' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'secret' }
    } as IFGDynamicItem);
    await settle(fixture);

    expect(formGroup.get('secret')).toBeNull();
  });

  it('should rewire the form control when its name changes', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { first: 'one', second: 'two' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'first' }
    } as IFGDynamicItem);
    await settle(fixture);
    expect(formGroup.get('first')).toBeInstanceOf(FormControl);

    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'second' }
    } as IFGDynamicItem);
    await settle(fixture);

    expect(formGroup.get('first')).toBeNull();
    expect((formGroup.get('second') as unknown as FormControl).value).toBe('two');
  });

  it('should rewire the form control when the form group changes', async () => {
    const firstGroup = new FormGroup({});
    const secondGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', firstGroup);
    fixture.componentRef.setInput('viewModel', { name: 'value' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name' }
    } as IFGDynamicItem);
    await settle(fixture);
    expect(firstGroup.get('name')).toBeInstanceOf(FormControl);

    fixture.componentRef.setInput('formGroup', secondGroup);
    await settle(fixture);

    expect(firstGroup.get('name')).toBeNull();
    expect(secondGroup.get('name')).toBeInstanceOf(FormControl);
  });

  it('should wire the form control when form inputs become available later', async () => {
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name' }
    } as IFGDynamicItem);
    await settle(fixture);

    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'later' });
    await settle(fixture);

    const control = formGroup.get('name') as unknown as FormControl;
    expect(control).toBeInstanceOf(FormControl);
    expect(control.value).toBe('later');
  });

  it('should synchronize a ControlValueAccessor with the form control', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'initial' });
    fixture.componentRef.setInput('configuration', {
      type: TestCvaComponent,
      attributes: { name: 'name' }
    } as IFGDynamicItem);
    await settle(fixture);

    const control = formGroup.get('name') as unknown as FormControl;
    expect(control).toBeInstanceOf(FormControl);
    expect(control.value).toBe('initial');

    const input: HTMLInputElement | null = fixture.nativeElement.querySelector('test-cva input');
    expect(input).toBeTruthy();
    expect(input!.value).toBe('initial');

    const cva = fixture.debugElement.query(By.directive(TestCvaComponent)).componentInstance as TestCvaComponent;

    input!.value = 'typed';
    input!.dispatchEvent(new Event('input'));
    await settle(fixture);

    expect(control.value).toBe('typed');
    expect(cva.value).toBe('typed');
    expect((component.viewModel() as any).name).toBe('typed');

    control.setValue('programmatic');
    await settle(fixture);
    expect(cva.value).toBe('programmatic');
    expect((component.viewModel() as any).name).toBe('programmatic');
  });

  it('should preserve functions and non-plain objects when updating the view model', async () => {
    const handler = vi.fn();
    const marker = new TestMarker('keep');
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', {
      name: 'before',
      handler,
      marker,
      nested: { keep: true }
    });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name' }
    } as IFGDynamicItem);
    await settle(fixture);

    (formGroup.get('name') as unknown as FormControl).setValue('after');
    await settle(fixture);

    const updated = component.viewModel() as any;
    expect(updated.name).toBe('after');
    expect(updated.handler).toBe(handler);
    expect(updated.marker).toBe(marker);
    expect(updated.nested.keep).toBe(true);
  });

  it('should clear the rendered component when the type is removed', async () => {
    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('simple');

    fixture.componentRef.setInput('configuration', {} as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('simple');
  });

  it('should clear the rendered component when the registry name is unknown', async () => {
    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('simple');

    fixture.componentRef.setInput('configuration', { type: 'MissingComponent' } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('simple');
  });

  it('should clear the rendered component when a loader throws', async () => {
    fixture.componentRef.setInput('typePolicy', { allowFunctionTypes: true });
    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('simple');

    fixture.componentRef.setInput('configuration', {
      type: () => {
        throw new Error('loader failed');
      }
    } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('simple');
  });

  it('should ignore a late async resolution for a superseded configuration', async () => {
    fixture.componentRef.setInput('typePolicy', { allowFunctionTypes: true });
    let resolveLate!: (value: typeof TestAlternateComponent) => void;
    const late = new Promise<typeof TestAlternateComponent>((resolve) => {
      resolveLate = resolve;
    });

    fixture.componentRef.setInput('configuration', { type: late } as IFGDynamicItem);
    fixture.detectChanges();

    fixture.componentRef.setInput('configuration', { type: TestSimpleComponent } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('simple');

    resolveLate(TestAlternateComponent);
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('simple');
    expect(fixture.nativeElement.textContent).not.toContain('alternate');
  });

  it('should reject function and promise types by default', async () => {
    fixture.componentRef.setInput('configuration', { type: Promise.resolve(TestSimpleComponent) } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('simple');

    fixture.componentRef.setInput('configuration', { type: () => Promise.resolve(TestSimpleComponent) } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('simple');
  });

  it('should require a scoped registry when configured', async () => {
    FGDynamicService.registerComponent('GlobalSimple', TestSimpleComponent);
    fixture.componentRef.setInput('typePolicy', { requireScopedRegistry: true });
    fixture.componentRef.setInput('configuration', { type: 'GlobalSimple' } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('simple');

    const scoped = FGDynamicService.createRegistry();
    scoped.register('GlobalSimple', TestSimpleComponent);
    fixture.componentRef.setInput('registry', scoped);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('simple');
  });

  it('should support signal outputs created with output()', async () => {
    const viewModel: any = {};
    fixture.componentRef.setInput('viewModel', viewModel);
    fixture.componentRef.setInput('configuration', {
      type: TestSignalOutputComponent,
      outputs: {
        clicked: function (event: unknown): void {
          this.received = event;
        }
      }
    } as IFGDynamicItem);
    await settle(fixture);

    const button: HTMLButtonElement | null = fixture.nativeElement.querySelector('button');
    expect(button).toBeTruthy();
    button!.click();
    await settle(fixture);

    expect(viewModel.received).toBe('signal-hello');
  });

  it('should evaluate output expressions for nullish/void event payloads', async () => {
    const done = vi.fn();
    fixture.componentRef.setInput('expressionPolicy', { allowedMethods: ['done'] });
    fixture.componentRef.setInput('viewModel', { done });
    fixture.componentRef.setInput('configuration', {
      type: TestVoidOutputComponent,
      outputs: { done: '$vm().done($event)' }
    } as IFGDynamicItem);
    await settle(fixture);

    const button: HTMLButtonElement | null = fixture.nativeElement.querySelector('button');
    expect(button).toBeTruthy();
    button!.click();
    await settle(fixture);

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it('should treat boolean attributes as presence/absence', async () => {
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { hidden: false, required: false, checked: false }
    } as IFGDynamicItem);
    await settle(fixture);

    const host: HTMLElement = fixture.nativeElement.querySelector('test-simple');
    expect(host).toBeTruthy();
    expect(host.hasAttribute('hidden')).toBe(false);
    expect(host.hasAttribute('required')).toBe(false);
    expect(host.hasAttribute('checked')).toBe(false);

    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { hidden: true, required: true, checked: true }
    } as IFGDynamicItem);
    await settle(fixture);

    expect(host.hasAttribute('hidden')).toBe(true);
    expect(host.hasAttribute('required')).toBe(true);
    expect(host.hasAttribute('checked')).toBe(true);
  });

  it('should evaluate boolean attributes from the view model', async () => {
    fixture.componentRef.setInput('viewModel', { hidden: false });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { hidden: '$vm().hidden' }
    } as IFGDynamicItem);
    await settle(fixture);

    const host: HTMLElement = fixture.nativeElement.querySelector('test-simple');
    expect(host.hasAttribute('hidden')).toBe(false);

    fixture.componentRef.setInput('viewModel', { hidden: true });
    await settle(fixture);
    expect(host.hasAttribute('hidden')).toBe(true);
  });

  it('should remove attributes whose keys are deleted from the configuration', async () => {
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { id: 'test-id', title: 'title', 'data-extra': 'extra' }
    } as IFGDynamicItem);
    await settle(fixture);

    const host: HTMLElement = fixture.nativeElement.querySelector('test-simple');
    expect(host.getAttribute('id')).toBe('test-id');
    expect(host.getAttribute('title')).toBe('title');
    expect(host.getAttribute('data-extra')).toBe('extra');

    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { id: 'test-id' }
    } as IFGDynamicItem);
    await settle(fixture);

    expect(host.getAttribute('id')).toBe('test-id');
    expect(host.getAttribute('title')).toBeNull();
    expect(host.getAttribute('data-extra')).toBeNull();

    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent
    } as IFGDynamicItem);
    await settle(fixture);
    expect(host.getAttribute('id')).toBeNull();
  });

  it('should re-enable a control when the disabled key is deleted', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'test' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name', disabled: true }
    } as IFGDynamicItem);
    await settle(fixture);
    expect((formGroup.get('name') as unknown as FormControl).disabled).toBe(true);

    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name' }
    } as IFGDynamicItem);
    await settle(fixture);
    expect((formGroup.get('name') as unknown as FormControl).disabled).toBe(false);
  });

  it('should normalize numeric and string disabled values', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: 'test' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name', disabled: 1 }
    } as IFGDynamicItem);
    await settle(fixture);
    expect((formGroup.get('name') as unknown as FormControl).disabled).toBe(true);

    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name', disabled: 0 }
    } as IFGDynamicItem);
    await settle(fixture);
    expect((formGroup.get('name') as unknown as FormControl).disabled).toBe(false);

    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name', disabled: 'true' }
    } as IFGDynamicItem);
    await settle(fixture);
    expect((formGroup.get('name') as unknown as FormControl).disabled).toBe(true);
  });

  it('should reset inputs whose keys are deleted from the configuration', async () => {
    fixture.componentRef.setInput('configuration', {
      type: TestWithInputsComponent,
      inputs: { value: 'set', count: 5 }
    } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('set-5');

    fixture.componentRef.setInput('configuration', {
      type: TestWithInputsComponent,
      inputs: {}
    } as IFGDynamicItem);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('set-5');
  });

  it('should fall back to the literal value when the view model is missing', async () => {
    fixture.componentRef.setInput('configuration', {
      type: TestWithInputsComponent,
      inputs: { value: '$vm().name' }
    } as IFGDynamicItem);
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('$vm().name');

    expect((component as any).evaluateExpression('$vm().name', undefined)).toBe('$vm().name');
    expect((component as any).evaluateExpression('$event', undefined, undefined, true)).toBeUndefined();
    expect((component as any).evaluateExpression('$event', undefined, 1, false)).toBe('$event');
  });

  it('should expose ModelSignal helpers on $vm', () => {
    fixture.componentRef.setInput('expressionPolicy', { allowViewModelMutation: true });
    fixture.componentRef.setInput('viewModel', { count: 1 });

    (component as any).evaluateExpression(
      '$vm.update(current => ({ ...current, count: current.count + 1 }))',
      { count: 1 }
    );

    expect((component.viewModel() as any).count).toBe(2);
  });

  it('should reject overlapping alternation patterns', async () => {
    for (const pattern of ['(a|aa)+$', '(\\w|\\d)+$']) {
      const formGroup = new FormGroup({});
      fixture.componentRef.setInput('formGroup', formGroup);
      fixture.componentRef.setInput('viewModel', { name: '' });
      fixture.componentRef.setInput('configuration', {
        type: TestSimpleComponent,
        attributes: { name: 'name', pattern }
      } as IFGDynamicItem);
      await settle(fixture);

      const control = formGroup.get('name') as unknown as FormControl;
      control.setValue('a'.repeat(1000) + '!');
      expect(control.hasError('pattern')).toBe(false);
    }
  });

  it('should reject nested-quantifier pattern validators', async () => {
    const formGroup = new FormGroup({});
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: '' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name', pattern: '^(\\d+(?:\\d+)?)+$' }
    } as IFGDynamicItem);
    await settle(fixture);

    const control = formGroup.get('name') as unknown as FormControl;
    control.setValue('1'.repeat(20) + '!');
    expect(control.hasError('pattern')).toBe(false);
  });

  it('should detect nested-quantifier regex bypasses', () => {
    const isUnsafe = (component as any).isUnsafeRegex.bind(component);

    expect(isUnsafe('^(\\d+(?:\\d+)?)+$')).toBe(true);
    expect(isUnsafe('(a+)+$')).toBe(true);
    expect(isUnsafe('(a?)+$')).toBe(true);
    expect(isUnsafe('(a|aa)+$')).toBe(true);
    expect(isUnsafe('(\\d+){2,}$')).toBe(true);
    expect(isUnsafe('^\\d+$')).toBe(false);
    expect(isUnsafe('^(?:ab)+$')).toBe(false);
    expect(isUnsafe('(a+)?$')).toBe(false);
  });

  it('should clone global/sticky regex validators without stateful flags', async () => {
    const formGroup = new FormGroup({});
    const pattern = /a/g;
    fixture.componentRef.setInput('formGroup', formGroup);
    fixture.componentRef.setInput('viewModel', { name: '' });
    fixture.componentRef.setInput('configuration', {
      type: TestSimpleComponent,
      attributes: { name: 'name', pattern }
    } as IFGDynamicItem);
    await settle(fixture);

    const control = formGroup.get('name') as unknown as FormControl;
    control.setValue('a');
    expect(control.hasError('pattern')).toBe(false);
    control.setValue('a');
    expect(control.hasError('pattern')).toBe(false);
    control.setValue('b');
    expect(control.hasError('pattern')).toBe(true);
  });

  it('should preserve numeric-key objects when setting model paths', () => {
    const model: any = { a: { 0: { x: 1 } } };
    (component as any).setModelPropertyValue(model, 'a.0.y', 2);

    expect(model.a[0].x).toBe(1);
    expect(model.a[0].y).toBe(2);
  });

  it('should reject malformed bracket paths', () => {
    const parsePath = (component as any).parsePath.bind(component);

    expect(parsePath('a[0')).toBeNull();
    expect(parsePath('a.b[')).toBeNull();
    expect(parsePath('a..b')).toBeNull();
    expect(parsePath('a[]')).toBeNull();
    expect(parsePath('a[0].b')).toEqual(['a', '0', 'b']);
    expect(parsePath("a['b.c']")).toEqual(['a', 'b.c']);
  });

  it('should project nested items into the content slot', async () => {
    fixture.componentRef.setInput('configuration', {
      type: TestWithNgContentComponent,
      items: [{ type: TestSimpleComponent }]
    } as IFGDynamicItem);
    await settle(fixture);

    const host: HTMLElement = fixture.nativeElement.querySelector('test-with-ngcontent');
    expect(host).toBeTruthy();
    expect(host.querySelector('test-simple')).toBeTruthy();
  });

  it('should reject configurations nested too deeply', async () => {
    let configuration: IFGDynamicItem = { type: TestSimpleComponent };
    for (let index = 0; index < 40; index++) {
      configuration = { type: TestWithNgContentComponent, items: [configuration] };
    }

    fixture.componentRef.setInput('configuration', configuration);
    await settle(fixture);

    expect(fixture.nativeElement.querySelector('test-simple')).toBeNull();
  });

  it('should reject configurations with too many nodes', async () => {
    const children = Array.from({ length: 700 }, () => ({
      type: TestSimpleComponent,
      items: [{ type: TestSimpleComponent }, { type: TestSimpleComponent }]
    }));

    fixture.componentRef.setInput('configuration', {
      type: TestWithNgContentComponent,
      items: children
    } as IFGDynamicItem);
    await settle(fixture);

    expect(fixture.nativeElement.querySelector('test-simple')).toBeNull();
  });

  it('should reject configurations with too many keys', async () => {
    const inputs: Record<string, unknown> = {};
    for (let index = 0; index < 101; index++) {
      inputs[`input${index}`] = index;
    }

    fixture.componentRef.setInput('configuration', { type: TestWithInputsComponent, inputs } as IFGDynamicItem);
    await settle(fixture);

    expect(fixture.nativeElement.querySelector('test-with-inputs')).toBeNull();
  });

  it('should not write form values into non-plain objects', () => {
    const marker = new TestMarker('keep');
    const model: any = { marker };

    (component as any).setModelPropertyValue(model, 'marker.label', 'changed');

    expect(marker.label).toBe('keep');
  });
});
