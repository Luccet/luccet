// SPDX-License-Identifier: MIT
// Type declarations for tern.js, the engine and the runtime, as docs/api.html
// describes them. The AST is unist-shaped plain data; the shapes here name
// what the engine guarantees and leave the rest open.

declare namespace tern {
  export interface Point {
    line: number;
    column: number;
    offset: number;
  }
  export interface Position {
    start: Point;
    end: Point;
  }

  /** A node of the AST: `type`, its children or value, the author's attributes and `data.tern`, what the transforms wrote. */
  export interface Node {
    type: string;
    children?: Node[];
    value?: string;
    name?: string;
    attributes?: Record<string, string>;
    position?: Position;
    data?: { tern?: Record<string, any>; [key: string]: any };
    [key: string]: any;
  }
  export interface Root extends Node {
    type: 'root';
    children: Node[];
  }

  export type Severity = 'error' | 'warning' | 'info';
  export interface Diagnostic {
    code: string;
    severity: Severity;
    message: string;
    hint?: string;
    position: Position;
    /** The file position (the note's lines shifted by the head's), set by the command line. */
    filePosition?: Position;
  }

  /** A schema entry: the fields docs/schema.html#fields describes, all optional. */
  export interface Spec {
    tag?: string;
    class?: string;
    attrs?: Record<string, string>;
    counter?: string;
    label?: string | Record<string, string> | ((n: number | null, node: Node) => string);
    ref?: string;
    end?: string;
    slot?: string;
    raw?: boolean;
    within?: string | string[];
    css?: string;
    dom?: (el: Element) => void;
    [key: string]: any;
  }
  export interface Schema {
    block: Record<string, Spec>;
    leaf: Record<string, Spec>;
    inline: Record<string, Spec>;
    strict?: boolean;
  }

  export interface ParseOptions {
    /** The vocabulary; the registry when absent. */
    schema?: Schema;
    /** The preserved head, the HTML before the tern.js line. */
    head?: string;
    /** The label language. */
    lang?: string;
    /** The nesting limit of blocks, 64 by default. */
    maxDepth?: number;
  }
  export interface EmitOptions extends ParseOptions {
    /** Write data-pos on block elements (true). */
    positions?: boolean;
    /** Render an untrusted source: raw HTML escaped, risky attributes and URLs dropped. */
    safe?: boolean;
    /** Prefix every id and fragment link. */
    idPrefix?: string;
    /** The output budget in characters, 64 million by default; output.limit past it. */
    maxOutput?: number;
    /** The emitter's own words (footnotes, back, done, todo), overriding the label language's. */
    strings?: Record<string, string>;
    /** The runtime's: presentational styles as data attributes, applied through the CSSOM. */
    cssom?: boolean;
  }

  export interface Outline {
    headings: Array<{ line: number; depth: number; id?: string; text: string }>;
    blocks: Array<{ line: number; endLine: number; kind: 'container' | 'leaf'; name: string; id?: string; title?: string; label?: string; colons?: number }>;
    refs: Array<{ line: number; col: number; end: number; id: string; text?: string; resolved?: boolean }>;
    math: Array<{ line: number; col: number; endLine: number; end: number; display: boolean; number?: string; tex: string }>;
    tables: Array<{ line: number; endLine: number }>;
    raw: Array<{ line: number; endLine: number; kind?: string }>;
    inline: Array<{ line: number; col: number; end: number; name: string }>;
  }

  export interface SearchEntry {
    url: string;
    id?: string;
    kind: string;
    label?: string;
    title?: string;
    text: string;
    line?: number;
    endLine?: number;
    [key: string]: any;
  }
  export interface SearchIndex {
    entries: SearchEntry[];
    terms: Record<string, Array<[number, number]>>;
    lengths: number[];
    avg: number;
  }
  export interface SearchHit {
    entry: SearchEntry;
    score: number;
    matched: string[];
  }
  export interface Search {
    records(ast: Root, info: { url: string; title?: string }): SearchEntry[];
    index(entries: SearchEntry[]): SearchIndex;
    query(index: SearchIndex, text: string, opts?: { limit?: number }): SearchHit[];
    snippet(text: string, matched: string[], opts?: { width?: number }): { text: string; marks: Array<[number, number]> };
    title(head: string, ast: Root): string;
    describe(head: string, ast: Root): { title: string; description: string; meta: Record<string, string>; headings: Outline['headings']; links: string[] };
    /** The format of search.json, which `tern index` writes into the file: a reader takes a file of its own format, whatever version wrote it. 1 since 1.0; changes only in a major release. */
    readonly format: number;
  }

  /** A term a note defines (docs/api.html#glossary): a `:dfn[…]` or a titled `:::definition` block. */
  export interface GlossaryTerm {
    term: string;
    /** The term folded as search folds words. */
    key: string;
    /** An id for the term on a glossary page, from the key. */
    slug: string;
    /** The anchor nearest above the term: its own, its block's, else its section's heading's. */
    id: string;
    line: number;
    /** 'dfn', or the block's name. */
    how: string;
    /** The definition's nodes, positions removed, for emit on another page. */
    definition: Node[];
    [key: string]: any;
  }
  export interface Glossary {
    terms(ast: Root, opts?: { blocks?: string[] }): GlossaryTerm[];
    uses(ast: Root): Array<{ term: string; key: string; line: number }>;
    key(text: string): string;
    slug(text: string): string;
    /** The format of glossary.json, as `search.format` for search.json. */
    readonly format: number;
  }

  export type TernEvent = 'render' | 'math' | 'ready' | 'diagnostic';
  export type Remove = () => void;

  export interface Config {
    /** The add-ons' options, by the add-on's name. */
    use: Record<string, Record<string, string>>;
    schema?: Schema;
    css?: string;
    nonce?: string;
    lang?: string;
    diagnostics?: boolean;
    quiet?: boolean;
    /** Milliseconds the mount waits for an add-on still loading, 12 000 by default. */
    addonTimeout?: number;
    /** The note size (characters) from which the mount holds off-screen blocks, 200 000 by default; 0 never holds. */
    holdOver?: number;
    /** The runtime's and the add-ons' words, by key (docs/api.html#strings). */
    strings?: Record<string, string>;
    [key: string]: any;
  }

  export interface Tern {
    readonly version: string;

    // ---- the engine
    parse(source: string, opts?: ParseOptions): { ast: Root; diagnostics: Diagnostic[] };
    /** With a tree, runs the transforms on it and returns it; with a name, registers a transform. */
    transform(ast: Root, opts?: ParseOptions): Root;
    transform(name: string, fn: (ast: Root, ctx: TransformContext) => void, order?: { before?: string; after?: string }): Remove;
    emit(ast: Root, opts?: EmitOptions): string;
    toHTML(source: string, opts?: EmitOptions): string;
    check(source: string, opts?: ParseOptions): Diagnostic[];
    visit(tree: Node, fn: Visitor): void;
    visit(tree: Node, type: string, fn: Visitor): void;
    outline(ast: Root): Outline;
    readonly search: Search;
    readonly glossary: Glossary;
    /** The names of the registered transforms, in order. */
    readonly transforms: string[];
    /** The base stylesheet, tern.css. */
    readonly css: string;

    // ---- the registry
    readonly schema: Schema;
    block(name: string, spec: Spec): Spec;
    leaf(name: string, spec: Spec): Spec;
    inline(name: string, spec: Spec): Spec;

    // ---- the runtime (inert under node)
    readonly diagnostics: Diagnostic[];
    readonly config: Config;
    readonly ready: Promise<void>;
    define(name: string, fn: (this: Element, el: Element) => void): Remove;
    undefine(name: string): void;
    on(event: TernEvent, fn: (root: Element, info: { safe: boolean }) => void | Promise<void>): Remove;
    render(root?: Element, source?: string, opts?: { safe?: boolean; idPrefix?: string; scripts?: boolean }): Promise<Diagnostic[]>;
    style(css: string): HTMLStyleElement | undefined;
    /** The page's string for a key (window.TERN.strings), else the fallback, else the runtime's own. */
    string(key: string, params?: Record<string, unknown>, fallback?: string): string;
  }

  export type Visitor = (node: Node, index: number | null, parent: Node | null) => boolean | void;
  export interface TransformContext {
    schema: Schema;
    opts: ParseOptions;
    lang: string;
    report(code: string, at: Node | Position | null, message: string, hint?: string | null, severity?: Severity): Diagnostic;
  }

}

declare const tern: tern.Tern;
export = tern;
