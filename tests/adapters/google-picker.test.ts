import { afterEach, describe, expect, it, vi } from "vitest";
import { pickSharedFile } from "../../src/adapters/google-picker";
import { flush } from "../helpers/sync-harness";

type PickerCallback = (response: { action: string; docs?: { id: string }[] }) => void;

/**
 * A fake `google.picker` + `gapi`, just enough surface for `pickSharedFile` to drive:
 * a builder that records the callback it was given, and a `build().setVisible()` the
 * test can observe was called.
 *
 * **Every configuring call records its argument** into `calls`, rather than no-opping to
 * keep the chain from throwing. A fake that only kept the chain alive made the whole
 * configuration of the dialog unassertable: deleting `.setAppId(appId)` — without which the
 * per-file grant a pick creates is not attributed to this app, so the id comes back and the
 * very next Drive call still fails under `drive.file` — left every test here green.
 *
 * `deferModuleLoad` holds `gapi.load`'s callback instead of invoking it, which is the
 * "script loaded, module registration never comes back" freeze `PICKER_TIMEOUT_MS` exists
 * to bound. `finishModuleLoad()` releases it.
 */
function installFakePicker(options: { deferModuleLoad?: boolean } = {}) {
  let capturedCallback: PickerCallback | null = null;
  let madeVisible = false;
  let moduleCallback: (() => void) | null = null;
  const calls: { appId?: string; mimeTypes?: string; mode?: string; ownedByMe?: boolean } = {};

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
    addView() {
      return this;
    }
    setOAuthToken() {
      return this;
    }
    setDeveloperKey() {
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

describe("pickSharedFile", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).gapi;
    delete (globalThis as Record<string, unknown>).google;
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

  /** Each of these four is load-bearing and each was previously unassertable, because the
   * fake no-opped them to keep the builder chain from throwing. `setAppId` above all: under
   * `drive.file` the per-file grant a pick creates is attributed by app id, so without it
   * the picked id comes back and the next Drive call still fails. Deleting any one of these
   * lines from `pickSharedFile` now turns this test red. */
  it("configures the view and the app id the drive.file grant needs", async () => {
    const fake = installFakePicker();
    const pending = pickSharedFile("api-key", "token-1", "app-id");
    await flush();
    fake.fire({ action: "picked", docs: [{ id: "file-9" }] });
    await pending;
    expect(fake.calls.appId).toBe("app-id");
    expect(fake.calls.mimeTypes).toBe("application/json");
    expect(fake.calls.mode).toBe("list"); // the fake's DocsViewMode.LIST
    expect(fake.calls.ownedByMe).toBe(false); // "shared with me", not the user's own files
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
});
