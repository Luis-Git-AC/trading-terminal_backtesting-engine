import {
  candleTickSchema,
  runDoneEventSchema,
  runErrorEventSchema,
  runProgressEventSchema,
  runStatusEventSchema,
} from '@tt/shared';
import type { z } from 'zod';

export const runStatusPayloadSchema = runStatusEventSchema.omit({ type: true });
export const runProgressPayloadSchema = runProgressEventSchema.omit({ type: true });
export const runDonePayloadSchema = runDoneEventSchema.omit({ type: true });
export const runErrorPayloadSchema = runErrorEventSchema.omit({ type: true });
export const candlePayloadSchema = candleTickSchema;

export type RunStatusPayload = z.infer<typeof runStatusPayloadSchema>;
export type RunProgressPayload = z.infer<typeof runProgressPayloadSchema>;
export type RunDonePayload = z.infer<typeof runDonePayloadSchema>;
export type RunErrorPayload = z.infer<typeof runErrorPayloadSchema>;
export type CandlePayload = z.infer<typeof candlePayloadSchema>;
