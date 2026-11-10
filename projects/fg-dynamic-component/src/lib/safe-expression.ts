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
 *
 * Expressions are also treated as a capability boundary: browser host objects
 * (DOM nodes, events, `window`, `document`, storage, …) are never readable and
 * methods can only be invoked through an allowlist. This prevents an expression
 * from escaping through `$event`/`$vm` values that happen to reference the DOM.
 */

const MAX_SOURCE_LENGTH = 2000;
const MAX_TOKENS = 4000;
const MAX_PARSE_DEPTH = 80;
const MAX_EVALUATION_STEPS = 20000;
const MAX_EVALUATION_DEPTH = 80;
const MAX_STRING_LENGTH = 100000;
const MAX_REPEAT_COUNT = 10000;

/**
 * Public policy for expression evaluation.
 *
 * By default expressions are read-only and can only call native built-ins
 * (`Array.prototype.map`, `String.prototype.slice`, …) plus the callable `$vm`
 * wrapper. Custom view-model methods and `$vm.set`/`$vm.update` must be enabled
 * explicitly by the host application.
 */
export interface FGDynamicExpressionOptions {
    /** Allow calling any method found on a view-model value. Defaults to `false`. */
    allowCustomMethods?: boolean;
    /** Method names that may be called even when `allowCustomMethods` is false. */
    allowedMethods?: readonly string[];
}

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
    '__lookupSetter__',
    // Function capabilities that can defeat the method policy.
    'call',
    'apply',
    'bind',
    // Browser globals and DOM escape hatches.
    'window',
    'self',
    'globalThis',
    'global',
    'top',
    'parent',
    'frames',
    'opener',
    'document',
    'ownerDocument',
    'defaultView',
    'contentWindow',
    'contentDocument',
    'location',
    'cookie',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'navigator',
    'history',
    'screen',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'Worker',
    'importScripts',
    'postMessage',
    'sendBeacon',
    'setTimeout',
    'setInterval',
    'setImmediate',
    'requestAnimationFrame',
    'open',
    'close',
    'write',
    'writeln',
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'eval',
    'Function'
]);

/**
 * Built-in methods that are safe to invoke from an expression. Identity checks
 * are used instead of name checks, so an attacker cannot shadow `map` with a
 * custom function and have it accepted.
 */
const SAFE_NATIVE_METHODS: ReadonlySet<Function> = new Set<Function>([
    Array.prototype.at,
    Array.prototype.concat,
    Array.prototype.entries,
    Array.prototype.every,
    Array.prototype.filter,
    Array.prototype.find,
    Array.prototype.findIndex,
    Array.prototype.flat,
    Array.prototype.flatMap,
    Array.prototype.forEach,
    Array.prototype.includes,
    Array.prototype.indexOf,
    Array.prototype.join,
    Array.prototype.keys,
    Array.prototype.lastIndexOf,
    Array.prototype.map,
    Array.prototype.reduce,
    Array.prototype.reduceRight,
    Array.prototype.slice,
    Array.prototype.some,
    Array.prototype.toLocaleString,
    Array.prototype.toString,
    Array.prototype.values,
    String.prototype.at,
    String.prototype.charAt,
    String.prototype.charCodeAt,
    String.prototype.codePointAt,
    String.prototype.concat,
    String.prototype.endsWith,
    String.prototype.includes,
    String.prototype.indexOf,
    String.prototype.lastIndexOf,
    String.prototype.localeCompare,
    String.prototype.normalize,
    String.prototype.padEnd,
    String.prototype.padStart,
    String.prototype.repeat,
    String.prototype.replace,
    String.prototype.replaceAll,
    String.prototype.slice,
    String.prototype.split,
    String.prototype.startsWith,
    String.prototype.substring,
    String.prototype.substr,
    String.prototype.toLocaleLowerCase,
    String.prototype.toLocaleUpperCase,
    String.prototype.toLowerCase,
    String.prototype.toString,
    String.prototype.toUpperCase,
    String.prototype.trim,
    String.prototype.trimEnd,
    String.prototype.trimStart,
    String.prototype.valueOf,
    Number.prototype.toExponential,
    Number.prototype.toFixed,
    Number.prototype.toLocaleString,
    Number.prototype.toPrecision,
    Number.prototype.toString,
    Number.prototype.valueOf,
    Boolean.prototype.toString,
    Boolean.prototype.valueOf,
    BigInt.prototype.toString,
    BigInt.prototype.valueOf,
    Date.prototype.getDate,
    Date.prototype.getDay,
    Date.prototype.getFullYear,
    Date.prototype.getHours,
    Date.prototype.getMilliseconds,
    Date.prototype.getMinutes,
    Date.prototype.getMonth,
    Date.prototype.getSeconds,
    Date.prototype.getTime,
    Date.prototype.getUTCDate,
    Date.prototype.getUTCFullYear,
    Date.prototype.toISOString,
    Date.prototype.toJSON,
    Date.prototype.toLocaleDateString,
    Date.prototype.toLocaleString,
    Date.prototype.toLocaleTimeString,
    Date.prototype.toString,
    Date.prototype.valueOf,
    Object.prototype.hasOwnProperty,
    Object.prototype.isPrototypeOf,
    Object.prototype.propertyIsEnumerable,
    Object.prototype.toLocaleString,
    Object.prototype.toString,
    Object.prototype.valueOf
]);

const INTERPRETER_FUNCTIONS = new WeakSet<Function>();

const HOST_OBJECT_TAGS: ReadonlySet<string> = new Set([
    'Window',
    'global',
    'globalThis',
    'Document',
    'HTMLDocument',
    'XMLDocument',
    'DocumentFragment',
    'DocumentType',
    'Node',
    'NodeList',
    'HTMLCollection',
    'NamedNodeMap',
    'Element',
    'Event',
    'EventTarget',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'InputEvent',
    'Storage',
    'Location',
    'History',
    'Navigator',
    'Screen',
    'XMLHttpRequest',
    'WebSocket',
    'Worker',
    'MessagePort',
    'MessageChannel',
    'File',
    'FileList',
    'FileReader',
    'Blob',
    'FormData',
    'URL',
    'URLSearchParams',
    'MutationObserver',
    'IntersectionObserver',
    'ResizeObserver',
    'Performance'
]);

function isHostObject(value: unknown): boolean {
    if (value == null || (typeof value !== 'object' && typeof value !== 'function')) {
        return false;
    }

    if (value === globalThis) {
        return true;
    }

    try {
        const tag = Object.prototype.toString.call(value).slice(8, -1);

        if (HOST_OBJECT_TAGS.has(tag)) {
            return true;
        }

        // DOM element/event subclasses use tagged names such as
        // `HTMLButtonElement` or `PointerEvent`.
        if (/(?:Element|Event|Document|Node|Observer|Collection|List|Map)$/.test(tag)
            && tag !== 'Map'
            && tag !== 'WeakMap'
            && tag !== 'Set'
            && tag !== 'WeakSet') {
            return true;
        }
    } catch {
        return true;
    }

    return false;
}

function isNativeFunction(value: unknown): value is Function {
    return typeof value === 'function' && SAFE_NATIVE_METHODS.has(value);
}

function isInterpreterFunction(value: unknown): value is Function {
    return typeof value === 'function' && INTERPRETER_FUNCTIONS.has(value);
}

function assertSafeValue(value: unknown): unknown {
    if (isHostObject(value)) {
        fail('Access to host objects is not allowed.');
    }
    return value;
}

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
            this.enter();
            try {
                const right = this.parseExponent();
                return { type: 'Binary', operator: '**', left, right };
            } finally {
                this.leave();
            }
        }
        return left;
    }

    private parseUnary(): Node {
        if (
            isPunctuator(this.current(), '!') ||
            isPunctuator(this.current(), '-') ||
            isPunctuator(this.current(), '+')
        ) {
            this.enter();
            try {
                const operator = this.advance().value;
                return { type: 'Unary', operator, argument: this.parseUnary() };
            } finally {
                this.leave();
            }
        }

        if (isIdentifier(this.current(), 'typeof')) {
            this.enter();
            try {
                this.advance();
                return { type: 'Unary', operator: 'typeof', argument: this.parseUnary() };
            } finally {
                this.leave();
            }
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
        this.enter();
        try {
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
        } finally {
            this.leave();
        }
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
        this.enter();
        try {
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
        } finally {
            this.leave();
        }
    }

    private parseObject(): Node {
        this.enter();
        try {
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
        } finally {
            this.leave();
        }
    }
}

function assertSafeProperty(property: string): void {
    if (FORBIDDEN_PROPERTIES.has(property)) {
        fail('Access to a forbidden property was blocked.');
    }
}

function isMethodAllowed(name: string, options?: FGDynamicExpressionOptions): boolean {
    if (options?.allowCustomMethods === true) {
        return true;
    }
    return Array.isArray(options?.allowedMethods) && options!.allowedMethods!.includes(name);
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

function readMember(target: unknown, key: unknown, optional: boolean, options?: FGDynamicExpressionOptions): unknown {
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

    // Reject DOM/browser host objects before any property access or getter runs.
    if (isHostObject(target)) {
        fail('Access to host objects is not allowed.');
    }

    const object = Object(target) as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(object, property);

    if (descriptor) {
        if (!('value' in descriptor)) {
            // Accessor properties can execute arbitrary code.
            fail('Access to accessor properties is not allowed.');
        }
        const value = descriptor.value;
        if (typeof value === 'function'
            && !isNativeFunction(value)
            && !isInterpreterFunction(value)
            && !isMethodAllowed(property, options)) {
            fail('Access to custom methods is not allowed.');
        }
        return assertSafeValue(value);
    }

    // Inherited properties are only readable for explicitly safe methods, so
    // class instances cannot leak services through their prototype chain.
    let prototype = Object.getPrototypeOf(object);
    while (prototype) {
        const inheritedDescriptor = Object.getOwnPropertyDescriptor(prototype, property);
        if (inheritedDescriptor) {
            if (!('value' in inheritedDescriptor)) {
                fail('Access to inherited accessor properties is not allowed.');
            }
            const inherited = inheritedDescriptor.value;
            if (typeof inherited === 'function') {
                if (isNativeFunction(inherited) || isInterpreterFunction(inherited) || isMethodAllowed(property, options)) {
                    return inherited;
                }
                fail('Access to custom methods is not allowed.');
            }
            fail('Access to inherited properties is not allowed.');
        }
        prototype = Object.getPrototypeOf(prototype);
    }

    return undefined;
}

function spreadValues(value: unknown): unknown[] {
    if (Array.isArray(value)) {
        return value.slice();
    }
    if (typeof value === 'string') {
        if (value.length > MAX_STRING_LENGTH) {
            fail('Spread value is too large.');
        }
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

function evaluateNode(node: Node, environment: Map<string, unknown>, state: EvaluationState, options?: FGDynamicExpressionOptions): unknown {
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
                return assertSafeValue(environment.get(node.name));
            }

            case 'Member': {
                const object = evaluateNode(node.object, environment, state, options);
                const key = evaluateNode(node.property, environment, state, options);
                return readMember(object, key, node.optional, options);
            }

            case 'Call': {
                let fn: unknown;
                let thisArg: unknown;
                let methodName: string | undefined;

                if (node.callee.type === 'Member') {
                    const object = evaluateNode(node.callee.object, environment, state, options);
                    const key = evaluateNode(node.callee.property, environment, state, options);
                    fn = readMember(object, key, node.callee.optional, options);
                    thisArg = object;
                    methodName = String(key);
                } else {
                    fn = evaluateNode(node.callee, environment, state, options);
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

                // Direct calls (`$vm()`, interpreter arrows) use host-provided
                // capabilities. Member calls must be native built-ins,
                // interpreter-created arrows, or explicitly allowed methods.
                if (node.callee.type === 'Member') {
                    if (!isNativeFunction(fn)
                        && !isInterpreterFunction(fn)
                        && !isMethodAllowed(methodName ?? '', options)) {
                        return fail('Calling custom methods is not allowed.');
                    }
                } else {
                    const isVmCall = node.callee.type === 'Identifier' && node.callee.name === '$vm';
                    if (!isVmCall && !isInterpreterFunction(fn) && !isMethodAllowed('', options)) {
                        return fail('Calling custom functions is not allowed.');
                    }
                }

                const args: unknown[] = [];
                for (const argument of node.args) {
                    const value = evaluateNode(argument.value, environment, state, options);
                    if (argument.spread) {
                        args.push(...spreadValues(value));
                    } else {
                        args.push(value);
                    }
                }

                // Bound native string builders before they allocate.
                if (fn === String.prototype.repeat) {
                    const count = args[0];
                    const source = String(thisArg ?? '');
                    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0
                        || count > MAX_REPEAT_COUNT || source.length * count > MAX_STRING_LENGTH) {
                        return fail('String repetition is too large.');
                    }
                }
                if ((fn === String.prototype.padStart || fn === String.prototype.padEnd)) {
                    const targetLength = args[0];
                    if (typeof targetLength === 'number' && targetLength > MAX_STRING_LENGTH) {
                        return fail('String padding is too large.');
                    }
                }
                if (fn === Array.prototype.join && Array.isArray(thisArg) && thisArg.length > MAX_STRING_LENGTH) {
                    return fail('Array join is too large.');
                }

                const result = (fn as (...args: unknown[]) => unknown).apply(thisArg, args);

                if (typeof result === 'string' && result.length > MAX_STRING_LENGTH) {
                    return fail('Expression result is too large.');
                }

                return assertSafeValue(result);
            }

            case 'Unary': {
                const argument = evaluateNode(node.argument, environment, state, options);
                switch (node.operator) {
                    case '!': return !argument;
                    case 'typeof': return typeof argument;
                    case '-':
                        if (typeof argument !== 'number' && typeof argument !== 'bigint') {
                            return fail('Unary "-" only supports numbers.');
                        }
                        return -argument;
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
                const left = evaluateNode(node.left, environment, state, options);
                const right = evaluateNode(node.right, environment, state, options);

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
                const left = evaluateNode(node.left, environment, state, options);
                switch (node.operator) {
                    case '&&': return left ? evaluateNode(node.right, environment, state, options) : left;
                    case '||': return left ? left : evaluateNode(node.right, environment, state, options);
                    case '??': return left == null ? evaluateNode(node.right, environment, state, options) : left;
                    default: return fail(`Unsupported logical operator "${node.operator}".`);
                }
            }

            case 'Conditional':
                return evaluateNode(node.test, environment, state, options)
                    ? evaluateNode(node.consequent, environment, state, options)
                    : evaluateNode(node.alternate, environment, state, options);

            case 'Array': {
                const values: unknown[] = [];
                for (const element of node.elements) {
                    const value = evaluateNode(element.value, environment, state, options);
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
                        const source = evaluateNode(property.value, environment, state, options);
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
                        ? evaluateNode(property.key, environment, state, options)
                        : (property.key as { type: 'Literal'; value: unknown }).value;

                    if (typeof key !== 'string' && typeof key !== 'number') {
                        return fail('Object keys must be strings or numbers.');
                    }

                    defineSafeProperty(result, String(key), evaluateNode(property.value, environment, state, options));
                }
                return result;
            }

            case 'Arrow': {
                const params = node.params;
                const body = node.body;
                const closure = new Map(environment);

                const arrowFunction = function evaluateArrowFunction(...args: unknown[]): unknown {
                    const local = new Map(closure);
                    params.forEach((parameter: string, index: number): void => {
                        local.set(parameter, args[index]);
                    });
                    return evaluateNode(body, local, state, options);
                };

                INTERPRETER_FUNCTIONS.add(arrowFunction);
                return arrowFunction;
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
 *
 * `options` controls whether custom view-model methods may be invoked. Native
 * built-ins are always available; host objects are never accessible.
 */
export function evaluateSafeExpression(
    source: string,
    variables: Record<string, unknown> = {},
    options?: FGDynamicExpressionOptions
): unknown {
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

    return assertSafeValue(evaluateNode(ast, environment, { steps: 0, depth: 0 }, options));
}
