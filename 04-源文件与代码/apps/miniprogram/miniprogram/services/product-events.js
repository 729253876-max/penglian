function hasExactDimension(dimensions, key, allowedValues) {
    if (typeof dimensions !== "object" || dimensions === null || Array.isArray(dimensions)) {
        return false;
    }
    const values = dimensions;
    return Object.keys(values).length === 1
        && Object.prototype.hasOwnProperty.call(values, key)
        && typeof values[key] === "string"
        && allowedValues.includes(values[key]);
}
function invalidProductEvent() {
    throw new Error("INVALID_PRODUCT_EVENT");
}
export function createProductEventRecorder(sink) {
    return {
        record(name, dimensions) {
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
                    const state = dimensions.state;
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
