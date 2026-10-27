/**
 * Small, allowlisted expression interpreter used for the `$vm` / `$event` binding
 * feature of `FGDynamicComponent`.
 *
 * This intentionally does NOT use `eval`, `new Function`, or any other
 * string-to-code primitive. Only the following constructs are supported:
 *
 * - literals (string, number, boolean, null, undefined, NaN, Infinity)
 * - identifiers from the provided variables (`$vm`, `$event`, arrow parameters)
 * - member access: `a.b`, `a['b']`, optional chaining `a?.b`
 * - calls: `$vm()`, `$vm.update(fn)`, `$event.value`
 * - unary: `!`, `-`, `+`, `typeof`
 * - binary/logical/ternary operators
 * - array and object literals, including spread
 * - expression-bodied arrow functions (and arrow blocks containing `return`)
 *
 * Assignments, `new`, `this`, globals (e.g. `window`, `fetch`), template
 * literals and regular-expression literals are rejected. Prototype-related
 * property names are blocked at every access.
 */

const MAX_SOURCE_LENGTH = 2000;
const MAX_TOKENS = 4000;
const MAX_PARSE_DEPTH = 80;
const MAX_EVALUATION_STEPS = 20000;
const MAX_EVALUATION_DEPTH = 80;

const FORBIDDEN_PROPERTIES: ReadonlySet<string> = new Set([
    '__proto__',
    'prototype',
    'constructor',
    'caller',
    'callee',
    'arguments',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__'
]);

const PUNCTUATORS: readonly string[] = [
    '===', '!==', '**', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '...', '=>',
    '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '.', ',', '(', ')', '[', ']', '{', '}', ';'
];

type TokenType = 'number' | 'string' | 'identifier' | 'punctuator' | 'eof';

interface Token {
    type: TokenType;
    value: string;
    position: number;
}

interface ArgumentNode {
    spread: boolean;
    value: Node;
}

interface ObjectProperty {
    spread: boolean;
    key?: Node;
    value: Node;
    computed: boolean;
}

type Node =
    | { type: 'Literal'; value: unknown }
    | { type: 'Identifier'; name: string }
    | { type: 'Member'; object: Node; property: Node; computed: boolean; optional: boolean }
    | { type: 'Call'; callee: Node; args: ArgumentNode[]; optional: boolean }
    | { type: 'Unary'; operator: string; argument: Node }
    | { type: 'Binary'; operator: string; left: Node; right: Node }
    | { type: 'Logical'; operator: string; left: Node; right: Node }
    | { type: 'Conditional'; test: Node; consequent: Node; alternate: Node }
    | { type: 'Array'; elements: ArgumentNode[] }
    | { type: 'Object'; properties: ObjectProperty[] }
    | { type: 'Arrow'; params: string[]; body: Node; block: boolean };

interface EvaluationState {
    steps: number;
    depth: number;
}

export class FGDynamicExpressionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FGDynamicExpressionError';
    }
}

function fail(message: string): never {
    throw new FGDynamicExpressionError(message);
}

function isPunctuator(token: Token, value: string): boolean {
    return token.type === 'punctuator' && token.value === value;
}

function isIdentifier(token: Token, value: string): boolean {
    return token.type === 'identifier' && token.value === value;
}

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;

    while (index < source.length) {
        const character = source[index];

        if (/\s/.test(character)) {
            index++;
            continue;
        }

        if (character === '"' || character === "'") {
            const quote = character;
            let value = '';
            let cursor = index + 1;
            let closed = false;

            while (cursor < source.length) {
                const current = source[cursor];

                if (current === quote) {
                    cursor++;
                    closed = true;
                    break;
                }

                if (current === '\\') {
                    const escaped = source[cursor + 1];
                    if (escaped === undefined) {
                        fail('Unterminated string literal.');
                    }

                    switch (escaped) {
                        case 'n': value += '\n'; break;
                        case 'r': value += '\r'; break;
                        case 't': value += '\t'; break;
                        case 'b': value += '\b'; break;
                        case 'f': value += '\f'; break;
                        case 'v': value += '\v'; break;
                        case '0': value += '\0'; break;
                        case 'u': {
                            const hex = source.slice(cursor + 2, cursor + 6);
                            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                                fail('Invalid unicode escape sequence.');
                            }
                            value += String.fromCharCode(parseInt(hex, 16));
                            cursor += 4;
                            break;
                        }
                        default: value += escaped; break;
                    }

                    cursor += 2;
                    continue;
                }

                value += current;
                cursor++;
            }

            if (!closed) {
                fail('Unterminated string literal.');
            }

            tokens.push({ type: 'string', value, position: index });
            index = cursor;
            continue;
        }

        if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
            const match = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(source.slice(index));
            if (!match) {
                fail('Invalid number literal.');
            }
            const raw = match[0];
            const numeric = Number(raw);
            if (!Number.isFinite(numeric)) {
                fail('Number literal is not finite.');
            }
            tokens.push({ type: 'number', value: raw, position: index });
            index += raw.length;
            continue;
        }

        if (/[A-Za-z_$]/.test(character)) {
            const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
            if (!match) {
                fail('Invalid identifier.');
            }
            tokens.push({ type: 'identifier', value: match[0], position: index });
            index += match[0].length;
            continue;
        }

        const punctuator = PUNCTUATORS.find((candidate: string): boolean => source.startsWith(candidate, index));
        if (!punctuator) {
            fail('Unexpected character in expression.');
        }

        tokens.push({ type: 'punctuator', value: punctuator, position: index });
        index += punctuator.length;
    }

    tokens.push({ type: 'eof', value: '', position: source.length });

    if (tokens.length > MAX_TOKENS) {
        fail('Expression is too complex.');
    }

    return tokens;
}

class ExpressionParser {
    private index = 0;
    private depth = 0;
    private readonly tokens: Token[];

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    parse(): Node {
        const expression = this.parseExpression();
        if (this.current().type !== 'eof') {
            fail('Unexpected token after expression.');
        }
        return expression;
    }

    private current(): Token {
        return this.tokens[this.index];
    }

    private peek(offset = 1): Token | undefined {
        return this.tokens[this.index + offset];
    }

    private advance(): Token {
        const token = this.tokens[this.index];
        if (token.type !== 'eof') {
            this.index++;
        }
        return token;
    }

    private matchPunctuator(value: string): boolean {
        if (isPunctuator(this.current(), value)) {
            this.advance();
            return true;
        }
        return false;
    }

    private expectPunctuator(value: string): void {
        if (!this.matchPunctuator(value)) {
            fail(`Expected "${value}".`);
        }
    }

    private enter(): void {
        this.depth++;
        if (this.depth > MAX_PARSE_DEPTH) {
            fail('Expression is nested too deeply.');
        }
    }

    private leave(): void {
        this.depth--;
    }

    private parseExpression(): Node {
        this.enter();
        try {
            return this.parseAssignment();
        } finally {
            this.leave();
        }
    }

    private parseAssignment(): Node {
        if (this.isArrowStart()) {
            return this.parseArrow();
        }
        return this.parseConditional();
    }

    private isArrowStart(): boolean {
        const token = this.current();

        if (token.type === 'identifier' && this.peek()?.value === '=>') {
            return true;
        }

        if (!isPunctuator(token, '(')) {
            return false;
        }

        let nesting = 0;
        for (let cursor = this.index; cursor < this.tokens.length; cursor++) {
            const candidate = this.tokens[cursor];
            if (candidate.type !== 'punctuator') {
                continue;
            }
            if (candidate.value === '(') {
                nesting++;
            } else if (candidate.value === ')') {
                nesting--;
                if (nesting === 0) {
                    return this.tokens[cursor + 1]?.value === '=>';
                }
            }
        }

        return false;
    }

    private parseArrow(): Node {
        const params: string[] = [];

        if (this.current().type === 'identifier') {
            params.push(this.advance().value);
        } else {
            this.expectPunctuator('(');
            if (!isPunctuator(this.current(), ')')) {
                do {
                    if (isPunctuator(this.current(), ')')) {
                        break;
                    }
                    const parameter = this.advance();
                    if (parameter.type !== 'identifier') {
                        fail('Arrow function parameters must be identifiers.');
                    }
                    if (FORBIDDEN_PROPERTIES.has(parameter.value)) {
                        fail('Forbidden arrow function parameter name.');
                    }
                    params.push(parameter.value);
                } while (this.matchPunctuator(','));
            }
            this.expectPunctuator(')');
        }

        this.expectPunctuator('=>');

        if (this.matchPunctuator('{')) {
            while (this.matchPunctuator(';')) {
                // Skip empty statements.
            }

            if (!isIdentifier(this.current(), 'return')) {
                fail('Arrow function blocks must contain a return statement.');
            }

            this.advance();
            const value = this.parseExpression();
            this.matchPunctuator(';');
            this.expectPunctuator('}');
            return { type: 'Arrow', params, body: value, block: true };
        }

        return { type: 'Arrow', params, body: this.parseExpression(), block: false };
    }

    private parseConditional(): Node {
        const test = this.parseNullish();

        if (this.matchPunctuator('?')) {
            const consequent = this.parseAssignment();
            this.expectPunctuator(':');
            const alternate = this.parseAssignment();
            return { type: 'Conditional', test, consequent, alternate };
        }

        return test;
    }

    private parseNullish(): Node {
        let left = this.parseLogicalOr();
        while (this.matchPunctuator('??')) {
            const right = this.parseLogicalOr();
            left = { type: 'Logical', operator: '??', left, right };
        }
        return left;
    }

    private parseLogicalOr(): Node {
        let left = this.parseLogicalAnd();
        while (this.matchPunctuator('||')) {
            const right = this.parseLogicalAnd();
            left = { type: 'Logical', operator: '||', left, right };
        }
        return left;
    }

    private parseLogicalAnd(): Node {
        let left = this.parseEquality();
        while (this.matchPunctuator('&&')) {
            const right = this.parseEquality();
            left = { type: 'Logical', operator: '&&', left, right };
        }
        return left;
    }

    private parseEquality(): Node {
        let left = this.parseRelational();
        while (
            isPunctuator(this.current(), '===') ||
            isPunctuator(this.current(), '!==') ||
            isPunctuator(this.current(), '==') ||
            isPunctuator(this.current(), '!=')
        ) {
            const operator = this.advance().value;
            const right = this.parseRelational();
            left = { type: 'Binary', operator, left, right };
        }
        return left;
    }

    private parseRelational(): Node {
        let left = this.parseAdditive();
        while (
            isPunctuator(this.current(), '<') ||
            isPunctuator(this.current(), '>') ||
            isPunctuator(this.current(), '<=') ||
            isPunctuator(this.current(), '>=')
        ) {
            const operator = this.advance().value;
            const right = this.parseAdditive();
            left = { type: 'Binary', operator, left, right };
        }
        return left;
    }

    private parseAdditive(): Node {
        let left = this.parseMultiplicative();
        while (isPunctuator(this.current(), '+') || isPunctuator(this.current(), '-')) {
            const operator = this.advance().value;
            const right = this.parseMultiplicative();
            left = { type: 'Binary', operator, left, right };
        }
        return left;
    }

    private parseMultiplicative(): Node {
        let left = this.parseExponent();
        while (
            isPunctuator(this.current(), '*') ||
            isPunctuator(this.current(), '/') ||
            isPunctuator(this.current(), '%')
        ) {
            const operator = this.advance().value;
            const right = this.parseExponent();
            left = { type: 'Binary', operator, left, right };
        }
        return left;
    }

    private parseExponent(): Node {
        const left = this.parseUnary();
        if (this.matchPunctuator('**')) {
            const right = this.parseExponent();
            return { type: 'Binary', operator: '**', left, right };
        }
        return left;
    }

    private parseUnary(): Node {
        if (
            isPunctuator(this.current(), '!') ||
            isPunctuator(this.current(), '-') ||
            isPunctuator(this.current(), '+')
        ) {
            const operator = this.advance().value;
            return { type: 'Unary', operator, argument: this.parseUnary() };
        }

        if (isIdentifier(this.current(), 'typeof')) {
            this.advance();
            return { type: 'Unary', operator: 'typeof', argument: this.parseUnary() };
        }

        return this.parsePostfix();
    }

    private parsePostfix(): Node {
        let node = this.parsePrimary();

        for (;;) {
            if (this.matchPunctuator('.')) {
                const property = this.advance();
                if (property.type !== 'identifier') {
                    fail('Expected a property name.');
                }
                node = {
                    type: 'Member',
                    object: node,
                    property: { type: 'Literal', value: property.value },
                    computed: false,
                    optional: false
                };
                continue;
            }

            if (this.matchPunctuator('?.')) {
                if (this.matchPunctuator('(')) {
                    node = { type: 'Call', callee: node, args: this.parseArguments(), optional: true };
                } else if (this.matchPunctuator('[')) {
                    const property = this.parseExpression();
                    this.expectPunctuator(']');
                    node = { type: 'Member', object: node, property, computed: true, optional: true };
                } else {
                    const property = this.advance();
                    if (property.type !== 'identifier') {
                        fail('Expected a property name.');
                    }
                    node = {
                        type: 'Member',
                        object: node,
                        property: { type: 'Literal', value: property.value },
                        computed: false,
                        optional: true
                    };
                }
                continue;
            }

            if (this.matchPunctuator('[')) {
                const property = this.parseExpression();
                this.expectPunctuator(']');
                node = { type: 'Member', object: node, property, computed: true, optional: false };
                continue;
            }

            if (this.matchPunctuator('(')) {
                node = { type: 'Call', callee: node, args: this.parseArguments(), optional: false };
                continue;
            }

            break;
        }

        return node;
    }

    private parseArguments(): ArgumentNode[] {
        const args: ArgumentNode[] = [];

        if (!isPunctuator(this.current(), ')')) {
            do {
                if (isPunctuator(this.current(), ')')) {
                    break;
                }
                const spread = this.matchPunctuator('...');
                args.push({ spread, value: this.parseAssignment() });
            } while (this.matchPunctuator(','));
        }

        this.expectPunctuator(')');
        return args;
    }

    private parsePrimary(): Node {
        const token = this.current();

        if (token.type === 'number') {
            this.advance();
            return { type: 'Literal', value: Number(token.value) };
        }

        if (token.type === 'string') {
            this.advance();
            return { type: 'Literal', value: token.value };
        }

        if (token.type === 'identifier') {
            this.advance();
            switch (token.value) {
                case 'true': return { type: 'Literal', value: true };
                case 'false': return { type: 'Literal', value: false };
                case 'null': return { type: 'Literal', value: null };
                case 'undefined': return { type: 'Literal', value: undefined };
                case 'NaN': return { type: 'Literal', value: NaN };
                case 'Infinity': return { type: 'Literal', value: Infinity };
                default: return { type: 'Identifier', name: token.value };
            }
        }

        if (this.matchPunctuator('(')) {
            const expression = this.parseExpression();
            this.expectPunctuator(')');
            return expression;
        }

        if (this.matchPunctuator('[')) {
            return this.parseArray();
        }

        if (this.matchPunctuator('{')) {
            return this.parseObject();
        }

        return fail('Unexpected token in expression.');
    }

    private parseArray(): Node {
        const elements: ArgumentNode[] = [];

        if (!isPunctuator(this.current(), ']')) {
            do {
                if (isPunctuator(this.current(), ']')) {
                    break;
                }
                const spread = this.matchPunctuator('...');
                elements.push({ spread, value: this.parseAssignment() });
            } while (this.matchPunctuator(','));
        }

        this.expectPunctuator(']');
        return { type: 'Array', elements };
    }

    private parseObject(): Node {
        const properties: ObjectProperty[] = [];

        if (!isPunctuator(this.current(), '}')) {
            do {
                if (isPunctuator(this.current(), '}')) {
                    break;
                }

                if (this.matchPunctuator('...')) {
                    properties.push({ spread: true, value: this.parseAssignment(), computed: false });
                    continue;
                }

                let key: Node;
                let computed = false;

                if (this.matchPunctuator('[')) {
                    key = this.parseExpression();
                    this.expectPunctuator(']');
                    computed = true;
                } else {
                    const keyToken = this.advance();
                    if (keyToken.type === 'identifier' || keyToken.type === 'string') {
                        key = { type: 'Literal', value: keyToken.value };
                    } else if (keyToken.type === 'number') {
                        key = { type: 'Literal', value: String(Number(keyToken.value)) };
                    } else {
                        return fail('Invalid object key.');
                    }
                }

                this.expectPunctuator(':');
                const value = this.parseAssignment();
                properties.push({ spread: false, key, value, computed });
            } while (this.matchPunctuator(','));
        }

        this.expectPunctuator('}');
        return { type: 'Object', properties };
    }
}

function assertSafeProperty(property: string): void {
    if (FORBIDDEN_PROPERTIES.has(property)) {
        fail('Access to a forbidden property was blocked.');
    }
}

function defineSafeProperty(target: Record<string, unknown>, key: string, value: unknown): void {
    assertSafeProperty(key);
    Object.defineProperty(target, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
    });
}

function readMember(target: unknown, key: unknown, optional: boolean): unknown {
    if (typeof key !== 'string' && typeof key !== 'number') {
        fail('Property keys must be strings or numbers.');
    }

    const property = String(key);
    assertSafeProperty(property);

    if (target == null) {
        if (optional) {
            return undefined;
        }
        fail('Cannot read properties of null or undefined.');
    }

    return (Object(target) as Record<string, unknown>)[property];
}

function spreadValues(value: unknown): unknown[] {
    if (Array.isArray(value)) {
        return value.slice();
    }
    if (typeof value === 'string') {
        return value.split('');
    }
    return fail('Spread is only supported for arrays and strings.');
}

function isPrimitive(value: unknown): boolean {
    return value == null || typeof value === 'string' || typeof value === 'number' ||
        typeof value === 'boolean' || typeof value === 'bigint';
}

function primitiveAdd(left: unknown, right: unknown): unknown {
    if (!isPrimitive(left) || !isPrimitive(right)) {
        fail('Arithmetic on objects is not allowed.');
    }
    return (left as number) + (right as number);
}

function numericOperation(operator: string, left: unknown, right: unknown): number {
    if (typeof left !== 'number' || typeof right !== 'number') {
        fail(`Operator "${operator}" only supports numbers.`);
    }

    switch (operator) {
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '%': return left % right;
        case '**': return left ** right;
        default: return fail(`Unsupported arithmetic operator "${operator}".`);
    }
}

function looseEquals(left: unknown, right: unknown): boolean {
    if (!isPrimitive(left) || !isPrimitive(right)) {
        fail('Loose equality is only supported for primitive values.');
    }
    return left == right;
}

function compareValues(operator: string, left: unknown, right: unknown): boolean {
    if (!isPrimitive(left) || !isPrimitive(right)) {
        fail('Comparison is only supported for primitive values.');
    }

    switch (operator) {
        case '<': return (left as number) < (right as number);
        case '>': return (left as number) > (right as number);
        case '<=': return (left as number) <= (right as number);
        case '>=': return (left as number) >= (right as number);
        default: return fail(`Unsupported comparison operator "${operator}".`);
    }
}

function evaluateNode(node: Node, environment: Map<string, unknown>, state: EvaluationState): unknown {
    state.steps++;
    state.depth++;

    if (state.steps > MAX_EVALUATION_STEPS) {
        state.depth--;
        return fail('Expression is too complex.');
    }
    if (state.depth > MAX_EVALUATION_DEPTH) {
        state.depth--;
        return fail('Expression is nested too deeply.');
    }

    try {
        switch (node.type) {
            case 'Literal':
                return node.value;

            case 'Identifier': {
                if (!environment.has(node.name)) {
                    return fail(`Unknown identifier "${node.name}".`);
                }
                return environment.get(node.name);
            }

            case 'Member': {
                const object = evaluateNode(node.object, environment, state);
                const key = evaluateNode(node.property, environment, state);
                return readMember(object, key, node.optional);
            }

            case 'Call': {
                let fn: unknown;
                let thisArg: unknown;

                if (node.callee.type === 'Member') {
                    const object = evaluateNode(node.callee.object, environment, state);
                    const key = evaluateNode(node.callee.property, environment, state);
                    fn = readMember(object, key, node.callee.optional);
                    thisArg = object;
                } else {
                    fn = evaluateNode(node.callee, environment, state);
                }

                if (fn == null && node.optional) {
                    return undefined;
                }
                if (typeof fn !== 'function') {
                    if (node.optional) {
                        return undefined;
                    }
                    return fail('Attempted to call a non-function value.');
                }
                if (fn === Function || fn === eval) {
                    return fail('Calling global constructors is not allowed.');
                }

                const args: unknown[] = [];
                for (const argument of node.args) {
                    const value = evaluateNode(argument.value, environment, state);
                    if (argument.spread) {
                        args.push(...spreadValues(value));
                    } else {
                        args.push(value);
                    }
                }

                return (fn as (...args: unknown[]) => unknown).apply(thisArg, args);
            }

            case 'Unary': {
                const argument = evaluateNode(node.argument, environment, state);
                switch (node.operator) {
                    case '!': return !argument;
                    case 'typeof': return typeof argument;
                    case '-':
                        if (typeof argument !== 'number' && typeof argument !== 'bigint') {
                            return fail('Unary "-" only supports numbers.');
                        }
                        return typeof argument === 'bigint' ? -argument : -argument;
                    case '+':
                        if (typeof argument !== 'number') {
                            return fail('Unary "+" only supports numbers.');
                        }
                        return +argument;
                    default:
                        return fail(`Unsupported unary operator "${node.operator}".`);
                }
            }

            case 'Binary': {
                const left = evaluateNode(node.left, environment, state);
                const right = evaluateNode(node.right, environment, state);

                switch (node.operator) {
                    case '===': return left === right;
                    case '!==': return left !== right;
                    case '==': return looseEquals(left, right);
                    case '!=': return !looseEquals(left, right);
                    case '+': return primitiveAdd(left, right);
                    case '-':
                    case '*':
                    case '/':
                    case '%':
                    case '**':
                        return numericOperation(node.operator, left, right);
                    case '<':
                    case '>':
                    case '<=':
                    case '>=':
                        return compareValues(node.operator, left, right);
                    default:
                        return fail(`Unsupported binary operator "${node.operator}".`);
                }
            }

            case 'Logical': {
                const left = evaluateNode(node.left, environment, state);
                switch (node.operator) {
                    case '&&': return left ? evaluateNode(node.right, environment, state) : left;
                    case '||': return left ? left : evaluateNode(node.right, environment, state);
                    case '??': return left == null ? evaluateNode(node.right, environment, state) : left;
                    default: return fail(`Unsupported logical operator "${node.operator}".`);
                }
            }

            case 'Conditional':
                return evaluateNode(node.test, environment, state)
                    ? evaluateNode(node.consequent, environment, state)
                    : evaluateNode(node.alternate, environment, state);

            case 'Array': {
                const values: unknown[] = [];
                for (const element of node.elements) {
                    const value = evaluateNode(element.value, environment, state);
                    if (element.spread) {
                        values.push(...spreadValues(value));
                    } else {
                        values.push(value);
                    }
                }
                return values;
            }

            case 'Object': {
                const result: Record<string, unknown> = {};
                for (const property of node.properties) {
                    if (property.spread) {
                        const source = evaluateNode(property.value, environment, state);
                        if (source == null || typeof source !== 'object') {
                            return fail('Object spread is only supported for objects.');
                        }
                        for (const key of Object.keys(source)) {
                            const descriptor = Object.getOwnPropertyDescriptor(source, key);
                            if (descriptor && 'value' in descriptor) {
                                defineSafeProperty(result, key, descriptor.value);
                            }
                        }
                        continue;
                    }

                    if (!property.key) {
                        return fail('Invalid object property.');
                    }

                    const key = property.computed
                        ? evaluateNode(property.key, environment, state)
                        : (property.key as { type: 'Literal'; value: unknown }).value;

                    if (typeof key !== 'string' && typeof key !== 'number') {
                        return fail('Object keys must be strings or numbers.');
                    }

                    defineSafeProperty(result, String(key), evaluateNode(property.value, environment, state));
                }
                return result;
            }

            case 'Arrow': {
                const params = node.params;
                const body = node.body;
                const closure = new Map(environment);

                return function evaluateArrowFunction(...args: unknown[]): unknown {
                    const local = new Map(closure);
                    params.forEach((parameter: string, index: number): void => {
                        local.set(parameter, args[index]);
                    });
                    return evaluateNode(body, local, state);
                };
            }

            default:
                return fail('Unsupported expression node.');
        }
    } finally {
        state.depth--;
    }
}

/**
 * Evaluates a configuration expression without ever compiling it as JavaScript.
 *
 * Only the identifiers provided in `variables` are visible. Any unsupported
 * construct throws an `FGDynamicExpressionError`; callers should treat that as
 * an invalid expression and fall back to the literal value.
 */
export function evaluateSafeExpression(source: string, variables: Record<string, unknown> = {}): unknown {
    if (typeof source !== 'string') {
        fail('Expression must be a string.');
    }
    if (source.length === 0) {
        fail('Expression is empty.');
    }
    if (source.length > MAX_SOURCE_LENGTH) {
        fail('Expression is too long.');
    }

    const parser = new ExpressionParser(tokenize(source));
    const ast = parser.parse();
    const environment = new Map<string, unknown>();

    for (const [key, value] of Object.entries(variables)) {
        environment.set(key, value);
    }

    return evaluateNode(ast, environment, { steps: 0, depth: 0 });
}
