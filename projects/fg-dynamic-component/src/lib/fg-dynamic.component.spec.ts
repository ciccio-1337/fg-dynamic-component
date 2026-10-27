import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AbstractControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
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
});
