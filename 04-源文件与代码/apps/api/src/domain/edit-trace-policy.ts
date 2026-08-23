import {
  EditTraceEventSchema,
  type EditTraceEvent
} from "@photo-ai/contracts";

export function sanitizeEditTraceEvent(event: unknown): EditTraceEvent {
  return EditTraceEventSchema.parse(event);
}

const providerReceiptTypes = new Set<EditTraceEvent["type"]>([
  "STAGE_STARTED",
  "PARAM_DIRECTION_APPLIED",
  "STAGE_COMPLETED"
]);

export function sanitizeProviderReceiptEvent(event: unknown): EditTraceEvent {
  const sanitized = sanitizeEditTraceEvent(event);
  if (
    sanitized.evidenceSource !== "PROVIDER_RECEIPT" ||
    !providerReceiptTypes.has(sanitized.type)
  ) {
    throw new Error("TRACE_AUTHORITY_INVALID");
  }
  return sanitized;
}
