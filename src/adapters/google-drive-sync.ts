import { err, ok, type Result } from "../kernel/result";
import type { SyncStorePort } from "../ports/sync-store";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FILE_NAME = "khesh-book.json";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const ABOUT_URL = "https://www.googleapis.com/drive/v3/about";
/**
 * Ceiling on any one Drive call. A cycle holds the sync lock across its network round
 * trips, and `commit()` takes that same lock — so an unbounded fetch (a captive portal,
 * a dead connection: the browser's own TCP timeout is tens of seconds to minutes) would
 * block the user from saving a transaction that needs no network whatever. Matches the
 * GIS token timeout, and an abort lands in the same place a dropped connection does:
 * SYNC_STORE_FAILED, which the engine shows as `offline`.
 */
const REQUEST_TIMEOUT_MS = 15000;

type TokenResponse = { access_token?: string; expires_in?: number; error?: string };
type TokenClient = { requestAccessToken(config?: { prompt?: "" | "consent" }): void };
type Gis = {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string }) => void;
      }): TokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
};

function gis(): Gis | undefined {
  return (globalThis as { google?: Gis }).google;
}

let gisLoading: Promise<void> | undefined;
function loadGisScript(): Promise<void> {
  if (gis()) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisLoading = undefined;
        reject(new Error("GIS script failed to load"));
      };
      document.head.appendChild(script);
    });
  }
  return gisLoading;
}

export interface GoogleAuth {
  getToken(interactive: boolean): Promise<Result<string>>;
  revoke(): Promise<void>;
}

/** In-memory hourly token. There are no refresh tokens in a pure frontend; when the
 * silent path fails (popup blocked without a user gesture), callers surface
 * needsAuth and retry from a tap. */
export function createGoogleAuth(clientId: string): GoogleAuth {
  let token: string | null = null;
  let expiresAt = 0;
  /** The one request in flight, shared by every caller that arrives while it runs.
   * `interactive` is kept because a tap can do what a silent request cannot. */
  let pending: {
    interactive: boolean;
    result: Promise<Result<string>>;
    callback: (response: TokenResponse) => void;
  } | null = null;
  let client: TokenClient | null = null;

  function ensureClient(): TokenClient {
    if (!client) {
      client = gis()!.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (response) => pending?.callback(response),
        error_callback: () => pending?.callback({ error: "popup" }),
      });
    }
    return client;
  }

  return {
    async getToken(interactive: boolean): Promise<Result<string>> {
      // Loops because both ways out of the wait below — a shared request that succeeded,
      // and one this caller declined to share — are answered by re-reading the state
      // rather than by duplicating the checks.
      for (;;) {
        if (token !== null && Date.now() < expiresAt) return ok(token);
        try {
          await loadGisScript();
        } catch {
          return err("SYNC_STORE_FAILED", "Could not load Google auth");
        }
        const inFlight = pending;
        if (inFlight === null) break;
        // A request already running is shared, not replaced. Replacing it left the first
        // caller hanging until its own 15s timeout fired SYNC_AUTH_REQUIRED at it — even
        // when the flow the second caller started had just succeeded.
        if (inFlight.interactive || !interactive) return inFlight.result;
        // The exception: only a tap may open the popup, so a tap will not settle for a
        // silent request's answer. It waits that one out rather than clobbering it, then
        // comes round to ask for itself — or to find the token it just cached.
        await inFlight.result;
      }

      let deliver: (response: TokenResponse) => void = () => undefined;
      const result = new Promise<Result<string>>((resolve) => {
        const timer = setTimeout(() => {
          pending = null;
          resolve(err("SYNC_AUTH_REQUIRED", "Sign-in timed out"));
        }, 15000);
        deliver = (response) => {
          clearTimeout(timer);
          pending = null;
          if (response.access_token) {
            token = response.access_token;
            expiresAt = Date.now() + ((response.expires_in ?? 3600) - 60) * 1000;
            resolve(ok(token));
          } else {
            resolve(err("SYNC_AUTH_REQUIRED", "Sign-in was not completed"));
          }
        };
      });
      pending = { interactive, result, callback: deliver };
      ensureClient().requestAccessToken(interactive ? undefined : { prompt: "" });
      return result;
    },

    async revoke(): Promise<void> {
      const current = token;
      token = null;
      expiresAt = 0;
      if (current && gis()) {
        await new Promise<void>((resolve) => gis()!.accounts.oauth2.revoke(current, resolve));
      }
    },
  };
}

/**
 * Reading a body is as much a network operation as the request that produced it, and it
 * fails separately: on a stalled connection the headers arrive, `fetch` resolves ok, and
 * the same AbortSignal fires here instead — headers in, body stream dropped, which is an
 * ordinary way for a flaky link to behave.
 *
 * Left to reject, that escapes `read`/`write` as an unhandled rejection rather than a
 * Result. Every `syncNow` call site is `void engine.syncNow()`, so nothing would catch
 * it: `fail()` never runs, the engine sits in `syncing`, and the section disables the
 * one button that state offers the user. Malformed JSON lands here too and means the
 * same thing — no usable body — so neither is worth telling apart.
 */
async function readBody<T>(read: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await read());
  } catch {
    return err("SYNC_STORE_FAILED", "Could not read Drive's response");
  }
}

export type DriveStoreDeps = {
  getToken: (interactive?: boolean) => Promise<Result<string>>;
  getFileId: () => string | null;
  onFileId: (id: string) => void | Promise<void>;
  fetchImpl?: typeof fetch;
  /** Per-call ceiling; only the tests have reason to shorten it. */
  timeoutMs?: number;
};

export function createDriveSyncStore(deps: DriveStoreDeps): SyncStorePort {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  /**
   * The validator Drive handed back with the payload of a given rev, so `write` can turn
   * the caller's "I merged against this rev" into the only precondition HTTP offers.
   *
   * Kept as a pair because the two are not interchangeable: `rev` is the modifiedTime the
   * port speaks in, and an ETag is opaque — sending a modifiedTime as If-Match would be
   * inventing a validator, so the header goes out only for the exact rev this came from,
   * and only when Drive actually sent one.
   */
  let validator: { rev: string; etag: string } | null = null;

  async function authFetch(url: string, init?: RequestInit): Promise<Result<Response>> {
    const token = await deps.getToken(false);
    if (!token.ok) return token;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${token.value}` },
      });
    } catch {
      // A timeout aborts into here alongside a dropped connection, which is right: from
      // the user's side "Drive did not answer" and "Drive is unreachable" are one thing.
      return err("SYNC_STORE_FAILED", "Network failure talking to Drive");
    }
    if (response.status === 401) return err("SYNC_AUTH_REQUIRED", "Drive rejected the token");
    if (response.status === 404) return err("SYNC_FILE_MISSING", "Sync file not found in Drive");
    // Only a request that carried If-Match can get this, i.e. the guarded PATCH below.
    if (response.status === 412) {
      return err("SYNC_REMOTE_CHANGED", "The Drive file moved since it was read");
    }
    // `status` in the details is what tells a status Drive answered with from a transport
    // failure, which carries none. The guarded write below retries on the former only:
    // retrying a request that never got an answer would just spend the timeout twice.
    if (!response.ok) {
      return err("SYNC_STORE_FAILED", `Drive responded ${response.status}`, {
        status: response.status,
      });
    }
    return ok(response);
  }

  /** Resolve the fileId: the cached one, else a search by name (another device may
   * have created the file), else null.
   *
   * More than one match is a fork, not a choice. Drive allows duplicate names and offers
   * no atomic create-if-absent for a named file under `drive.file`, so two devices that
   * both connect for the first time can each search, see nothing, and create their own
   * khesh-book.json. Taking `files[0]` would cache a different id on each device and the
   * two books would diverge forever with nothing ever reporting it. Refusing cannot undo
   * the race, but it makes it visible and actionable — the user deletes one copy in
   * Drive — instead of silent. */
  async function resolveFileId(): Promise<Result<string | null>> {
    const cached = deps.getFileId();
    if (cached !== null) return ok(cached);
    const query = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const found = await authFetch(`${FILES_URL}?q=${query}&spaces=drive&fields=files(id,modifiedTime)`);
    if (!found.ok) return found;
    const data = await readBody(() => found.value.json() as Promise<{ files?: Array<{ id: string }> }>);
    if (!data.ok) return data;
    const files = data.value.files ?? [];
    if (files.length > 1) {
      return err("SYNC_FILE_AMBIGUOUS", `Drive holds ${files.length} files named ${FILE_NAME}`, {
        fileIds: files.map((file) => file.id),
      });
    }
    const id = files[0]?.id ?? null;
    if (id !== null) await deps.onFileId(id);
    return ok(id);
  }

  async function metadata(id: string): Promise<Result<string>> {
    const response = await authFetch(`${FILES_URL}/${id}?fields=modifiedTime`);
    if (!response.ok) return response;
    const data = await readBody(() => response.value.json() as Promise<{ modifiedTime?: string }>);
    if (!data.ok) return data;
    return ok(data.value.modifiedTime ?? "");
  }

  return {
    async probe() {
      const id = await resolveFileId();
      if (!id.ok) return id;
      if (id.value === null) return ok(null);
      const rev = await metadata(id.value);
      if (!rev.ok) return rev;
      return ok({ rev: rev.value });
    },

    async read() {
      const id = await resolveFileId();
      if (!id.ok) return id;
      if (id.value === null) return ok(null);
      const rev = await metadata(id.value);
      if (!rev.ok) return rev;
      const media = await authFetch(`${FILES_URL}/${id.value}?alt=media`);
      if (!media.ok) return media;
      const payload = await readBody(() => media.value.text());
      if (!payload.ok) return payload;
      const etag = media.value.headers.get("ETag");
      validator = etag === null ? null : { rev: rev.value, etag };
      return ok({ payload: payload.value, rev: rev.value });
    },

    async write(payload: string, ifUnchanged?: string) {
      const id = await resolveFileId();
      if (!id.ok) return id;
      if (id.value !== null) {
        const patch = (extra?: Record<string, string>) =>
          authFetch(`${UPLOAD_URL}/${id.value}?uploadType=media&fields=id,modifiedTime`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...extra },
            body: payload,
          });
        // Guarded only when the caller named the rev this validator came from. Drive v3
        // documents no precondition for files.update, so an ETag it did send may still be
        // ignored here: then this is exactly the unconditional PATCH it always was, and
        // the design's own fallback (the loser re-merges on its next probe) still holds.
        const guard =
          ifUnchanged !== undefined && validator !== null && validator.rev === ifUnchanged
            ? { "If-Match": validator.etag }
            : undefined;
        let patched = await patch(guard);
        // Ignoring the header is one way an undocumented precondition can go; rejecting
        // it outright (a 400, say) is the other, and that one would fail every guarded
        // write forever while reporting a network problem the user cannot act on. Any
        // status other than the three that mean something here retires the guard and
        // tries again plain, so the precondition can cost a round trip and never the
        // ability to sync. 412 is excluded deliberately: it is a real refusal, and the
        // engine answers it by re-running the whole cycle.
        if (guard !== undefined && !patched.ok && patched.error.details?.status !== undefined) {
          patched = await patch();
        }
        if (!patched.ok) return patched;
        const data = await readBody(() => patched.value.json() as Promise<{ modifiedTime?: string }>);
        // Whatever was in Drive is now this payload; the old validator describes neither.
        // Retired even when the body did not arrive: the PATCH itself did land.
        validator = null;
        if (!data.ok) return data;
        return ok({ rev: data.value.modifiedTime ?? "" });
      }
      const boundary = "khesh-envelope";
      const body = [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify({ name: FILE_NAME }),
        `--${boundary}`,
        "Content-Type: application/json",
        "",
        payload,
        `--${boundary}--`,
        "",
      ].join("\r\n");
      const created = await authFetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,modifiedTime`, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!created.ok) return created;
      const data = await readBody(
        () => created.value.json() as Promise<{ id: string; modifiedTime?: string }>,
      );
      if (!data.ok) return data;
      await deps.onFileId(data.value.id);
      return ok({ rev: data.value.modifiedTime ?? "" });
    },
  };
}

export async function fetchAccountEmail(
  getToken: (interactive?: boolean) => Promise<Result<string>>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Result<string>> {
  const token = await getToken(false);
  if (!token.ok) return token;
  try {
    const response = await fetchImpl(`${ABOUT_URL}?fields=user(emailAddress)`, {
      signal: AbortSignal.timeout(timeoutMs), // this one runs during connect, not a cycle
      headers: { Authorization: `Bearer ${token.value}` },
    });
    if (!response.ok) return err("SYNC_STORE_FAILED", `Drive responded ${response.status}`);
    const data = (await response.json()) as { user?: { emailAddress?: string } };
    return ok(data.user?.emailAddress ?? "");
  } catch {
    return err("SYNC_STORE_FAILED", "Network failure talking to Drive");
  }
}
