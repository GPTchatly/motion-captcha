import { z } from 'zod';
import { TARGET_GLYPH_COUNT } from './security-core.mjs';

export const emptyRequestSchema = z.object({}).strict();

export const challengeRouteParametersSchema = z
  .object({
    challengeId: z.string().uuid({ version: 'v4' })
  })
  .strict();

export const verificationRequestSchema = z
  .object({
    selectedIds: z.array(z.string().uuid({ version: 'v4' })).length(TARGET_GLYPH_COUNT),
    nextPath: z.string().min(1).max(2_048).optional()
  })
  .strict();

export function validateRequestBody(schema, value) {
  const result = schema.safeParse(value);
  return result.success ? { success: true, data: result.data } : { success: false };
}
