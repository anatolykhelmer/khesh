// Ambient declarations for the handful of Node built-ins `scripts/cdp.ts` and
// `scripts/screenshots.ts` call. The project deliberately ships no `@types/node` (see the
// comment in `tests/app/spa-fallback.test.ts`) so app and test code never leans on Node
// types by accident; that reasoning doesn't extend to `scripts/`, which is Node-only
// tooling and genuinely needs it. Installing `@types/node` was ruled out for this task (no
// new npm dependencies), so this types only what's actually called — not the real Node API.

declare module "node:child_process" {
  export function spawn(
    command: string,
    args: string[],
    options?: { stdio?: "ignore" | "inherit" },
  ): {
    kill(): void;
    on(event: "exit", listener: (code: number | null) => void): void;
  };
}

declare module "node:fs/promises" {
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function writeFile(path: string, data: Uint8Array): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...segments: string[]): string;
}

declare const process: { env: Record<string, string | undefined> };

declare class Buffer extends Uint8Array {
  static from(data: string, encoding: "base64"): Buffer;
}
