const nativeError = Error;
const objectPrototype = Object.prototype;
const freezeObject = Object.freeze;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const isArray = Array.isArray;
const ownKeys = Reflect.ownKeys;
function readExactDimension(dimensions, key, allowedValues) {
    try {
        if (typeof dimensions !== "object" || dimensions === null || isArray(dimensions)) {
            return undefined;
        }
        freezeObject(dimensions);
        if (getPrototypeOf(dimensions) !== objectPrototype) {
            return undefined;
        }
        const keys = ownKeys(dimensions);
        if (keys.length !== 1 || keys[0] !== key) {
            return undefined;
        }
        const descriptor = getOwnPropertyDescriptor(dimensions, key);
        if (descriptor === undefined
            || !("value" in descriptor)
            || descriptor.enumerable !== true) {
            return undefined;
        }
        const value = descriptor.value;
        if (typeof value !== "string") {
            return undefined;
        }
        for (let index = 0; index < allowedValues.length; index += 1) {
            if (value === allowedValues[index]) {
                return value;
            }
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
function invalidProductEvent() {
    throw new nativeError("INVALID_PRODUCT_EVENT");
}
export function createProductEventRecorder(sink) {
    return {
        record(name, dimensions) {
            switch (name) {
                case "HOME_PRIMARY_TAPPED": {
                    const scenario = readExactDimension(dimensions, "scenario", ["TRAVEL_PORTRAIT"]);
                    if (scenario === undefined) {
                        invalidProductEvent();
                    }
                    sink({ name, dimensions: { scenario } });
                    return;
                }
                case "HOME_OWN_PHOTO_TAPPED": {
                    const source = readExactDimension(dimensions, "source", ["HOME"]);
                    if (source === undefined) {
                        invalidProductEvent();
                    }
                    sink({ name, dimensions: { source } });
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
