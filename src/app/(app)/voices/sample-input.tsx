"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClass, inputClass } from "@/components/ui";

/** File input that can also be filled from a microphone recording. */
export function SampleInput({ maxBytes }: { maxBytes: number }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  /** Put a file into the input (or clear it), validating its size. */
  function setSample(file: File | null) {
    setError(null);
    if (file && file.size > maxBytes) {
      setError(`That sample is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${Math.floor(maxBytes / 1024 / 1024)} MB — use a shorter clip.`);
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
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : "webm";
        setSample(new File(chunks, `recording.${ext}`, { type }));
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch {
      setError("Microphone access was denied.");
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
          {recording ? "■ Stop recording" : "● Record instead"}
        </button>
        {recording && <span className="text-sm text-red-600">Recording… read naturally for 10–15 seconds.</span>}
      </div>
      {preview && !recording && (
        <div className="flex items-center gap-3">
          <audio controls src={preview} className="min-w-0 flex-1" />
          <button type="button" onClick={() => setSample(null)} className={buttonClass("secondary")}>
            Remove
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
