import {
  EditTraceEventSchema,
  type EditTraceEvent
} from "@photo-ai/contracts";

export function sanitizeEditTraceEvent(event: unknown): EditTraceEvent {
  return EditTraceEventSchema.parse(event);
}
