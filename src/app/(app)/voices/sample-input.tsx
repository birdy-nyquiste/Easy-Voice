"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { buttonClass, inputClass } from "@/components/ui";
import { formatMegabytes } from "@/lib/format";

/** File input that can also be filled from a microphone recording. */
export function SampleInput({ maxBytes }: { maxBytes: number }) {
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
    } catch {
      releaseMic();
      setError(t("micDenied"));
    }
  }

  function stop() {
    recRef.current?.stop();
    setRecording(false);
  }

  return (
    <div className="space-y-2">
      <input
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
        {recording && <span className="text-sm text-red-600">{t("recording")}</span>}
      </div>
      {preview && !recording && (
        <div className="flex items-center gap-3">
          <audio controls src={preview} className="min-w-0 flex-1" />
          <button type="button" onClick={() => setSample(null)} className={buttonClass("secondary")}>
            {tc("remove")}
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
