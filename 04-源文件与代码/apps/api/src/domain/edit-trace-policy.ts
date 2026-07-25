import {
  EditTraceEventSchema,
  type EditTraceEvent
} from "@photo-ai/contracts";

const forbiddenKeys = new Set([
  "chainOfThought",
  "hiddenReasoning",
  "providerApiKey",
  "providerSecret",
  "providerRawResponse",
  "internalRoute"
]);

export function sanitizeEditTraceEvent(event: EditTraceEvent): EditTraceEvent {
  for (const key of Object.keys(event.payload)) {
    if (forbiddenKeys.has(key)) {
      throw new Error(`Forbidden EditTrace payload key: ${key}`);
    }
  }

  return EditTraceEventSchema.parse(event);
}
