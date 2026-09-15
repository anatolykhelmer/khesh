import { afterEach, describe, expect, it } from "vitest";
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
    const pending = pickSharedFile("api-key", "token-1");
    await flush();
    fake.fire({ action: "picked", docs: [{ id: "file-9" }] });
    expect(await pending).toBe("file-9");
    expect(fake.wasMadeVisible()).toBe(true);
  });

  it("resolves null when the dialog is cancelled", async () => {
    const fake = installFakePicker();
    const pending = pickSharedFile("api-key", "token-1");
    await flush();
    fake.fire({ action: "cancel" });
    expect(await pending).toBeNull();
  });
});
