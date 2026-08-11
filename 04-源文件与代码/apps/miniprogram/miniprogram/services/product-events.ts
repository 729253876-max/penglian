export type ProductEvent =
  | { name: "HOME_PRIMARY_TAPPED"; dimensions: { scenario: "TRAVEL_PORTRAIT" } }
  | { name: "DEMO_CASE_OPENED"; dimensions: { source: "HOME" } }
  | { name: "DEMO_STARTED"; dimensions: { source: "CASE_PAGE" } }
  | { name: "PREVIEW_COMPARE_USED"; dimensions: { mode: "SLIDER" } }
  | { name: "PREVIEW_DETAILS_TOGGLED"; dimensions: { state: "OPEN" | "CLOSED" } };

export type ProductEventName = ProductEvent["name"];

function hasExactDimension(
  dimensions: object,
  key: string,
  allowedValues: readonly string[]
): boolean {
  if (typeof dimensions !== "object" || dimensions === null || Array.isArray(dimensions)) {
    return false;
  }
  const values = dimensions as Record<string, unknown>;
  return Object.keys(values).length === 1
    && Object.prototype.hasOwnProperty.call(values, key)
    && typeof values[key] === "string"
    && allowedValues.includes(values[key]);
}

function invalidProductEvent(): never {
  throw new Error("INVALID_PRODUCT_EVENT");
}

export function createProductEventRecorder(sink: (event: ProductEvent) => void) {
  return {
    record(name: ProductEventName, dimensions: object): void {
      switch (name) {
        case "HOME_PRIMARY_TAPPED":
          if (!hasExactDimension(dimensions, "scenario", ["TRAVEL_PORTRAIT"])) {
            invalidProductEvent();
          }
          sink({ name, dimensions: { scenario: "TRAVEL_PORTRAIT" } });
          return;
        case "DEMO_CASE_OPENED":
          if (!hasExactDimension(dimensions, "source", ["HOME"])) {
            invalidProductEvent();
          }
          sink({ name, dimensions: { source: "HOME" } });
          return;
        case "DEMO_STARTED":
          if (!hasExactDimension(dimensions, "source", ["CASE_PAGE"])) {
            invalidProductEvent();
          }
          sink({ name, dimensions: { source: "CASE_PAGE" } });
          return;
        case "PREVIEW_COMPARE_USED":
          if (!hasExactDimension(dimensions, "mode", ["SLIDER"])) {
            invalidProductEvent();
          }
          sink({ name, dimensions: { mode: "SLIDER" } });
          return;
        case "PREVIEW_DETAILS_TOGGLED": {
          if (!hasExactDimension(dimensions, "state", ["OPEN", "CLOSED"])) {
            invalidProductEvent();
          }
          const state = (dimensions as { state: "OPEN" | "CLOSED" }).state;
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
