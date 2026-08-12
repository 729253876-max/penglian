import { describe, expect, it } from "vitest";
import {
  createProductEventRecorder,
  type ProductEvent,
  type ProductEventName
} from "../miniprogram/services/product-events";

describe("product event recorder", () => {
  it("records only the approved event shapes", () => {
    const received: ProductEvent[] = [];
    const recorder = createProductEventRecorder((event) => received.push(event));
    const events: ProductEvent[] = [
      { name: "HOME_PRIMARY_TAPPED", dimensions: { scenario: "TRAVEL_PORTRAIT" } },
      { name: "HOME_OWN_PHOTO_TAPPED", dimensions: { source: "HOME" } },
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

  it("rejects an accessor without evaluating it or reaching the sink", () => {
    const received: ProductEvent[] = [];
    const recorder = createProductEventRecorder((event) => received.push(event));
    let reads = 0;
    const nested = { label: "OPEN" };
    const dimensions = {};
    Object.defineProperty(dimensions, "state", {
      enumerable: true,
      get() {
        reads += 1;
        return reads < 3 ? "OPEN" : nested;
      }
    });

    expect(() =>
      recorder.record("PREVIEW_DETAILS_TOGGLED", dimensions)
    ).toThrow("INVALID_PRODUCT_EVENT");
    expect(reads).toBe(0);
    expect(received).toEqual([]);
  });

  it("rebuilds a stable primitive event without reading the caller property", () => {
    const received: ProductEvent[] = [];
    const recorder = createProductEventRecorder((event) => received.push(event));
    const nested = { label: "OPEN" };
    let propertyReads = 0;
    const dimensions = new Proxy({ state: "OPEN" }, {
      get(target, property, receiver) {
        if (property === "state") {
          propertyReads += 1;
          return propertyReads < 3 ? "OPEN" : nested;
        }
        return Reflect.get(target, property, receiver);
      }
    });

    recorder.record("PREVIEW_DETAILS_TOGGLED", dimensions as never);
    nested.label = "POLLUTED";

    expect(received).toEqual([
      { name: "PREVIEW_DETAILS_TOGGLED", dimensions: { state: "OPEN" } }
    ]);
    expect(propertyReads).toBe(0);
  });

  it.each([
    ["a non-enumerable extra key", () => {
      const dimensions = { mode: "SLIDER" };
      Object.defineProperty(dimensions, "taskId", {
        configurable: true,
        value: "task-1"
      });
      return dimensions;
    }],
    ["a symbol key", () => ({ mode: "SLIDER", [Symbol("secret")]: "value" })],
    ["a custom prototype", () => Object.assign(Object.create({ taskId: "task-1" }), { mode: "SLIDER" })],
    ["a null prototype", () => Object.assign(Object.create(null), { mode: "SLIDER" })]
  ] as const)("rejects dimensions with %s without reaching the sink", (_label, createDimensions) => {
    const received: ProductEvent[] = [];
    const recorder = createProductEventRecorder((event) => received.push(event));

    expect(() =>
      recorder.record("PREVIEW_COMPARE_USED", createDimensions() as never)
    ).toThrow("INVALID_PRODUCT_EVENT");
    expect(received).toEqual([]);
  });

  it("rejects a non-enumerable approved key and a nested object value", () => {
    const received: ProductEvent[] = [];
    const recorder = createProductEventRecorder((event) => received.push(event));
    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "mode", {
      value: "SLIDER"
    });

    expect(() =>
      recorder.record("PREVIEW_COMPARE_USED", nonEnumerable)
    ).toThrow("INVALID_PRODUCT_EVENT");
    expect(() =>
      recorder.record("PREVIEW_DETAILS_TOGGLED", { state: { label: "OPEN" } } as never)
    ).toThrow("INVALID_PRODUCT_EVENT");
    expect(received).toEqual([]);
  });

  it.each([
    ["a hidden non-enumerable key", () => {
      const target = { mode: "SLIDER" };
      Object.defineProperty(target, "taskId", {
        configurable: true,
        value: "task-1"
      });
      return new Proxy(target, {
        ownKeys: () => ["mode"]
      });
    }],
    ["a hidden symbol key", () => {
      const target = { mode: "SLIDER", [Symbol("private")]: "value" };
      return new Proxy(target, {
        ownKeys: () => ["mode"]
      });
    }],
    ["a disguised custom prototype", () => {
      const target = Object.assign(Object.create({ taskId: "task-1" }), { mode: "SLIDER" });
      return new Proxy(target, {
        getPrototypeOf: () => Object.prototype
      });
    }],
    ["a disguised null prototype", () => {
      const target = Object.assign(Object.create(null), { mode: "SLIDER" });
      return new Proxy(target, {
        getPrototypeOf: () => Object.prototype
      });
    }],
    ["a configurable accessor disguised as a data property", () => {
      const target = {};
      Object.defineProperty(target, "mode", {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("DIMENSION_GETTER_EXECUTED");
        }
      });
      return new Proxy(target, {
        getOwnPropertyDescriptor: () => ({
          configurable: true,
          enumerable: true,
          value: "SLIDER",
          writable: true
        })
      });
    }]
  ] as const)("rejects Proxy shape spoof: %s", (_label, createDimensions) => {
    const received: ProductEvent[] = [];
    const recorder = createProductEventRecorder((event) => received.push(event));

    expect(() =>
      recorder.record("PREVIEW_COMPARE_USED", createDimensions() as never)
    ).toThrow("INVALID_PRODUCT_EVENT");
    expect(received).toEqual([]);
  });

  it("rejects free text when a Proxy trap poisons Array.prototype.includes", () => {
    const received: ProductEvent[] = [];
    const recorder = createProductEventRecorder((event) => received.push(event));
    const originalIncludes = Array.prototype.includes;
    const dimensions = new Proxy({ mode: "PRIVATE_FREE_TEXT" }, {
      getPrototypeOf(target) {
        Array.prototype.includes = (() => true) as typeof Array.prototype.includes;
        return Reflect.getPrototypeOf(target);
      }
    });
    let thrown: unknown;

    try {
      recorder.record("PREVIEW_COMPARE_USED", dimensions as never);
    } catch (error) {
      thrown = error;
    } finally {
      Array.prototype.includes = originalIncludes;
    }

    expect(Array.prototype.includes).toBe(originalIncludes);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("INVALID_PRODUCT_EVENT");
    expect(received).toEqual([]);
  });

  it.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const)(
    "normalizes a throwing %s trap to INVALID_PRODUCT_EVENT",
    (trap) => {
      const received: ProductEvent[] = [];
      const recorder = createProductEventRecorder((event) => received.push(event));
      const target = { mode: "SLIDER" };
      const dimensions = trap === "getPrototypeOf"
        ? new Proxy(target, { getPrototypeOf: () => { throw new Error("TRAP_FAILURE"); } })
        : trap === "ownKeys"
          ? new Proxy(target, { ownKeys: () => { throw new Error("TRAP_FAILURE"); } })
          : new Proxy(target, { getOwnPropertyDescriptor: () => { throw new Error("TRAP_FAILURE"); } });

      expect(() =>
        recorder.record("PREVIEW_COMPARE_USED", dimensions)
      ).toThrow("INVALID_PRODUCT_EVENT");
      expect(received).toEqual([]);
    }
  );
});
