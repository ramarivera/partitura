import type { ProjectionJob } from "../domain/models.js";
import {
  isActivitySignal,
  isActivityType,
  isRecord,
  isString,
} from "./linear-helpers.js";
import type { LinearPlanItem } from "./projector.js";

const text = (value: unknown): string | undefined =>
  isString(value) && value.length > 0 ? value : undefined;

export const decodeActivityRequest = (
  job: ProjectionJob,
): {
  readonly sessionId: string;
  readonly content: Record<string, unknown>;
} => {
  if (!isRecord(job.payload)) {
    throw new Error(`Projection ${job.sourceKey} payload is not an object`);
  }
  const request = job.payload.request;
  if (!isRecord(request) || !isRecord(request.content)) {
    throw new Error(`Projection ${job.sourceKey} activity request is invalid`);
  }
  const type = request.content.type;
  if (!isActivityType(type)) {
    throw new Error(`Projection ${job.sourceKey} activity type is invalid`);
  }
  const content: Record<string, unknown> = { type };
  const body = text(request.content.body);
  const action = text(request.content.action);
  const parameter = text(request.content.parameter);
  const result = text(request.content.result);
  if (body !== undefined) content.body = body;
  if (action !== undefined) content.action = action;
  if (parameter !== undefined) content.parameter = parameter;
  if (result !== undefined) content.result = result;
  if (request.ephemeral === true) content.ephemeral = true;
  const signal = isActivitySignal(request.signal) ? request.signal : undefined;
  if (signal !== undefined) content.signal = signal;
  const signalMetadata = isRecord(request.signalMetadata)
    ? request.signalMetadata
    : undefined;
  if (signalMetadata !== undefined) content.signalMetadata = signalMetadata;
  return { sessionId: job.sessionId, content };
};

export const decodeCommentRequest = (
  job: ProjectionJob,
): { readonly sessionId: string; readonly body: string } => {
  if (!isRecord(job.payload) || !isRecord(job.payload.request)) {
    throw new Error(`Projection ${job.sourceKey} comment request is invalid`);
  }
  const body = text(job.payload.request.body);
  if (body === undefined) {
    throw new Error(`Projection ${job.sourceKey} comment body is empty`);
  }
  return { sessionId: job.sessionId, body };
};

export const decodeSessionUpdate = (
  job: ProjectionJob,
): {
  readonly sessionId: string;
  readonly plan?: ReadonlyArray<LinearPlanItem>;
  readonly externalUrls?: ReadonlyArray<{
    readonly label: string;
    readonly url: string;
  }>;
} => {
  if (!isRecord(job.payload) || !isRecord(job.payload.request)) {
    throw new Error(`Projection ${job.sourceKey} session update is invalid`);
  }
  const raw = job.payload.request;
  const planInput = Array.isArray(raw.plan)
    ? raw.plan
    : isRecord(raw.plan) && Array.isArray(raw.plan.items)
      ? raw.plan.items
      : undefined;
  const plan = planInput?.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error(`Projection ${job.sourceKey} plan item is invalid`);
    }
    const content = text(entry.content);
    const status = text(entry.status);
    if (content === undefined || status === undefined) {
      throw new Error(`Projection ${job.sourceKey} plan item is invalid`);
    }
    return { content, status } as LinearPlanItem;
  });
  const externalUrls = Array.isArray(raw.externalUrls)
    ? raw.externalUrls.map((entry) => {
        if (!isRecord(entry)) {
          throw new Error(
            `Projection ${job.sourceKey} external URL is invalid`,
          );
        }
        const label = text(entry.label);
        const url = text(entry.url);
        if (label === undefined || url === undefined) {
          throw new Error(
            `Projection ${job.sourceKey} external URL is invalid`,
          );
        }
        return { label, url };
      })
    : undefined;
  if (plan === undefined && externalUrls === undefined) {
    throw new Error(`Projection ${job.sourceKey} session update is empty`);
  }
  return {
    sessionId: job.sessionId,
    ...(plan === undefined ? {} : { plan }),
    ...(externalUrls === undefined ? {} : { externalUrls }),
  };
};
