import { z } from "zod";

export const docSchema = z.object({ type: z.literal("doc"), content: z.array(z.any()).max(5000) }).passthrough();

export const piecePatch = z.object({
  title: z.string().max(300).optional(),
  content: docSchema.optional(),
  anchor_point: z.string().max(5000).optional(),
  anchor_sections: z.string().max(5000).optional(),
  anchor_not_this: z.string().max(5000).optional(),
});

export const versionCreate = z.object({
  kind: z.enum(["flow", "auto", "manual", "safety", "stitch"]),
  label: z.string().max(200).default(""),
  content: docSchema,
});

export const anchorSchema = z.object({
  point: z.string().max(5000).default(""),
  sections: z.string().max(5000).default(""),
  notThis: z.string().max(5000).default(""),
});

export const draftBlocks = z.array(z.object({
  pid: z.string().regex(/^[a-z0-9]{4,16}$/),
  text: z.string().max(50_000),
  heading: z.boolean().optional(),
})).max(3000);
