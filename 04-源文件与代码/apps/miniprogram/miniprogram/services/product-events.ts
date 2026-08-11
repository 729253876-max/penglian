export type ProductEvent =
  | { name: "HOME_PRIMARY_TAPPED"; dimensions: { scenario: "TRAVEL_PORTRAIT" } }
  | { name: "DEMO_CASE_OPENED"; dimensions: { source: "HOME" } }
  | { name: "DEMO_STARTED"; dimensions: { source: "CASE_PAGE" } }
  | { name: "PREVIEW_COMPARE_USED"; dimensions: { mode: "SLIDER" } }
  | { name: "PREVIEW_DETAILS_TOGGLED"; dimensions: { state: "OPEN" | "CLOSED" } };

export type ProductEventName = ProductEvent["name"];

function readExactDimension<const Value extends string>(
  dimensions: object,
  key: string,
  allowedValues: readonly Value[]
): Value | undefined {
  if (typeof dimensions !== "object" || dimensions === null || Array.isArray(dimensions)) {
    return undefined;
  }
  if (Object.getPrototypeOf(dimensions) !== Object.prototype) {
    return undefined;
  }
  const keys = Reflect.ownKeys(dimensions);
  if (keys.length !== 1 || keys[0] !== key) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(dimensions, key);
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || descriptor.enumerable !== true
  ) {
    return undefined;
  }
  const value = descriptor.value;
  if (typeof value !== "string" || !allowedValues.includes(value as Value)) {
    return undefined;
  }
  return value as Value;
}

function invalidProductEvent(): never {
  throw new Error("INVALID_PRODUCT_EVENT");
}

export function createProductEventRecorder(sink: (event: ProductEvent) => void) {
  return {
    record(name: ProductEventName, dimensions: object): void {
      switch (name) {
        case "HOME_PRIMARY_TAPPED": {
          const scenario = readExactDimension(dimensions, "scenario", ["TRAVEL_PORTRAIT"]);
          if (scenario === undefined) {
            invalidProductEvent();
          }
          sink({ name, dimensions: { scenario } });
          return;
        }
        case "DEMO_CASE_OPENED": {
          const source = readExactDimension(dimensions, "source", ["HOME"]);
          if (source === undefined) {
            invalidProductEvent();
          }
          sink({ name, dimensions: { source } });
          return;
        }
        case "DEMO_STARTED": {
          const source = readExactDimension(dimensions, "source", ["CASE_PAGE"]);
          if (source === undefined) {
            invalidProductEvent();
          }
          sink({ name, dimensions: { source } });
          return;
        }
        case "PREVIEW_COMPARE_USED": {
          const mode = readExactDimension(dimensions, "mode", ["SLIDER"]);
          if (mode === undefined) {
            invalidProductEvent();
          }
          sink({ name, dimensions: { mode } });
          return;
        }
        case "PREVIEW_DETAILS_TOGGLED": {
          const state = readExactDimension(dimensions, "state", ["OPEN", "CLOSED"]);
          if (state === undefined) {
            invalidProductEvent();
          }
          sink({ name, dimensions: { state } });
          return;
        }
        default:
          invalidProductEvent();
      }
    }
  };
}

export const productEvents = createProductEventRecorder(() => undefined);
