import { z } from "zod";
import { body, json, route, uuid } from "@/lib/server/access";
import { fetchPublicImage, storeImage } from "@/lib/server/images";

/** Copy an image from a web address (pasted from a page or doc) into the writer's storage. */
export const POST = route("images.import", async ({ supabase, user, req }) => {
  const { url, pieceId } = await body(req, z.object({ url: z.string().url().max(4000), pieceId: uuid }));
  const bytes = await fetchPublicImage(url, req.signal);
  const src = await storeImage(supabase, user.id, pieceId, bytes);
  return json({ src }, 201);
}, { perMinute: 60 });
