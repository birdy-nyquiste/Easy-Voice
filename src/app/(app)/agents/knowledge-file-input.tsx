"use client";

import { useState } from "react";

/**
 * The knowledge file picker. Files over the limits are refused here: the server never sees an upload
 * over the request size limit, so it couldn't say why (the user would get a generic network error).
 * The messages come rendered from the server, so their numbers are formatted like the server's.
 */
export function KnowledgeFileInput({
  maxPdfBytes,
  maxChars,
  tooLarge,
  tooLong,
}: {
  maxPdfBytes: number;
  maxChars: number;
  tooLarge: string;
  tooLong: string;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <input
        type="file"
        name="file"
        required
        accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
        className="block text-sm"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const isPdf = Boolean(file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name)));
          // Text can't take more than 4 bytes per character, so a larger file is certainly too long.
          const problem = !file ? null : isPdf ? (file.size > maxPdfBytes ? tooLarge : null) : file.size > maxChars * 4 ? tooLong : null;
          setError(problem);
          if (problem) e.target.value = "";
        }}
      />
      {error && (
        <p role="alert" className="mt-1 text-sm text-red-600">
          {error}
        </p>
      )}
    </>
  );
}
