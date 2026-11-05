"use client";
import type { Editor } from "@tiptap/react";
import { ApiError } from "./api";

const MAX_SIDE = 2400;
const SKIP_BELOW_BYTES = 1_500_000;

/** Shrink large photos before upload (keeps GIFs and small files as they are). */
export async function prepareImage(file: Blob): Promise<Blob> {
  if (file.type === "image/gif") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= SKIP_BELOW_BYTES) { bmp.close(); return file; }
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.86));
    return out && out.size < file.size ? out : file;
  } catch {
    return file; // unknown format to the browser: let the server decide
  }
}

async function post(path: string, init: RequestInit): Promise<string> {
  const res = await fetch(path, { method: "POST", ...init });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok || !data?.src) throw new ApiError(res.status, data?.error || "That image couldn’t be saved.");
  return data.src;
}

export async function uploadImage(pieceId: string, file: Blob): Promise<string> {
  const fd = new FormData();
  fd.append("pieceId", pieceId);
  fd.append("file", await prepareImage(file), "image");
  return post("/api/images", { body: fd });
}

export const importImage = (pieceId: string, url: string) =>
  post("/api/images/import", { headers: { "content-type": "application/json" }, body: JSON.stringify({ url, pieceId }) });

export function dataUrlToBlob(url: string): Blob | null {
  const m = url.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/i);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  } catch { return null; }
}

export const imageFiles = (list: FileList | File[] | null | undefined): File[] =>
  [...(list || [])].filter((f) => f.type.startsWith("image/"));

/** Set attrs on the image node matching `match`, outside undo history. */
export function patchImage(editor: Editor, match: (attrs: Record<string, any>) => boolean, patch: Record<string, unknown>) {
  if (editor.isDestroyed) return false;
  const { state } = editor;
  let found = -1;
  state.doc.forEach((n, pos) => { if (found < 0 && n.type.name === "image" && match(n.attrs)) found = pos; });
  if (found < 0) return false;
  const node = state.doc.nodeAt(found)!;
  editor.view.dispatch(state.tr.setNodeMarkup(found, undefined, { ...node.attrs, ...patch }).setMeta("addToHistory", false));
  return true;
}
