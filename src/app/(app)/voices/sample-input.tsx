"use client";

import { useRef, useState } from "react";
import { buttonClass, inputClass } from "@/components/ui";

/** File input that can also be filled from a microphone recording. */
export function SampleInput() {
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        const file = new File(chunks, `recording.${ext}`, { type });
        const dt = new DataTransfer();
        dt.items.add(file);
        if (fileRef.current) fileRef.current.files = dt.files;
        setPreview(URL.createObjectURL(file));
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
        onChange={(e) => {
          const f = e.target.files?.[0];
          setPreview(f ? URL.createObjectURL(f) : null);
        }}
      />
      <div className="flex items-center gap-3">
        <button type="button" onClick={recording ? stop : start} className={buttonClass(recording ? "danger" : "secondary")}>
          {recording ? "■ Stop recording" : "● Record instead"}
        </button>
        {recording && <span className="text-sm text-red-600">Recording… read naturally for 10–15 seconds.</span>}
      </div>
      {preview && !recording && <audio controls src={preview} className="w-full" />}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
