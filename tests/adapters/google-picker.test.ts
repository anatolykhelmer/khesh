import { afterEach, describe, expect, it, vi } from "vitest";
import { pickSharedFile } from "../../src/adapters/google-picker";
import { flush } from "../helpers/sync-harness";

type PickerCallback = (response: { action: string; docs?: { id: string }[] }) => void;

/** A fake `google.picker` + `gapi`, just enough surface for `pickSharedFile` to drive:
 * a builder that records the callback it was given, and a `build().setVisible()` the
 * test can observe was called. */
function installFakePicker() {
  let capturedCallback: PickerCallback | null = null;
  let madeVisible = false;

  class FakeDocsView {
    setOwnedByMe() {
      return this;
    }
    setMimeTypes() {
      return this;
    }
    setMode() {
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
    setAppId() {
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
    load: (_api: string, callback: () => void) => callback(),
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
    fire: (response: { action: string; docs?: { id: string }[] }) => capturedCallback?.(response),
    wasMadeVisible: () => madeVisible,
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

  /** The dialog is a foreign widget: it answers PICKED or CANCEL, or it answers nothing
   * at all. The session holds `connecting` up for as long as this promise is pending, and
   * that flag gates Connect, Join *and* the Settings erase — so "nothing at all" has to
   * become a failure on its own, the way the GIS token flow next door already does it. */
  it("rejects when the dialog neither picks nor cancels", async () => {
    vi.useFakeTimers();
    try {
      installFakePicker();
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
      await expect(pending).rejects.toThrow(/timed out/i);
      await watched;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout once the dialog answers", async () => {
    vi.useFakeTimers();
    try {
      const fake = installFakePicker();
      const pending = pickSharedFile("api-key", "token-1", "app-id");
      await flush();
      fake.fire({ action: "cancel" });
      expect(await pending).toBeNull();
      // A live timer here would reject an already-resolved promise — harmless in itself,
      // but it would also keep the tab's event loop busy for 15s after every cancel.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
