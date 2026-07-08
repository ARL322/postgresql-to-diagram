"use client";
import { useState, useEffect } from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Se llama con TODAS las rutas seleccionadas al confirmar. */
  onSelect: (fullPaths: string[]) => void;
  /** Rutas ya vinculadas antes de abrir el modal, para preseleccionarlas. */
  initialSelected?: string[];
}

export default function FileBrowserModal({ isOpen, onClose, onSelect, initialSelected = [] }: Props) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [dirs, setDirs] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Conjunto de rutas completas seleccionadas; persiste mientras se navega
  // entre carpetas para poder elegir archivos de distintas ubicaciones.
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
    if (isOpen) {
      loadDir();
      setSelected(new Set(initialSelected));
    }
    // Solo queremos re-sembrar la selección cuando el modal se abre, no en
    // cada cambio de initialSelected mientras está abierto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const sep = currentPath.includes('\\') ? '\\' : '/';

  const toggleFile = (fullPath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) {
        next.delete(fullPath);
      } else {
        next.add(fullPath);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    if (selected.size === 0) return;
    onSelect(Array.from(selected));
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-card text-foreground rounded-xl shadow-2xl w-[460px] max-h-[75vh] flex flex-col p-4">
        <h3 className="font-semibold text-sm mb-2">Selecciona uno o varios archivos .sql</h3>

        <div className="text-xs text-muted-foreground mb-2 truncate">{currentPath}</div>

        {error && <div className="text-xs text-rose-600 dark:text-rose-400 mb-2">{error}</div>}

        <div className="flex-1 overflow-y-auto border border-border rounded-lg divide-y divide-border">
          {parentPath && parentPath !== currentPath && (
            <button
              type="button"
              onClick={() => loadDir(parentPath)}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted"
            >
              ⬅ .. (subir)
            </button>
          )}

          {dirs.map((d) => (
            <button
              type="button"
              key={d}
              onClick={() => loadDir(`${currentPath}${sep}${d}`)}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted"
            >
              📁 {d}
            </button>
          ))}

          {files.map((f) => {
            const fullPath = `${currentPath}${sep}${f}`;
            const checked = selected.has(fullPath);
            return (
              <label
                key={f}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer ${
                  checked
                    ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400'
                    : 'hover:bg-muted'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleFile(fullPath)}
                  className="h-3.5 w-3.5 accent-indigo-600 shrink-0"
                />
                <span className="truncate">📄 {f}</span>
              </label>
            );
          })}

          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Cargando...</div>}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {selected.size > 0
              ? `${selected.size} archivo${selected.size === 1 ? '' : 's'} seleccionado${selected.size === 1 ? '' : 's'}`
              : 'Ningún archivo seleccionado'}
          </span>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-3 py-1.5 bg-muted hover:bg-muted/70 rounded-lg"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={selected.size === 0}
              className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Vincular {selected.size > 0 ? `(${selected.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}