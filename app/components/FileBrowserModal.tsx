"use client";
import { useState, useEffect } from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (fullPath: string) => void;
}

export default function FileBrowserModal({ isOpen, onClose, onSelect }: Props) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadDir = async (dir?: string) => {
    setLoading(true);
    setError('');
    try {
      const url = dir ? `/api/browse-fs?dir=${encodeURIComponent(dir)}` : '/api/browse-fs';
      const res = await fetch(url);

      if (!res.ok) {
        const text = await res.text();
        setError(`Error ${res.status}: ${text.slice(0, 150)}`);
        return;
      }

      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setCurrentPath(data.currentPath);
        setParentPath(data.parentPath);
        setDirs(data.dirs);
        setFiles(data.files);
      }
    } catch (e: any) {
      setError(`No se pudo leer la carpeta: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) loadDir();
  }, [isOpen]);

  if (!isOpen) return null;

  const sep = currentPath.includes('\\') ? '\\' : '/';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-card text-foreground rounded-xl shadow-2xl w-[420px] max-h-[70vh] flex flex-col p-4">
        <h3 className="font-semibold text-sm mb-2">Selecciona un archivo .sql</h3>

        <div className="text-xs text-muted-foreground mb-2 truncate">{currentPath}</div>

        {error && <div className="text-xs text-rose-600 dark:text-rose-400 mb-2">{error}</div>}

        <div className="flex-1 overflow-y-auto border border-border rounded-lg divide-y divide-border">
          {parentPath && parentPath !== currentPath && (
            <button
              onClick={() => loadDir(parentPath)}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted"
            >
              ⬅ .. (subir)
            </button>
          )}

          {dirs.map((d) => (
            <button
              key={d}
              onClick={() => loadDir(`${currentPath}${sep}${d}`)}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted"
            >
              📁 {d}
            </button>
          ))}

          {files.map((f) => (
            <button
              key={f}
              onClick={() => {
                onSelect(`${currentPath}${sep}${f}`);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 dark:hover:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400"
            >
              📄 {f}
            </button>
          ))}

          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Cargando...</div>}
        </div>

        <button
          onClick={onClose}
          className="mt-3 text-xs px-3 py-1.5 bg-muted hover:bg-muted/70 rounded-lg self-end"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}