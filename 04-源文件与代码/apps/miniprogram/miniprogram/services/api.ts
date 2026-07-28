import type {
  CreateTaskInput,
  EditTraceEvent,
  TaskSnapshot
} from "@photo-ai/contracts";
import {
  parseEditTraceEvent,
  parseTaskSnapshot
} from "./runtime-contracts.js";

const API_BASE = "http://127.0.0.1:3100";

type EventPage = {
  items: EditTraceEvent[];
  nextSequence: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseEventPage(
  expectedTaskId: string,
  afterSequence: number
): (value: unknown) => EventPage {
  return (value) => {
    if (!isRecord(value) || !Array.isArray(value.items) || !isNonNegativeSafeInteger(value.nextSequence)) {
      throw new Error("API_RESPONSE_INVALID");
    }

    let previousSequence = afterSequence;
    const items = value.items.map((event) => {
      const parsed = parseEditTraceEvent(event);
      if (
        parsed.taskId !== expectedTaskId ||
        parsed.sequence !== previousSequence + 1
      ) {
        throw new Error("API_RESPONSE_INVALID");
      }
      previousSequence = parsed.sequence;
      return parsed;
    });

    if (value.nextSequence !== previousSequence) {
      throw new Error("API_RESPONSE_INVALID");
    }

    return { items, nextSequence: value.nextSequence };
  };
}

function request<T>(
  options: WechatMiniprogram.RequestOption,
  parse: (value: unknown) => T
): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      ...options,
      url: `${API_BASE}${options.url}`,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          try {
            resolve(parse(response.data));
          } catch {
            reject(new Error("API_RESPONSE_INVALID"));
          }
          return;
        }
        reject(new Error(`API_${response.statusCode}`));
      },
      fail: reject
    });
  });
}

function taskPath(taskId: string): string {
  return encodeURIComponent(taskId);
}

export const createTask = (input: CreateTaskInput) =>
  request<TaskSnapshot>({
    method: "POST",
    url: "/v1/tasks",
    data: input
  }, parseTaskSnapshot);

export const runPreview = (taskId: string) =>
  request<TaskSnapshot>({
    method: "POST",
    url: `/v1/tasks/${taskPath(taskId)}/preview`,
    data: {}
  }, parseTaskSnapshot);

export const getTask = (taskId: string) =>
  request<TaskSnapshot>({
    method: "GET",
    url: `/v1/tasks/${taskPath(taskId)}`
  }, parseTaskSnapshot);

export const getEvents = (taskId: string, afterSequence: number) => {
  if (!isNonNegativeSafeInteger(afterSequence)) {
    return Promise.reject(new Error("INVALID_AFTER_SEQUENCE"));
  }

  return request<EventPage>({
    method: "GET",
    url: `/v1/tasks/${taskPath(taskId)}/events?afterSequence=${afterSequence}`
  }, parseEventPage(taskId, afterSequence));
};
