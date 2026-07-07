"use client";
import { useState, useMemo, useRef, useEffect } from 'react';
import { Node } from 'reactflow';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { X, KeyRound, Link2, CircleDot, Zap, Gem, Bell, FolderTree, Cog, Puzzle, FileText } from 'lucide-react';

type ItemKind = 'table' | 'procedure' | 'column' | 'parameter' | 'index' | 'trigger';

interface SearchableItem {
  id: string;        // key único para el render
  nodeId: string;     // id del nodo de React Flow al que hay que saltar
  kind: ItemKind;
  label: string;       // texto principal (nombre de tabla, columna, etc.)
  context?: string;    // texto secundario (p.ej. tabla dueña de la columna)
  pk?: boolean;        // columna: es primary key
  fk?: boolean;        // columna: es fuente de foreign key
  unique?: boolean;    // índice: es único
  isProc?: boolean;    // procedimiento vs. función
}

const KIND_LABELS: Record<ItemKind, string> = {
  table: 'Tabla',
  procedure: 'Función/Proc',
  column: 'Columna',
  parameter: 'Parámetro',
  index: 'Índice',
  trigger: 'Trigger',
};

// Orden en el que se agrupan los resultados dentro del dropdown.
const KIND_ORDER: ItemKind[] = ['table', 'procedure', 'column', 'parameter', 'index', 'trigger'];

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

function ItemIcon({ item }: { item: SearchableItem }) {
  const cls = "size-3.5 shrink-0";
  switch (item.kind) {
    case 'table':
      return <FolderTree className={cls} />;
    case 'procedure':
      return item.isProc ? <Cog className={cls} /> : <Puzzle className={cls} />;
    case 'column':
      return item.pk ? <KeyRound className={cls} /> : item.fk ? <Link2 className={cls} /> : <CircleDot className={cls} />;
    case 'index':
      return item.unique ? <Gem className={cls} /> : <Zap className={cls} />;
    case 'trigger':
      return <Bell className={cls} />;
    case 'parameter':
      return <FileText className={cls} />;
    default:
      return null;
  }
}

function buildSearchIndex(nodes: Node[]): SearchableItem[] {
  const result: SearchableItem[] = [];

  // Si por alguna razón el estado de React Flow llegara a tener dos nodos
  // con el mismo id (p. ej. un CREATE TABLE duplicado en el SQL), nos
  // quedamos solo con la primera aparición para no generar entradas
  // repetidas en el buscador.
  //
  // OJO: deduplicar únicamente por node.id es incorrecto cuando dos tablas
  // distintas comparten nombre pero viven en esquemas diferentes (p. ej.
  // productos.unidad_medida y vucem.unidad_medida) y el generador de nodos
  // no incluyó el esquema al construir el id. En ese caso ambos nodos caen
  // con el mismo node.id y, sin esta corrección, solo el primero aparecería
  // en el buscador. Por eso la clave de deduplicación combina también el
  // esquema y el nombre visible (schema.label), para no descartar tablas
  // realmente distintas.
  const seenKeys = new Set<string>();
  const dedupedNodes = nodes.filter((node) => {
    const schema = node.data?.schema ? String(node.data.schema).toLowerCase() : '';
    const label = node.data?.label ? String(node.data.label).toLowerCase() : '';
    const key = `${node.type}::${schema}.${label}::${node.id}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
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

      pushUnique({ id: `table-${node.id}`, nodeId: node.id, kind: 'table', label: displayName });

      (node.data.columns ?? []).forEach((col: any) => {
        pushUnique({
          id: `col-${node.id}-${col.name}`,
          nodeId: node.id,
          kind: 'column',
          label: col.name,
          context: displayName,
          pk: !!col.isPK,
          fk: !!col.isFKSource,
        } as SearchableItem);
      });

      (node.data.indexes ?? []).forEach((idx: any, i: number) => {
        if (!idx.name) return;
        pushUnique({
          id: `idx-${node.id}-${idx.name}-${i}`,
          nodeId: node.id,
          kind: 'index',
          label: idx.name,
          context: displayName,
          unique: !!idx.isUnique,
        } as SearchableItem);
      });

      (node.data.triggers ?? []).forEach((trg: any, i: number) => {
        if (!trg.name) return;
        pushUnique({
          id: `trg-${node.id}-${trg.name}-${i}`,
          nodeId: node.id,
          kind: 'trigger',
          label: trg.name,
          context: displayName,
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
        isProc,
      } as SearchableItem);

      (node.data.parameters ?? []).forEach((param: string, i: number) => {
        pushUnique({
          id: `param-${node.id}-${i}`,
          nodeId: node.id,
          kind: 'parameter',
          label: param,
          context: displayName,
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
 * Mantiene toda la lógica de índice/filtrado, delegando la navegación por
 * teclado (flechas/Enter/Escape) al Command de shadcn (cmdk), para que el
 * atajo Ctrl/Cmd+K y el buscador en sí puedan reutilizarse en cualquier layout.
 */
export function SchemaSearchField({ nodes, onFocusNode, onOpenChange, className }: FieldProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
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

  // Agrupa los resultados ya ordenados por tipo, preservando su orden interno.
  const grouped = useMemo(() => {
    const byKind = new Map<ItemKind, SearchableItem[]>();
    filtered.forEach((item) => {
      const bucket = byKind.get(item.kind) ?? [];
      bucket.push(item);
      byKind.set(item.kind, bucket);
    });
    return KIND_ORDER.map((kind) => ({ kind, items: byKind.get(kind) ?? [] })).filter((g) => g.items.length > 0);
  }, [filtered]);

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
      if (e.key === 'Escape') {
        updateOpen(false);
        inputRef.current?.blur();
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

  const clear = () => {
    setQuery('');
    updateOpen(false);
  };

  return (
    <div ref={wrapperRef} className={`relative w-[210px] shrink-0 ${className ?? ''}`}>
      <Command
        shouldFilter={false}
        className=""
      >
        <div className="relative">
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={(v) => { setQuery(v); updateOpen(true); }}
            onFocus={() => updateOpen(true)}
            placeholder="Buscar en el esquema…"
            className="h-8 py-0 pr-10 text-xs placeholder:text-muted-foreground/70"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {query && (
              <button
                type="button"
                onClick={clear}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Limpiar"
              >
                <X className="size-3" />
              </button>
            )}
            <kbd className="hidden sm:inline-flex text-[9px] font-mono text-muted-foreground bg-muted px-1 py-0.5 rounded border border-border pointer-events-none">
              ⌘K
            </kbd>
          </div>
        </div>

            {isOpen && query && (
          <CommandList className="absolute left-0 top-full mt-1.5 w-[360px] max-w-[80vw] max-h-[380px] rounded-xl border border-border bg-card shadow-2xl z-40">
            <CommandEmpty className="px-3.5 py-3 text-xs text-muted-foreground">
              Sin resultados para “{query}”
            </CommandEmpty>

            {grouped.map(({ kind, items: groupItems }) => (
              <CommandGroup
                key={kind}
                heading={KIND_LABELS[kind]}
                className="[&_[cmdk-group-heading]]:px-3.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {groupItems.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => handleSelect(item)}
                    className="flex items-center gap-2 px-3.5 py-2 text-xs cursor-pointer aria-selected:bg-indigo-50 dark:aria-selected:bg-indigo-950/40"
                  >
                    <ItemIcon item={item} />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono font-semibold text-foreground truncate">{item.label}</div>
                      {item.context && (
                        <div className="text-[10px] text-muted-foreground truncate">{item.context}</div>
                      )}
                    </div>
                    <Badge variant="secondary" className="shrink-0 text-[9px] uppercase tracking-wider font-normal">
                      {KIND_LABELS[item.kind]}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        )}



      </Command>
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