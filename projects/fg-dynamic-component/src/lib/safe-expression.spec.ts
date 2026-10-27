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
    expect(evaluateSafeExpression('$vm().update($event)', variables)).toBeUndefined();
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
});
