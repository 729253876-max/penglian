import type { EditTraceEvent, TaskSnapshot } from "@photo-ai/contracts";

function alignedJournal(
  routeTaskId: string,
  snapshot: TaskSnapshot,
  events: readonly EditTraceEvent[],
  nextSequence: number
): boolean {
  return snapshot.taskId === routeTaskId &&
    nextSequence === snapshot.lastSequence &&
    events.length === snapshot.lastSequence &&
    events.every((event, index) =>
      event.taskId === routeTaskId && event.sequence === index + 1
    );
}

export function successEvidence(
  routeTaskId: string,
  snapshot: TaskSnapshot,
  events: readonly EditTraceEvent[],
  nextSequence: number
): boolean {
  if (snapshot.status !== "SUCCEEDED" || !snapshot.previewUrl ||
      !alignedJournal(routeTaskId, snapshot, events, nextSequence) || events.length < 2) {
    return false;
  }
  const passed = events.at(-2);
  const ready = events.at(-1);
  return passed?.type === "QUALITY_CHECK_PASSED" && passed.evidenceSource === "QUALITY_GATE" &&
    ready?.type === "PREVIEW_READY" && ready.evidenceSource === "QUALITY_GATE";
}

export function failureEvidence(
  routeTaskId: string,
  snapshot: TaskSnapshot,
  events: readonly EditTraceEvent[],
  nextSequence: number
): { code: string; failedChecks: string[] } | undefined {
  if (!alignedJournal(routeTaskId, snapshot, events, nextSequence)) return undefined;
  const terminal = events.at(-1);
  if (terminal?.type !== "TASK_FAILED") return undefined;
  const code = terminal.payload.code;
  if (snapshot.failureCode !== undefined && snapshot.failureCode !== code) return undefined;
  const qualityFailure = events.findLast((event) => event.type === "QUALITY_CHECK_FAILED");
  return {
    code,
    failedChecks: qualityFailure?.type === "QUALITY_CHECK_FAILED"
      ? [...qualityFailure.payload.failedChecks]
      : []
  };
}

export type RenderEvent = EditTraceEvent & {
  text: string;
  evidenceLabel: "系统检测" | "用户选择" | "处理服务回执" | "项目质量检查";
};

const eventCopy: Record<EditTraceEvent["copyKey"], string> = {
  "upload.asset.approved": "已确认私密上传资产可用于修复",
  "portrait.diagnosis.started": "正在分析照片的光线、肤质与主体结构",
  "portrait.diagnosis.light": "已记录照片中检测到的可修复问题",
  "portrait.protection.recorded": "已记录人物与构图保护边界",
  "portrait.plan.natural": "已制定保留真实肤质的自然救片方案",
  "portrait.plan.clear": "已制定增强清晰度并保持人物真实的救片方案",
  "portrait.plan.selected": "已按用户选择确认忠实救片方向",
  "portrait.stage.retouch.started": "处理服务已开始恢复局部光影与肤质层次",
  "portrait.parameter.direction": "处理服务已应用用户确认的精修方向",
  "portrait.stage.retouch.completed": "处理服务已完成本轮局部调整",
  "quality.started": "项目正在检查人物身份与非目标区域稳定性",
  "quality.fidelity.failed": "项目忠实质量检查未通过",
  "portrait.retry.started": "项目已开始一次质量重试",
  "quality.fidelity.passed": "项目忠实质量检查通过",
  "preview.ready": "水印预览已经通过项目质量门禁",
  "preview.provider.failed": "任务失败并已停止，未生成可查看预览"
};

const evidenceLabels: Record<EditTraceEvent["evidenceSource"], RenderEvent["evidenceLabel"]> = {
  SYSTEM_CHECK: "系统检测",
  USER_SELECTION: "用户选择",
  PROVIDER_RECEIPT: "处理服务回执",
  QUALITY_GATE: "项目质量检查"
};

export function presentTrace(events: readonly EditTraceEvent[]): RenderEvent[] {
  return events.map((event) => ({
    ...event,
    text: eventCopy[event.copyKey],
    evidenceLabel: evidenceLabels[event.evidenceSource]
  }));
}

export interface TraceSummary {
  phase: EditTraceEvent["phase"];
  latestSequence: number;
  sourceEventIds: string[];
  status: "ACTIVE" | "COMPLETED" | "FAILED";
}

const completedEventTypes = new Set<EditTraceEvent["type"]>([
  "PLAN_READY",
  "STAGE_COMPLETED",
  "QUALITY_CHECK_PASSED",
  "PREVIEW_READY"
]);

export function summarizeTrace(
  events: readonly EditTraceEvent[]
): TraceSummary[] {
  const byPhase = new Map<EditTraceEvent["phase"], EditTraceEvent[]>();

  for (const event of events) {
    const phaseEvents = byPhase.get(event.phase) ?? [];
    phaseEvents.push(event);
    byPhase.set(event.phase, phaseEvents);
  }

  const summaries = [...byPhase.values()].map((phaseEvents) => {
    const orderedEvents = [...phaseEvents].sort(
      (left, right) => left.sequence - right.sequence
    );
    const latestEvent = orderedEvents[orderedEvents.length - 1]!;
    const hasLaterPhase = events.some((event) =>
      event.sequence > latestEvent.sequence && event.phase !== latestEvent.phase
    );

    return {
      firstSequence: orderedEvents[0]!.sequence,
      phase: latestEvent.phase,
      latestSequence: latestEvent.sequence,
      sourceEventIds: orderedEvents.map((event) => event.eventId),
      status: orderedEvents.some((event) => event.type === "TASK_FAILED")
        ? "FAILED" as const
        : completedEventTypes.has(latestEvent.type) || hasLaterPhase
          ? "COMPLETED" as const
          : "ACTIVE" as const
    };
  });

  return summaries
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .map(({ firstSequence: _, ...summary }): TraceSummary => summary);
}
