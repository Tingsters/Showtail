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
