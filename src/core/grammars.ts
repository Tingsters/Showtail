/**
 * The bundled tree-sitter grammars Showtail uses for entity-level diffs, and the
 * queries that pull named entities (functions, classes, methods, …) out of each.
 *
 * Every `.wasm` here is committed under `assets/grammars/` AND embedded into the
 * compiled binary via the `with { type: 'file' }` imports below — the same trick
 * `skill.ts` uses for SKILL.md — so entity extraction works from the standalone
 * binary with no files to ship and no network at runtime. Re-sync the blobs with
 * `bun run sync:grammars` after bumping web-tree-sitter / tree-sitter-wasms.
 *
 * Each query captures a whole definition as `@def` and its name node as `@name`;
 * `entities.ts` pairs them per match (via `query.matches`) to build an
 * {@link EntitySig}. Node names are grammar-specific and were verified against
 * the bundled grammars — a wrong one makes `Language.query` throw, which the
 * entities module swallows (that language is simply skipped) and the test suite
 * catches (every language must extract from its fixture).
 */

// Runtime first, then one import per grammar. These resolve to a path string at
// runtime (a real path under dev, a virtual `/$bunfs/…` path in the compiled
// binary); `entities.ts` reads the bytes with Bun.file(path).
import RUNTIME_WASM from '../../assets/grammars/tree-sitter.wasm' with { type: 'file' };
import BASH from '../../assets/grammars/tree-sitter-bash.wasm' with { type: 'file' };
import C from '../../assets/grammars/tree-sitter-c.wasm' with { type: 'file' };
import CPP from '../../assets/grammars/tree-sitter-cpp.wasm' with { type: 'file' };
import CSHARP from '../../assets/grammars/tree-sitter-c_sharp.wasm' with { type: 'file' };
import GO from '../../assets/grammars/tree-sitter-go.wasm' with { type: 'file' };
import JAVA from '../../assets/grammars/tree-sitter-java.wasm' with { type: 'file' };
import JAVASCRIPT from '../../assets/grammars/tree-sitter-javascript.wasm' with { type: 'file' };
import KOTLIN from '../../assets/grammars/tree-sitter-kotlin.wasm' with { type: 'file' };
import LUA from '../../assets/grammars/tree-sitter-lua.wasm' with { type: 'file' };
import PHP from '../../assets/grammars/tree-sitter-php.wasm' with { type: 'file' };
import PYTHON from '../../assets/grammars/tree-sitter-python.wasm' with { type: 'file' };
import RUBY from '../../assets/grammars/tree-sitter-ruby.wasm' with { type: 'file' };
import RUST from '../../assets/grammars/tree-sitter-rust.wasm' with { type: 'file' };
import SCALA from '../../assets/grammars/tree-sitter-scala.wasm' with { type: 'file' };
import SWIFT from '../../assets/grammars/tree-sitter-swift.wasm' with { type: 'file' };
import TSX from '../../assets/grammars/tree-sitter-tsx.wasm' with { type: 'file' };
import TYPESCRIPT from '../../assets/grammars/tree-sitter-typescript.wasm' with { type: 'file' };

/** Path to the embedded tree-sitter runtime wasm (fed to `Parser.init`). */
export const RUNTIME_WASM_PATH: string = RUNTIME_WASM;

/** One supported language: its grammar blob, the extensions it owns, its query. */
export interface LanguageDef {
  /** Stable id (matches the grammar file stem). */
  id: string;
  /** Lowercase file extensions (no dot) this grammar handles. */
  extensions: string[];
  /** Path to the embedded grammar `.wasm` (a `type: 'file'` import). */
  wasmPath: string;
  /** Tree-sitter query capturing `@def` (definition) + `@name` per entity. */
  query: string;
}

const TS_QUERY = `
  (function_declaration name:(identifier)@name)@def
  (method_definition name:(property_identifier)@name)@def
  (class_declaration name:(type_identifier)@name)@def
  (interface_declaration name:(type_identifier)@name)@def
  (variable_declarator name:(identifier)@name value:(arrow_function))@def`;

const JS_QUERY = `
  (function_declaration name:(identifier)@name)@def
  (method_definition name:(property_identifier)@name)@def
  (class_declaration name:(identifier)@name)@def
  (variable_declarator name:(identifier)@name value:(arrow_function))@def`;

export const LANGUAGES: LanguageDef[] = [
  {
    id: 'typescript',
    extensions: ['ts', 'cts', 'mts'],
    wasmPath: TYPESCRIPT,
    query: TS_QUERY,
  },
  { id: 'tsx', extensions: ['tsx'], wasmPath: TSX, query: TS_QUERY },
  {
    id: 'javascript',
    extensions: ['js', 'jsx', 'cjs', 'mjs'],
    wasmPath: JAVASCRIPT,
    query: JS_QUERY,
  },
  {
    id: 'python',
    extensions: ['py', 'pyi'],
    wasmPath: PYTHON,
    query: `
      (function_definition name:(identifier)@name)@def
      (class_definition name:(identifier)@name)@def`,
  },
  {
    id: 'go',
    extensions: ['go'],
    wasmPath: GO,
    query: `
      (function_declaration name:(identifier)@name)@def
      (method_declaration name:(field_identifier)@name)@def
      (type_declaration (type_spec name:(type_identifier)@name))@def`,
  },
  {
    id: 'rust',
    extensions: ['rs'],
    wasmPath: RUST,
    query: `
      (function_item name:(identifier)@name)@def
      (struct_item name:(type_identifier)@name)@def
      (enum_item name:(type_identifier)@name)@def
      (trait_item name:(type_identifier)@name)@def`,
  },
  {
    id: 'java',
    extensions: ['java'],
    wasmPath: JAVA,
    query: `
      (method_declaration name:(identifier)@name)@def
      (class_declaration name:(identifier)@name)@def
      (interface_declaration name:(identifier)@name)@def
      (constructor_declaration name:(identifier)@name)@def`,
  },
  {
    id: 'c',
    extensions: ['c', 'h'],
    wasmPath: C,
    query: `(function_definition declarator:(function_declarator declarator:(identifier)@name))@def`,
  },
  {
    id: 'cpp',
    extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh'],
    wasmPath: CPP,
    query: `
      (function_definition declarator:(function_declarator declarator:(identifier)@name))@def
      (class_specifier name:(type_identifier)@name)@def`,
  },
  {
    id: 'c_sharp',
    extensions: ['cs'],
    wasmPath: CSHARP,
    query: `
      (method_declaration name:(identifier)@name)@def
      (class_declaration name:(identifier)@name)@def
      (interface_declaration name:(identifier)@name)@def
      (struct_declaration name:(identifier)@name)@def`,
  },
  {
    id: 'ruby',
    extensions: ['rb'],
    wasmPath: RUBY,
    query: `
      (method name:(identifier)@name)@def
      (class name:(constant)@name)@def
      (module name:(constant)@name)@def`,
  },
  {
    id: 'php',
    extensions: ['php'],
    wasmPath: PHP,
    query: `
      (function_definition name:(name)@name)@def
      (method_declaration name:(name)@name)@def
      (class_declaration name:(name)@name)@def`,
  },
  {
    id: 'swift',
    extensions: ['swift'],
    wasmPath: SWIFT,
    query: `
      (function_declaration name:(simple_identifier)@name)@def
      (class_declaration name:(type_identifier)@name)@def`,
  },
  {
    id: 'kotlin',
    extensions: ['kt', 'kts'],
    wasmPath: KOTLIN,
    query: `
      (function_declaration (simple_identifier)@name)@def
      (class_declaration (type_identifier)@name)@def`,
  },
  {
    id: 'scala',
    extensions: ['scala', 'sc'],
    wasmPath: SCALA,
    query: `
      (function_definition name:(identifier)@name)@def
      (class_definition name:(identifier)@name)@def
      (object_definition name:(identifier)@name)@def
      (trait_definition name:(identifier)@name)@def`,
  },
  {
    id: 'lua',
    extensions: ['lua'],
    wasmPath: LUA,
    query: `
      (function_definition_statement name:(identifier)@name)@def
      (local_function_definition_statement name:(identifier)@name)@def`,
  },
  {
    id: 'bash',
    extensions: ['sh', 'bash'],
    wasmPath: BASH,
    query: `(function_definition name:(word)@name)@def`,
  },
];

/** Look up the language definition owning a file extension (lowercase, no dot). */
export function languageForExtension(ext: string): LanguageDef | undefined {
  const e = ext.toLowerCase();
  return LANGUAGES.find((l) => l.extensions.includes(e));
}
