import { FGDynamicExpressionError, evaluateSafeExpression } from './safe-expression';

describe('evaluateSafeExpression', () => {
  it('should evaluate literals', () => {
    expect(evaluateSafeExpression('42')).toBe(42);
    expect(evaluateSafeExpression("'hello'")).toBe('hello');
    expect(evaluateSafeExpression('true')).toBe(true);
    expect(evaluateSafeExpression('null')).toBeNull();
    expect(evaluateSafeExpression('undefined')).toBeUndefined();
    expect(evaluateSafeExpression('Infinity')).toBe(Infinity);
  });

  it('should read properties and support optional chaining', () => {
    const variables = { $vm: { name: 'hello', nested: { label: 'ok' } } };

    expect(evaluateSafeExpression('$vm.name', variables)).toBe('hello');
    expect(evaluateSafeExpression("$vm['name']", variables)).toBe('hello');
    expect(evaluateSafeExpression('$vm.missing?.label', variables)).toBeUndefined();
    expect(evaluateSafeExpression('$vm.missing ?? "fallback"', variables)).toBe('fallback');
  });

  it('should evaluate calls, arrow functions and array methods', () => {
    const update = vi.fn();
    const variables = {
      $vm: () => ({ items: [1, 2], update }),
      $event: 'payload'
    };

    expect(evaluateSafeExpression('$vm().items.map(item => item * 2).join(",")', variables)).toBe('2,4');
    expect(evaluateSafeExpression('$vm().update($event)', variables, { allowedMethods: ['update'] })).toBeUndefined();
    expect(update).toHaveBeenCalledWith('payload');
  });

  it('should evaluate ternaries, comparisons and object/array literals', () => {
    const variables = { $vm: { flag: true }, $event: 3 };

    expect(evaluateSafeExpression('$vm.flag ? "yes" : "no"', variables)).toBe('yes');
    expect(evaluateSafeExpression('$event > 2', variables)).toBe(true);
    expect(evaluateSafeExpression('[1, 2, ...$vm.items]', { $vm: { items: [3] } })).toEqual([1, 2, 3]);
    expect(evaluateSafeExpression('({ ...$vm, extra: $event })', { $vm: { a: 1 }, $event: 2 })).toEqual({ a: 1, extra: 2 });
  });

  it('should reject access to globals and prototype properties', () => {
    expect(() => evaluateSafeExpression('fetch("https://evil.example/")', {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('window.location', {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm.constructor', { $vm: {} })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm.__proto__', { $vm: {} })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm["prototype"]', { $vm: {} })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm.__defineGetter__("x", () => 1)', { $vm: {} })).toThrow(FGDynamicExpressionError);
  });

  it('should reject assignments, new, this and unsupported syntax', () => {
    expect(() => evaluateSafeExpression('$vm.value = 1', { $vm: {} })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('new $vm.Type()', { $vm: {} })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('this', {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('`template`', {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('/regex/', {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('let x = 1', {})).toThrow(FGDynamicExpressionError);
  });

  it('should reject oversized or empty expressions', () => {
    expect(() => evaluateSafeExpression('', {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('1'.repeat(2001), {})).toThrow(FGDynamicExpressionError);
  });

  it('should reject expressions nested too deeply', () => {
    expect(() => evaluateSafeExpression(`${'('.repeat(100)}1${')'.repeat(100)}`, {})).toThrow(FGDynamicExpressionError);
  });

  it('should enforce parse depth for arrays, objects and calls', () => {
    expect(() => evaluateSafeExpression(`${'['.repeat(200)}1${']'.repeat(200)}`, {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression(`${'({ a: '.repeat(100)}1${' })'.repeat(100)}`, {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression(`${'f('.repeat(200)}${')'.repeat(200)}`, { f: () => 1 })).toThrow(FGDynamicExpressionError);
  });

  it('should enforce parse depth for unary and exponent chains', () => {
    expect(() => evaluateSafeExpression(`${'!'.repeat(200)}true`, {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression(`${'2 ** '.repeat(200)}1`, {})).toThrow(FGDynamicExpressionError);
  });

  it('should support optional calls', () => {
    expect(evaluateSafeExpression('$vm.missing?.()', { $vm: {} })).toBeUndefined();
    expect(evaluateSafeExpression('$vm.run?.()', { $vm: { run: () => 'ran' } }, { allowedMethods: ['run'] })).toBe('ran');
  });

  it('should reject DOM host objects and host-object results', () => {
    const element = document.createElement('button');
    const event = new MouseEvent('click');

    expect(() => evaluateSafeExpression('$event.target', { $event: event })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$event.ownerDocument', { $event: element })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$event.defaultView', { $event: document })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$event', { $event: element })).toThrow(FGDynamicExpressionError);
    // A plain wrapper that returns a host object must not become a stepping stone.
    expect(() => evaluateSafeExpression('$event.target', { $event: { target: element } })).toThrow(FGDynamicExpressionError);
  });

  it('should require an allowlist for custom methods', () => {
    const save = vi.fn();
    const variables = { $vm: () => ({ save }) };

    expect(() => evaluateSafeExpression('$vm().save(1)', variables)).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm().save(1)', variables, { allowedMethods: ['save'] })).not.toThrow();
    expect(save).toHaveBeenCalledWith(1);
    expect(() => evaluateSafeExpression('$vm().save(2)', variables, { allowCustomMethods: true })).not.toThrow();
    expect(save).toHaveBeenCalledWith(2);
  });

  it('should block call/apply/bind and custom prototype methods', () => {
    const variables = { $vm: () => ({ items: [1, 2], save: () => 'saved' }) };

    expect(() => evaluateSafeExpression('$vm().save.call(null)', variables, { allowedMethods: ['save'] })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm().save.apply(null, [])', variables, { allowedMethods: ['save'] })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm().save.bind(null)', variables, { allowedMethods: ['save'] })).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm().items.map.call(null, item => item)', variables)).toThrow(FGDynamicExpressionError);
  });

  it('should reject inherited properties and accessors on class instances', () => {
    class Service {
      save(): string {
        return 'saved';
      }

      get secret(): string {
        return 'secret';
      }
    }

    const service = new Service();
    const variables = { $vm: service };

    expect(() => evaluateSafeExpression('$vm.secret', variables)).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm.save', variables)).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression('$vm.save()', variables, { allowCustomMethods: true })).not.toThrow();
  });

  it('should cap native string growth', () => {
    expect(() => evaluateSafeExpression("'x'.repeat(100000000)", {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression("'x'.padStart(100000000)", {})).toThrow(FGDynamicExpressionError);
    expect(() => evaluateSafeExpression("'x'.repeat(100000)", {})).toThrow(FGDynamicExpressionError);
    expect(evaluateSafeExpression("'x'.repeat(16)", {})).toBe('x'.repeat(16));
  });
});
