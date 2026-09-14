import { IDLE, visibleError, type ConnectStage } from "./pending-plan-rule";
import type { SyncState, SyncEngineDeps, SyncEngine } from "../../service/sync-engine";
import type { SyncStorePort } from "../../ports/sync-store";
import type { GoogleAuth } from "../../adapters/google-drive-sync";
import type { SyncMetaStore, SyncMeta } from "../../adapters/sync-meta-store";
import type { LedgerRepository } from "../../ports/ledger-repository";
import type { Book } from "../../kernel/types";
import type { Result } from "../../kernel/result";
import type { FirstConnectChoice } from "../../service/sync-connect";

export type SyncActivity = {
  connecting: boolean;
  applying: boolean;
  disconnecting: boolean;
  erasing: boolean;
  /** Any of the four above. Derived in one place, never assigned. */
  blocking: boolean;
};

export type SyncSnapshot = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  state: SyncState | null;
  stage: ConnectStage;
  activity: SyncActivity;
  lastError: string | null;
};

/** What one connection hands its store. Deliberately `DriveStoreDeps` minus its two
 * test-only optional fields, so `createDriveSyncStore` is assignable unchanged. */
export type ConnectionIO = {
  getToken: (interactive?: boolean) => Promise<Result<string>>;
  getFileId: () => string | null;
  onFileId: (id: string) => Promise<void>;
};

export type SyncSessionPorts = {
  clientId: string;
  createAuth: () => GoogleAuth;
  createStore: (io: ConnectionIO) => SyncStorePort;
  createEngine: (deps: SyncEngineDeps) => SyncEngine;
  metaStore: SyncMetaStore;
  getRepo: () => LedgerRepository;
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  announceBookChanged: (book: Book | null) => void;
  fetchAccountEmail: (
    getToken: (interactive?: boolean) => Promise<Result<string>>,
  ) => Promise<Result<string>>;
};

export interface SyncSession {
  getSnapshot(): SyncSnapshot;
  subscribe(listener: () => void): () => void;
  setBook(book: Book | null): void;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  applyChoice(choice: FirstConnectChoice, onStarted?: () => void): Promise<void>;
  cancelConnect(): void;
  disconnect(): Promise<void>;
  beginErase(): void;
  endErase(): void;
  syncNow(): void;
  reauth(): Promise<void>;
  resolveUseLocal(): void;
  resolveUseRemote(): void;
  dispose(): void;
}

export function createSyncSession(ports: SyncSessionPorts): SyncSession {
  const listeners = new Set<() => void>();

  // The mutable truth. `snapshot` below is the cached, frozen view of it.
  let connected = false;
  let email: string | null = null;
  let engineState: SyncState | null = null;
  let stage: ConnectStage = IDLE;
  let lastError: string | null = null;
  let connecting = false;
  let applying = false;
  let disconnecting = false;
  let erasing = false;

  let snapshot: SyncSnapshot = buildSnapshot();

  /** The one place `blocking` is computed. Assigning it anywhere else is how a fifth
   * activity gets added and forgotten, which is BL-055's shape one field lower down. */
  function buildSnapshot(): SyncSnapshot {
    return {
      configured: ports.clientId !== "",
      connected,
      email,
      state: engineState,
      stage,
      activity: {
        connecting,
        applying,
        disconnecting,
        erasing,
        blocking: connecting || applying || disconnecting || erasing,
      },
      // The notice and a red error may not share the collapsed Connect row: a dropped plan
      // needs one tap on Connect, and the neutral sentence is the whole explanation.
      // Applied here rather than in the provider's render, which is where it used to live —
      // there is no longer a frame between deriving the notice and writing the state.
      lastError: visibleError(stage, lastError),
    };
  }

  /** Rebuild the cached snapshot and notify. `useSyncExternalStore` compares snapshots by
   * identity and loops forever on a `getSnapshot` that allocates per call, so the cache is
   * a correctness requirement and not an optimisation — and one that cannot fail in
   * `environment: "node"`, which is why it lives in exactly one function. */
  function publish(): void {
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    beginErase() {
      if (erasing) return;
      erasing = true;
      publish();
    },
    endErase() {
      if (!erasing) return;
      erasing = false;
      publish();
    },
    // Every remaining method is added by Tasks 2-8. Until then they must exist and be
    // typed, so the interface compiles:
    setBook() {},
    async connect() {},
    async reconnect() {},
    async applyChoice() {},
    cancelConnect() {},
    async disconnect() {},
    syncNow() {},
    async reauth() {},
    resolveUseLocal() {},
    resolveUseRemote() {},
    dispose() {},
  };
}
