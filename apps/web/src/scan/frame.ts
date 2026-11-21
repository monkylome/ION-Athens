import { FRAME_MAX_SIDE, FRAME_QUALITY, fitSize } from "./logic";

/**
 * One downscaled JPEG of what the video shows now, as base64 without the data-URL prefix.
 * The canvas is made here and discarded here; nothing is kept on this side either.
 */
export async function captureFrame(video: HTMLVideoElement): Promise<string> {
  const { width, height } = fitSize(video.videoWidth, video.videoHeight, FRAME_MAX_SIDE);
  if (!width || !height) throw new Error("no_frame");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
    for (const quality of [FRAME_QUALITY, 0.5, 0.35]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= 1_400_000) return await blobToBase64(blob);
    }
    throw new Error("too_large");
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
