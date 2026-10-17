/** Photo and receipt uploads to the private "files" bucket, under the company's folder. */
import { supabase } from "./api";

const MAX_BYTES = 15 * 1024 * 1024;

/** Shrink a photo to at most `max` pixels on its long side (phones take huge pictures). */
export async function compressImage(file: File, max = 2000, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file; // HEIC or another format the browser can't decode: upload as-is
  }
}

/** Upload a file under <company>/<folder>/ and return its storage path. */
export async function uploadFile(companyId: string, folder: string, file: File): Promise<string> {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 15 MB.`);
  const body = await compressImage(file);
  const ext = body === file ? (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") : "jpg";
  const path = `${companyId}/${folder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase().storage.from("files").upload(path, body, { contentType: body.type || file.type || "application/octet-stream", upsert: false });
  if (error) throw new Error(/row-level security/i.test(error.message) ? "You don't have permission to upload here." : `Upload failed: ${error.message}`);
  return path;
}

export async function signedUrls(paths: string[], seconds = 3600): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data, error } = await supabase().storage.from("files").createSignedUrls(paths, seconds);
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).flatMap((d) => (d.signedUrl && d.path ? [[d.path, d.signedUrl] as const] : [])));
}
