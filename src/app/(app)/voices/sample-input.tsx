"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { buttonClass, inputClass, type FieldControl } from "@/components/ui";
import { formatMegabytes } from "@/lib/format";

/**
 * Why recording couldn't start. Only a refusal means access was denied; for the rest, uploading a file
 * still works. A browser without recording (or a page not served over HTTPS) fails before asking.
 */
function recordingProblem(err: unknown): "micDenied" | "micNotFound" | "micUnavailable" | "recordingUnsupported" {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "micDenied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "micNotFound";
  if (name === "NotReadableError" || name === "AbortError") return "micUnavailable";
  return "recordingUnsupported";
}

/**
 * File input that can also be filled from a microphone recording. `control` (from the Field it sits in)
 * labels the file input only, not the record and remove buttons beside it.
 */
export function SampleInput({ control, maxBytes }: { control: FieldControl; maxBytes: number }) {
  const t = useTranslations("voices");
  const tc = useTranslations("common");
  const locale = useLocale();
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  // Leaving the page mid-recording must turn the microphone off.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recRef.current?.state === "recording") recRef.current.stop();
      releaseMic();
    };
  }, []);

  // A successful clone resets the form; drop the recorded sample and its preview with it.
  useEffect(() => {
    const form = fileRef.current?.form;
    const clear = () => setPreview(null);
    form?.addEventListener("reset", clear);
    return () => form?.removeEventListener("reset", clear);
  }, []);

  function releaseMic() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  /** Put a file into the input (or clear it), validating its size. */
  function setSample(file: File | null) {
    setError(null);
    if (file && file.size > maxBytes) {
      setError(t("sampleTooLarge", { size: formatMegabytes(file.size, locale), max: formatMegabytes(maxBytes, locale) }));
      file = null;
    }
    const dt = new DataTransfer();
    if (file) dt.items.add(file);
    if (fileRef.current) fileRef.current.files = dt.files;
    setPreview(file ? URL.createObjectURL(file) : null);
  }

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      if (!mounted.current) return releaseMic(); // left the page while the permission prompt was open
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        releaseMic();
        if (!mounted.current) return;
        const type = rec.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : "webm";
        setSample(new File(chunks, `recording.${ext}`, { type }));
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch (err) {
      releaseMic();
      setError(t(recordingProblem(err)));
    }
  }

  function stop() {
    recRef.current?.stop();
    setRecording(false);
  }

  return (
    <div className="space-y-2">
      <input
        {...control}
        ref={fileRef}
        type="file"
        name="audio"
        accept="audio/*"
        required
        className={inputClass}
        onChange={(e) => setSample(e.target.files?.[0] ?? null)}
      />
      <div className="flex items-center gap-3">
        <button type="button" onClick={recording ? stop : start} className={buttonClass(recording ? "danger" : "secondary")}>
          {recording ? t("stopRecording") : t("record")}
        </button>
        {/* Always present, so screen readers announce when recording starts. */}
        <span role="status" className="text-sm text-red-600">
          {recording && t("recording")}
        </span>
      </div>
      {preview && !recording && (
        <div className="flex items-center gap-3">
          <audio controls src={preview} className="min-w-0 flex-1" />
          <button type="button" onClick={() => setSample(null)} className={buttonClass("secondary")}>
            {tc("remove")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
