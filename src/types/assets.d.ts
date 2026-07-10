// Bun supports importing files as text with `import x from './f.md' with { type: 'text' }`.
// Declare the module shapes so TypeScript resolves these imports to strings.
declare module '*.md' {
  const content: string;
  export default content;
}

declare module '*.txt' {
  const content: string;
  export default content;
}

declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.js' {
  const content: string;
  export default content;
}

// WASM grammars are embedded with `import x from './g.wasm' with { type: 'file' }`,
// which resolves to a filesystem path string (real in dev, virtual in the compiled
// binary) that Bun.file() can read.
declare module '*.wasm' {
  const path: string;
  export default path;
}
