import { describe, expect, it } from "vitest";
import {
  createProductEventRecorder,
  type ProductEvent,
  type ProductEventName
} from "../miniprogram/services/product-events";

describe("product event recorder", () => {
  it("records only the five approved event shapes", () => {
    const received: ProductEvent[] = [];
    const recorder = createProductEventRecorder((event) => received.push(event));
    const events: ProductEvent[] = [
      { name: "HOME_PRIMARY_TAPPED", dimensions: { scenario: "TRAVEL_PORTRAIT" } },
      { name: "DEMO_CASE_OPENED", dimensions: { source: "HOME" } },
      { name: "DEMO_STARTED", dimensions: { source: "CASE_PAGE" } },
      { name: "PREVIEW_COMPARE_USED", dimensions: { mode: "SLIDER" } },
      { name: "PREVIEW_DETAILS_TOGGLED", dimensions: { state: "OPEN" } },
      { name: "PREVIEW_DETAILS_TOGGLED", dimensions: { state: "CLOSED" } }
    ];

    for (const event of events) {
      recorder.record(event.name, event.dimensions);
    }

    expect(received).toEqual(events);
  });

  it("rejects unapproved event names", () => {
    const recorder = createProductEventRecorder(() => undefined);

    expect(() => recorder.record("PAYMENT" as ProductEventName, {})).toThrow(
      "INVALID_PRODUCT_EVENT"
    );
  });

  it("rejects wrong enum values and extra dimensions", () => {
    const recorder = createProductEventRecorder(() => undefined);
    const invalidDimensions = [
      { scenario: "FREE_TEXT" },
      { scenario: "TRAVEL_PORTRAIT", campaign: "summer" },
      { source: "CASE_PAGE" },
      { mode: "TAP" },
      { state: "UNKNOWN" },
      null,
      []
    ];

    for (const dimensions of invalidDimensions) {
      expect(() =>
        recorder.record("HOME_PRIMARY_TAPPED", dimensions as never)
      ).toThrow("INVALID_PRODUCT_EVENT");
    }
  });

  it("rejects arbitrary or identifying dimensions without reaching the sink", () => {
    const received: ProductEvent[] = [];
    const recorder = createProductEventRecorder((event) => received.push(event));
    const identifyingDimensions = [
      { taskId: "task-1" },
      { openId: "openid-1" },
      { sessionToken: "session-1" },
      { phone: "13800000000" },
      { image: "base64-data" },
      { path: "/tmp/photo.jpg" },
      { url: "https://example.invalid/photo.jpg" },
      { text: "free text" },
      { apiKey: "secret" }
    ];

    for (const dimensions of identifyingDimensions) {
      expect(() =>
        recorder.record("PREVIEW_COMPARE_USED", dimensions as never)
      ).toThrow("INVALID_PRODUCT_EVENT");
    }
    expect(received).toEqual([]);
  });
});
