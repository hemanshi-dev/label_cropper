"use client";

import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";

export default function PDFUpload() {
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pdfjs, setPdfjs] = useState<any>(null);

  useEffect(() => {
    const loadPdfjs = async () => {
      const module = await import("pdfjs-dist");
      module.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      setPdfjs(module);
    };
    loadPdfjs();
  }, []);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      setError(null);
      setPageCount(null);
      setFileName(null);

      if (acceptedFiles.length === 0 || !pdfjs) return;

      const file = acceptedFiles[0];

      if (file.type !== "application/pdf") {
        setError("Please upload a PDF file.");
        return;
      }

      setFileName(file.name);

      try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        setPageCount(pdf.numPages);
      } catch (err) {
        setError("Error reading PDF file. Please try again.");
        console.error(err);
      }
    },
    [pdfjs]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxFiles: 1,
  });

  return (
    <div className="max-w-md mx-auto p-6">
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
          isDragActive
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 hover:border-blue-400"
        }`}
      >
        <input {...getInputProps()} />
        <svg
          className="mx-auto h-12 w-12 text-gray-400"
          stroke="currentColor"
          fill="none"
          viewBox="0 0 48 48"
          aria-hidden="true"
        >
          <path
            d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {isDragActive ? (
          <p className="mt-2 text-blue-600">Drop the PDF here...</p>
        ) : (
          <p className="mt-2 text-gray-600">
            Drag & drop a PDF here, or{" "}
            <span className="text-blue-600 font-semibold">browse</span>
          </p>
        )}
        <p className="text-sm text-gray-500 mt-1">PDF files only</p>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {fileName && (
        <div className="mt-4 p-4 bg-gray-50 rounded-lg">
          <p className="text-gray-800 font-medium truncate">File: {fileName}</p>
          {pageCount !== null && (
            <p className="text-lg font-bold text-blue-600 mt-1">
              Total Pages: {pageCount}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
