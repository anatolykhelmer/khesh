import { afterEach, describe, expect, it, vi } from "vitest";
import { pickSharedFile } from "../../src/adapters/google-picker";
import { flush } from "../helpers/sync-harness";

type PickerCallback = (response: { action: string; docs?: { id: string }[] }) => void;

/**
 * A fake `google.picker` + `gapi`, just enough surface for `pickSharedFile` to drive:
 * a builder that records the callback it was given, and a `build().setVisible()` the
 * test can observe was called.
 *
 * **Every configuring call is recorded** into `calls` — its argument, or for `addView` the
 * fact that a configured view is what it was handed — rather than no-opping to keep the
 * chain from throwing. A fake that only kept the chain alive made the whole configuration of
 * the dialog unassertable: deleting `.setAppId(appId)` — without which the per-file grant a
 * pick creates is not attributed to this app, so the id comes back and the very next Drive
 * call still fails under `drive.file` — left every test here green. The comment used to
 * claim all seven while three still no-opped, so deleting `.setOAuthToken`, `.setDeveloperKey`
 * or `.addView` was the same free mutation one layer along; every one of them is pinned now.
 *
 * `deferModuleLoad` holds `gapi.load`'s callback instead of invoking it, which is the
 * "script loaded, module registration never comes back" freeze `PICKER_TIMEOUT_MS` exists
 * to bound. `finishModuleLoad()` releases it.
 */
function installFakePicker(options: { deferModuleLoad?: boolean } = {}) {
  let capturedCallback: PickerCallback | null = null;
  let madeVisible = false;
  let moduleCallback: (() => void) | null = null;
  const calls: {
    appId?: string;
    developerKey?: string;
    mimeTypes?: string;
    mode?: string;
    oauthToken?: string;
    ownedByMe?: boolean;
    viewAdded?: boolean;
  } = {};

  class FakeDocsView {
    setOwnedByMe(ownedByMe: boolean) {
      calls.ownedByMe = ownedByMe;
      return this;
    }
    setMimeTypes(mimeTypes: string) {
      calls.mimeTypes = mimeTypes;
      return this;
    }
    setMode(mode: string) {
      calls.mode = mode;
      return this;
    }
  }
  class FakePickerBuilder {
    addView(view: unknown) {
      calls.viewAdded = view instanceof FakeDocsView;
      return this;
    }
    setOAuthToken(token: string) {
      calls.oauthToken = token;
      return this;
    }
    setDeveloperKey(key: string) {
      calls.developerKey = key;
      return this;
    }
    setAppId(appId: string) {
      calls.appId = appId;
      return this;
    }
    setCallback(callback: PickerCallback) {
      capturedCallback = callback;
      return this;
    }
    build() {
      return {
        setVisible(visible: boolean) {
          madeVisible = visible;
        },
      };
    }
  }

  (globalThis as Record<string, unknown>).gapi = {
    load: (_api: string, callback: () => void) => {
      if (options.deferModuleLoad) {
        moduleCallback = callback;
        return;
      }
      callback();
    },
  };
  (globalThis as Record<string, unknown>).google = {
    picker: {
      PickerBuilder: FakePickerBuilder,
      DocsView: FakeDocsView,
      ViewId: { DOCS: "docs" },
      DocsViewMode: { LIST: "list" },
      Action: { PICKED: "picked", CANCEL: "cancel" },
    },
  };

  return {
    calls,
    fire: (response: { action: string; docs?: { id: string }[] }) => capturedCallback?.(response),
    wasMadeVisible: () => madeVisible,
    finishModuleLoad: () => moduleCallback?.(),
  };
}

type FakeScript = { src?: string; async?: boolean; onload?: () => void; onerror?: () => void };

/**
 * Just enough `document` for `loadGapiScript` to append its `<script>` tag under
 * `environment: "node"`, where there is none. Every other test here installs `gapi` first,
 * so `loadGapiScript` short-circuits and the tag is never reached; the retry test below is
 * the one that wants the real script path, hang and all.
 *
 * Returns the appended tags, so a test can answer (or pointedly not answer) each one.
 */
function installFakeDocument(): FakeScript[] {
  const scripts: FakeScript[] = [];
  (globalThis as Record<string, unknown>).document = {
    createElement: (): FakeScript => ({}),
    head: {
      appendChild: (script: FakeScript) => {
        scripts.push(script);
      },
    },
  };
  return scripts;
}

describe("pickSharedFile", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).gapi;
    delete (globalThis as Record<string, unknown>).google;
    delete (globalThis as Record<string, unknown>).document;
  });

  it("resolves the picked file's id and shows the dialog", async () => {
    const fake = installFakePicker();
    const pending = pickSharedFile("api-key", "token-1", "app-id");
    await flush();
    fake.fire({ action: "picked", docs: [{ id: "file-9" }] });
    expect(await pending).toBe("file-9");
    expect(fake.wasMadeVisible()).toBe(true);
  });

  it("resolves null when the dialog is cancelled", async () => {
    const fake = installFakePicker();
    const pending = pickSharedFile("api-key", "token-1", "app-id");
    await flush();
    fake.fire({ action: "cancel" });
    expect(await pending).toBeNull();
  });

  /** Each of these is load-bearing and each was previously unassertable, because the fake
   * no-opped them to keep the builder chain from throwing. `setAppId` above all: under
   * `drive.file` the per-file grant a pick creates is attributed by app id, so without it
   * the picked id comes back and the next Drive call still fails. Deleting any one of these
   * lines from `pickSharedFile` now turns this test red.
   *
   * The token and the developer key are the last two to be pinned, and they are not
   * cosmetic: without `setOAuthToken` the dialog has no identity to list "Shared with me"
   * under, and without `setDeveloperKey` the Picker API rejects the call outright. Both were
   * deletable for free while the fake swallowed them — the same free mutation `setAppId`
   * used to be. */
  it("configures the view, the token, the key and the app id the drive.file grant needs", async () => {
    const fake = installFakePicker();
    const pending = pickSharedFile("api-key", "token-1", "app-id");
    await flush();
    fake.fire({ action: "picked", docs: [{ id: "file-9" }] });
    await pending;
    expect(fake.calls.appId).toBe("app-id");
    expect(fake.calls.oauthToken).toBe("token-1");
    expect(fake.calls.developerKey).toBe("api-key");
    expect(fake.calls.mimeTypes).toBe("application/json");
    expect(fake.calls.mode).toBe("list"); // the fake's DocsViewMode.LIST
    expect(fake.calls.ownedByMe).toBe(false); // "shared with me", not the user's own files
    // And the configured view actually reached the builder: without this the four view
    // assertions above pass against a view the dialog was never given.
    expect(fake.calls.viewAdded).toBe(true);
  });

  /** The *load* is a foreign script: it answers, or it answers nothing at all. The session
   * holds `connecting` up for as long as this promise is pending, and that flag gates
   * Connect, Join *and* the Settings erase — so "nothing at all" has to become a failure on
   * its own, the way the GIS token flow next door already does it.
   *
   * `gapi.load("picker", cb)` and not just the `<script>` fetch: the ceiling used to start
   * only after `loadPickerModule()` had already resolved, so a script that loaded and then
   * never called its module callback back — the exact freeze the timeout was written to
   * close — had no ceiling at all, one `await` earlier than anyone was looking. */
  it("rejects when the picker module registration never comes back", async () => {
    vi.useFakeTimers();
    try {
      installFakePicker({ deferModuleLoad: true });
      const pending = pickSharedFile("api-key", "token-1", "app-id");
      // Both halves matter: the promise is still open before the ceiling...
      await flush();
      let settled = false;
      const watched = pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await flush();
      expect(settled).toBe(false);
      // ...and rejected once it passes.
      vi.advanceTimersByTime(15000);
      await expect(pending).rejects.toThrow(/failed to load in time/i);
      await watched;
    } finally {
      vi.useRealTimers();
    }
  });

  /** The other side of the same ceiling, and what keeps the test above from passing for a
   * trivial reason: a deferred module registration that *does* come back, inside the
   * ceiling, must open the dialog like any other load. Without this, a `withTimeout` that
   * rejected unconditionally — or a `loadPickerModule` that never resolved at all — would be
   * indistinguishable from the fix. */
  it("opens the dialog when a slow module registration still lands inside the ceiling", async () => {
    vi.useFakeTimers();
    try {
      const fake = installFakePicker({ deferModuleLoad: true });
      const pending = pickSharedFile("api-key", "token-1", "app-id");
      await flush();
      expect(fake.wasMadeVisible()).toBe(false); // still loading: no dialog yet
      vi.advanceTimersByTime(14000); // slow, but inside the ceiling
      fake.finishModuleLoad();
      await flush();
      expect(fake.wasMadeVisible()).toBe(true);
      // And the ceiling it beat is gone rather than left to fire into an open dialog.
      expect(vi.getTimerCount()).toBe(0);
      fake.fire({ action: "picked", docs: [{ id: "file-9" }] });
      expect(await pending).toBe("file-9");
    } finally {
      vi.useRealTimers();
    }
  });

  /** The other half of the redesign, and the one the ceiling used to get wrong. A person
   * browsing "Shared with me" is not a hung widget: the 15s ceiling was copied from the GIS
   * one-tap popup and, sitting over the dialog, fired during completely ordinary selection
   * time — leaving the dialog visibly open while telling the user it could not be opened.
   * The Picker's own close button already answers CANCEL, so the escape hatch this was
   * meant to provide was there all along. */
  it("puts no ceiling on the dialog itself, however long the person browses", async () => {
    vi.useFakeTimers();
    try {
      const fake = installFakePicker();
      const pending = pickSharedFile("api-key", "token-1", "app-id");
      await flush();
      let settled = false;
      const watched = pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Four times the old ceiling, and nothing fires: no PICKED, no CANCEL, no rejection.
      vi.advanceTimersByTime(60000);
      await flush();
      expect(settled).toBe(false);
      // And the pick still works on the far side of that wait.
      fake.fire({ action: "picked", docs: [{ id: "file-9" }] });
      expect(await pending).toBe("file-9");
      await watched;
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no timer running once the picker module is up", async () => {
    vi.useFakeTimers();
    try {
      const fake = installFakePicker();
      const pending = pickSharedFile("api-key", "token-1", "app-id");
      await flush();
      // The ceiling belongs to the load, and the load is done. A live timer here is the
      // defect this redesign removes: it would reject an already-open dialog on a person's
      // ordinary selection time, and it would keep the tab's event loop busy for 15s after
      // every cancel.
      expect(vi.getTimerCount()).toBe(0);
      fake.fire({ action: "cancel" });
      expect(await pending).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The ceiling made the hang *visible*; it did not make it recoverable. `gapiLoading`
   * memoises the script load, and `onerror` clears it so a load that fails can be retried —
   * but a `<script>` that fires neither `onload` nor `onerror` left that promise pending for
   * the life of the page. Every later Join then awaited the same dead promise and rejected
   * on its own ceiling, identically, forever: the timeout turned "Join hangs" into "Join
   * fails", and left "Join can never succeed again without a page reload" exactly where it
   * was.
   *
   * A second `<script>` tag is the observable claim, and the only one available from out
   * here: `gapiLoading` is module-private, and whether the retry re-fetches or awaits the
   * corpse is precisely the difference between the two.
   *
   * Runs the real script path, which every other test in this file skips by installing
   * `gapi` up front — so it is deliberately last, and leaves `gapiLoading` holding a
   * resolved promise rather than a pending one.
   */
  it("lets the next Join retry a script load that hung, not inherit its dead promise", async () => {
    vi.useFakeTimers();
    try {
      const scripts = installFakeDocument(); // and no `gapi`: the real load path
      const first = pickSharedFile("api-key", "token-1", "app-id");
      expect(scripts.length).toBe(1);

      // The tag answers nothing at all. Only the ceiling ends this attempt.
      vi.advanceTimersByTime(15000);
      await expect(first).rejects.toThrow(/failed to load in time/i);

      const second = pickSharedFile("api-key", "token-1", "app-id");
      await flush();
      expect(scripts.length).toBe(2); // a fresh tag, not a second wait on the first

      // And the retry can still finish, which is the whole point of letting it happen.
      const fake = installFakePicker();
      scripts[1].onload?.();
      await flush();
      expect(fake.wasMadeVisible()).toBe(true);
      fake.fire({ action: "picked", docs: [{ id: "file-9" }] });
      expect(await second).toBe("file-9");
    } finally {
      vi.useRealTimers();
    }
  });
});
