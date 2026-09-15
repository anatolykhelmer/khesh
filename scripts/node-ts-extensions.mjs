// Node's built-in TypeScript support strips types but does not resolve extensionless
// specifiers to `.ts` files — a documented Node limitation. `src/` is written for Vite's
// bundler resolution and imports relatively without extensions throughout, by design and
// out of this task's reach (no file under `src/` changes: `scripts/demo-book.ts` reaches
// `src/kernel/accounts.ts`, which imports sibling kernel modules like `./book-utils` with
// no extension). This hook, loaded via `node --import`, bridges the two: on a relative
// specifier that 404s, retry with `.ts` appended — exactly what Vite already does silently.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isRelative = specifier.startsWith(".") || specifier.startsWith("/");
      if (isRelative && error?.code === "ERR_MODULE_NOT_FOUND") {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
