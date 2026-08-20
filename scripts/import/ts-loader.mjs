// A ten-line ESM resolve hook, registered by scripts/import-legacy.mjs so
// that script can `import` from src/lib/import-legacy.ts — which itself
// imports "./customer-match" the ordinary extensionless way every other
// file in src/ does — without adding a bundler or a dependency.
//
// WHY THIS EXISTS. Node's native loader (under --experimental-strip-types,
// which erases TypeScript's type syntax at load time with no separate
// build step) resolves relative specifiers exactly the way it always has:
// it does NOT try appending ".ts" the way it tries ".js"/".mjs"/".cjs".
// src/lib/customer-match.ts is imported from src/lib/import-legacy.ts as
// "./customer-match" — correct, and required, so that file keeps looking
// like every other module under src/lib and keeps typechecking under the
// project's tsconfig (which does not set allowImportingTsExtensions, and
// changing that project-wide for one script is a bigger lever than this
// importer should pull). This hook is the resolution rule Node is missing:
// if the default resolver 404s on a relative specifier, retry it with
// ".ts" appended, and only then give up.
//
// Registered once, in the respawned child process, before the dynamic
// import of src/lib/import-legacy.ts:
//
//   import { register } from "node:module";
//   register("./import/ts-loader.mjs", import.meta.url);
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (isRelative && err?.code === "ERR_MODULE_NOT_FOUND") {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
