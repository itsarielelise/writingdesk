import { HttpError, json, route, uuid } from "@/lib/server/access";
import { MAX_IMAGE_BYTES, storeImage } from "@/lib/server/images";

/** Upload an image file (multipart: file, pieceId). */
export const POST = route("images.upload", async ({ supabase, user, req }) => {
  let form: FormData;
  try { form = await req.formData(); } catch { throw new HttpError(400, "Expected a file upload."); }
  const pieceId = uuid.parse(form.get("pieceId"));
  const file = form.get("file");
  if (!(file instanceof Blob)) throw new HttpError(400, "Expected a file upload.");
  if (file.size > MAX_IMAGE_BYTES) throw new HttpError(413, "That image is over 10 MB.");
  const src = await storeImage(supabase, user.id, pieceId, new Uint8Array(await file.arrayBuffer()));
  return json({ src }, 201);
}, { perMinute: 60 });
