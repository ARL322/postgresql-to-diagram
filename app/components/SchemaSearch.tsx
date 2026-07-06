"use client";
import { useState, useMemo, useRef, useEffect } from 'react';
import { Node } from 'reactflow';

type ItemKind = 'table' | 'procedure' | 'column' | 'parameter' | 'index' | 'trigger';

interface SearchableItem {
  id: string;        // key único para el render
  nodeId: string;     // id del nodo de React Flow al que hay que saltar
  kind: ItemKind;
  label: string;       // texto principal (nombre de tabla, columna, etc.)
  context?: string;    // texto secundario (p.ej. tabla dueña de la columna)
  icon: string;
}

const KIND_LABELS: Record<ItemKind, string> = {
  table: 'Tabla',
  procedure: 'Función/Proc',
  column: 'Columna',
  parameter: 'Parámetro',
  index: 'Índice',
  trigger: 'Trigger',
};

// Prioridad de coincidencia: nombres exactos/empiezan-por primero, luego
// tablas y procedimientos antes que sus columnas/parámetros internos.
const KIND_WEIGHT: Record<ItemKind, number> = {
  table: 0,
  procedure: 0,
  column: 1,
  parameter: 1,
  index: 2,
  trigger: 2,
};

function buildSearchIndex(nodes: Node[]): SearchableItem[] {
  const result: SearchableItem[] = [];

  // Si por alguna razón el estado de React Flow llegara a tener dos nodos
  // con el mismo id (p. ej. un CREATE TABLE duplicado en el SQL), nos
  // quedamos solo con la primera aparición para no generar entradas
  // repetidas en el buscador.
  const seenNodeIds = new Set<string>();
  const dedupedNodes = nodes.filter((node) => {
    if (seenNodeIds.has(node.id)) return false;
    seenNodeIds.add(node.id);
    return true;
  });

  // Garantiza además que cada item del índice tenga una key única, incluso
  // si dos columnas/parámetros terminaran generando el mismo id base.
  const usedItemIds = new Set<string>();
  const pushUnique = (item: SearchableItem) => {
    let id = item.id;
    let suffix = 1;
    while (usedItemIds.has(id)) {
      id = `${item.id}__dup${suffix++}`;
    }
    usedItemIds.add(id);
    result.push({ ...item, id });
  };

  dedupedNodes.forEach((node) => {
    if (node.type === 'tableNode') {
      const displayName = node.data.schema ? `${node.data.schema}.${node.data.label}` : node.data.label;

      pushUnique({ id: `table-${node.id}`, nodeId: node.id, kind: 'table', label: displayName, icon: '🗂️' });

      (node.data.columns ?? []).forEach((col: any) => {
        pushUnique({
          id: `col-${node.id}-${col.name}`,
          nodeId: node.id,
          kind: 'column',
          label: col.name,
          context: displayName,
          icon: col.isPK ? '🔑' : col.isFKSource ? '🔗' : '▫️',
        });
      });

      (node.data.indexes ?? []).forEach((idx: any, i: number) => {
        if (!idx.name) return;
        pushUnique({
          id: `idx-${node.id}-${idx.name}-${i}`,
          nodeId: node.id,
          kind: 'index',
          label: idx.name,
          context: displayName,
          icon: idx.isUnique ? '💎' : '⚡',
        });
      });

      (node.data.triggers ?? []).forEach((trg: any, i: number) => {
        if (!trg.name) return;
        pushUnique({
          id: `trg-${node.id}-${trg.name}-${i}`,
          nodeId: node.id,
          kind: 'trigger',
          label: trg.name,
          context: displayName,
          icon: '🔔',
        });
      });
    } else if (node.type === 'procedureNode') {
      const displayName = node.data.schema ? `${node.data.schema}.${node.data.label}` : node.data.label;
      const isProc = node.data.returnType === 'PROCEDURE';

      pushUnique({
        id: `proc-${node.id}`,
        nodeId: node.id,
        kind: 'procedure',
        label: displayName,
        icon: isProc ? '⚙️' : '🧩',
      });

      (node.data.parameters ?? []).forEach((param: string, i: number) => {
        pushUnique({
          id: `param-${node.id}-${i}`,
          nodeId: node.id,
          kind: 'parameter',
          label: param,
          context: displayName,
          icon: '📝',
        });
      });
    }
  });

  return result;
}

interface FieldProps {
  nodes: Node[];
  onFocusNode: (nodeId: string) => void;
  // Se dispara cuando el dropdown de resultados se abre; lo usa
  // DiagramToolbar para cerrar cualquier otro panel (línea/layout/ayuda)
  // que estuviera abierto, así solo un panel flotante vive a la vez.
  onOpenChange?: (isOpen: boolean) => void;
  className?: string;
}

/**
 * Campo de búsqueda con autocomplete, sin posicionamiento propio: se ubica
 * donde el padre lo coloque (dentro de DiagramToolbar, en una fila flex).
 * Mantiene toda la lógica de índice/filtrado/teclado, para que el atajo
 * Ctrl/Cmd+K y el buscador en sí puedan reutilizarse en cualquier layout.
 */
export function SchemaSearchField({ nodes, onFocusNode, onOpenChange, className }: FieldProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => buildSearchIndex(nodes), [nodes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    return items
      .filter((it) => it.label.toLowerCase().includes(q) || it.context?.toLowerCase().includes(q))
      .sort((a, b) => {
        const aLabel = a.label.toLowerCase();
        const bLabel = b.label.toLowerCase();
        const aStarts = aLabel.startsWith(q) ? 0 : 1;
        const bStarts = bLabel.startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        if (KIND_WEIGHT[a.kind] !== KIND_WEIGHT[b.kind]) return KIND_WEIGHT[a.kind] - KIND_WEIGHT[b.kind];
        return aLabel.localeCompare(bLabel);
      })
      .slice(0, 40);
  }, [items, query]);

  useEffect(() => setActiveIndex(0), [query]);

  const updateOpen = (open: boolean) => {
    setIsOpen(open);
    onOpenChange?.(open);
  };

  // Cierra el dropdown al hacer clic fuera del buscador
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as globalThis.Node)) {
        updateOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Atajo Ctrl/Cmd + K para enfocar el buscador desde cualquier parte
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        updateOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleSelect = (item: SearchableItem) => {
    onFocusNode(item.nodeId);
    setQuery('');
    updateOpen(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || filtered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect(filtered[activeIndex]);
    } else if (e.key === 'Escape') {
      updateOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={wrapperRef} className={`relative w-[210px] shrink-0 ${className ?? ''}`}>
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          🔍
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); updateOpen(true); }}
          onFocus={() => updateOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Buscar en el esquema…"
          className="w-full h-8 pl-7 pr-11 rounded-lg border border-border bg-muted/40 text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-shadow"
        />
        <kbd className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] font-mono text-muted-foreground bg-muted px-1 py-0.5 rounded border border-border pointer-events-none">
          ⌘K
        </kbd>
      </div>

      {isOpen && query && (
        <div className="absolute left-0 top-full mt-1.5 w-[360px] max-w-[80vw] max-h-[380px] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl divide-y divide-border z-40">
          {filtered.length === 0 ? (
            <div className="px-3.5 py-3 text-xs text-muted-foreground">
              Sin resultados para “{query}”
            </div>
          ) : (
            filtered.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setActiveIndex(idx)}
                className={`w-full flex items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors ${
                  idx === activeIndex ? 'bg-indigo-50 dark:bg-indigo-950/40' : 'hover:bg-muted/60'
                }`}
              >
                <span className="text-sm shrink-0">{item.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono font-semibold text-foreground truncate">{item.label}</div>
                  {item.context && (
                    <div className="text-[10px] text-muted-foreground truncate">{item.context}</div>
                  )}
                </div>
                <span className="text-[9px] uppercase tracking-wider text-muted-foreground shrink-0 bg-muted px-1.5 py-0.5 rounded">
                  {KIND_LABELS[item.kind]}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface StandaloneProps {
  nodes: Node[];
  onFocusNode: (nodeId: string) => void;
}

// Wrapper flotante standalone, por si en algún momento se necesita el
// buscador solo, sin el resto de la toolbar (DiagramToolbar ya no lo usa).
export default function SchemaSearch({ nodes, onFocusNode }: StandaloneProps) {
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30">
      <SchemaSearchField nodes={nodes} onFocusNode={onFocusNode} />
    </div>
  );
}