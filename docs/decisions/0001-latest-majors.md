# 0001 — Use the latest major versions (TypeScript 7, zod 4, react-router 8)

The owner chose the latest majors over the versions first written in 00 §4. TypeScript 7 (the
native compiler) ships no JavaScript API, and typescript-eslint needs one. Following Microsoft's
side-by-side guidance, the root `package.json` installs `typescript` as an alias of
`@typescript/typescript6` (for typescript-eslint) and `@typescript/native` as an alias of
`typescript@7`, whose `tsc` binary does typecheck and build. The api runs its TypeScript sources
directly on Node 24 (type stripping), so `erasableSyntaxOnly` is on, and relative imports use `.ts`
extensions that `rewriteRelativeImportExtensions` rewrites on build. Drop the TS 6 alias once
typescript-eslint supports TS 7.
