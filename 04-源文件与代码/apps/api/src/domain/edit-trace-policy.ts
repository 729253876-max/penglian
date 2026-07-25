import {
  EditTraceEventSchema,
  type EditTraceEvent
} from "@photo-ai/contracts";

const forbiddenKeys = new Set([
  "chainofthought",
  "hiddenreasoning",
  "providerapikey",
  "providersecret",
  "providerrawresponse",
  "internalroute"
]);

const normalizePayloadKey = (key: string): string =>
  key.replace(/[^a-z0-9]/gi, "").toLowerCase();

export function sanitizeEditTraceEvent(event: EditTraceEvent): EditTraceEvent {
  const parsed = EditTraceEventSchema.parse(event);

  for (const key of Object.keys(parsed.payload)) {
    if (forbiddenKeys.has(normalizePayloadKey(key))) {
      throw new Error(`Forbidden EditTrace payload key: ${key}`);
    }
  }

  return parsed;
}
