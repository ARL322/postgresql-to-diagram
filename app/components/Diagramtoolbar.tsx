"use client";
import { useState, useRef, useEffect } from 'react';
import { Node } from 'reactflow';
import { SchemaSearchField } from './SchemaSearch';
import { ModeToggle } from '@/components/ModeToggle';
import { LayoutType } from '../lib/layout';

type EdgeTypeOption = 'default' | 'smoothstep' | 'step' | 'straight';

const EDGE_TYPE_OPTIONS: { value: EdgeTypeOption; label: string; icon: string }[] = [
  { value: 'default', label: 'Curva (Bezier)', icon: '〰️' },
  { value: 'smoothstep', label: 'Suave (SmoothStep)', icon: '⌐' },
  { value: 'step', label: 'Escalera (Step)', icon: '📶' },
  { value: 'straight', label: 'Recta (Straight)', icon: '📏' },
];

interface LayoutOption {
  value: LayoutType;
  label: string;
  icon: string;
  description: string;
}

interface Props {
  nodes: Node[];
  onFocusNode: (nodeId: string) => void;
  edgeType: EdgeTypeOption;
  onEdgeTypeChange: (v: EdgeTypeOption) => void;
  layoutType: LayoutType;
  onLayoutChange: (v: LayoutType) => void;
  layoutOptions: LayoutOption[];
}

type PanelKey = 'line' | 'layout' | 'help' | null;

/**
 * Barra flotante centrada sobre el lienzo. Agrupa todo lo que sirve para
 * EXPLORAR/VER el diagrama (buscar, tipo de línea, organización, ayuda,
 * tema) para que el sidebar quede enfocado solo en la FUENTE de datos
 * (pegar SQL / vincular archivo).
 */
export default function DiagramToolbar({
  nodes,
  onFocusNode,
  edgeType,
  onEdgeTypeChange,
  layoutType,
  onLayoutChange,
  layoutOptions,
}: Props) {
  const [openPanel, setOpenPanel] = useState<PanelKey>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Cierra cualquier panel abierto (línea/layout/ayuda) al hacer clic afuera
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        setOpenPanel(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const togglePanel = (key: Exclude<PanelKey, null>) => {
    setOpenPanel((current) => (current === key ? null : key));
  };

  return (
    <div ref={containerRef} className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center">
      <div className="flex items-center gap-1 bg-card/95 backdrop-blur border border-border rounded-xl shadow-lg px-2 py-1.5">
        <SchemaSearchField
          nodes={nodes}
          onFocusNode={onFocusNode}
          onOpenChange={(open) => open && setOpenPanel(null)}
        />

        <div className="w-px h-5 bg-border mx-0.5" />

        <ToolbarIconButton
          title="Tipo de línea"
          active={openPanel === 'line'}
          onClick={() => togglePanel('line')}
        >
          🧵
        </ToolbarIconButton>

        <ToolbarIconButton
          title="Organización automática"
          active={openPanel === 'layout'}
          onClick={() => togglePanel('layout')}
        >
          🧭
        </ToolbarIconButton>

        <ToolbarIconButton
          title="Ayuda y atajos"
          active={openPanel === 'help'}
          onClick={() => togglePanel('help')}
        >
          ❔
        </ToolbarIconButton>

        <div className="w-px h-5 bg-border mx-0.5" />

        <ModeToggle />
      </div>

      {openPanel === 'line' && (
        <ToolbarDropdown>
          {EDGE_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onEdgeTypeChange(opt.value); setOpenPanel(null); }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs rounded-lg transition-colors ${
                edgeType === opt.value
                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400 font-semibold'
                  : 'hover:bg-muted/60 text-foreground'
              }`}
            >
              <span className="text-sm w-4 text-center">{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </ToolbarDropdown>
      )}

      {openPanel === 'layout' && (
        <ToolbarDropdown width="w-72">
          {layoutOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onLayoutChange(opt.value); setOpenPanel(null); }}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                layoutType === opt.value ? 'bg-indigo-50 dark:bg-indigo-950/40' : 'hover:bg-muted/60'
              }`}
            >
              <div className={`flex items-center gap-1.5 text-xs font-semibold ${
                layoutType === opt.value ? 'text-indigo-700 dark:text-indigo-400' : 'text-foreground'
              }`}>
                <span>{opt.icon}</span>
                <span>{opt.label}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
                {opt.description}
              </p>
            </button>
          ))}
        </ToolbarDropdown>
      )}

      {openPanel === 'help' && (
        <ToolbarDropdown width="w-80">
          <div className="flex flex-col gap-2.5 px-2 py-1.5 text-[11px] text-muted-foreground leading-normal max-h-[300px] overflow-y-auto">
            <p>
              <strong className="text-foreground">Seleccionar:</strong> clic sobre una tabla o procedimiento
              resalta sus relaciones directas. Clic en el fondo restaura la vista completa.
            </p>
            <p>
              <strong className="text-foreground">Copiar texto:</strong> mantén{' '}
              <kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono text-foreground">Ctrl</kbd> /{' '}
              <kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono text-foreground">Cmd</kbd>{' '}
              para que el cursor cambie a selección de texto.
            </p>
            <p>
              <strong className="text-foreground">Redirigir una línea:</strong> doble clic sobre ella crea un
              punto de control arrastrable; doble clic sobre el punto lo quita.
            </p>
            <p>
              <strong className="text-foreground">Zoom:</strong> mantén{' '}
              <kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono text-foreground">Ctrl</kbd> y
              usa la rueda. Sin <kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono text-foreground">Ctrl</kbd>,
              la rueda desplaza el lienzo.
            </p>
            <p>
              <strong className="text-foreground">Buscar:</strong> usa el buscador o{' '}
              <kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono text-foreground">Ctrl K</kbd>{' '}
              para ubicar cualquier tabla, columna, función o procedimiento.
            </p>
          </div>
        </ToolbarDropdown>
      )}
    </div>
  );
}

function ToolbarIconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`h-8 w-8 flex items-center justify-center rounded-lg text-sm transition-colors ${
        active ? 'bg-indigo-100 dark:bg-indigo-950/50' : 'hover:bg-muted/60'
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarDropdown({ children, width = 'w-56' }: { children: React.ReactNode; width?: string }) {
  return (
    <div className={`mt-1.5 ${width} bg-card border border-border rounded-xl shadow-2xl p-1.5 max-w-[90vw]`}>
      {children}
    </div>
  );
}