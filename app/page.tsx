"use client";
import { useState, useCallback, useEffect } from 'react';
import ReactFlow, {
  Node, Edge, Background, Controls, MiniMap,
  useNodesState, useEdgesState, SelectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './styles/custom-flow.css';
import TableNode from './components/TableNode';
import CustomEdge from './components/CustomEdge';
import { parsePostgresSQL, sanitizeId, buildHandleId } from './lib/sqlParser';
import type { Table } from './lib/types';
import { getLayoutedElements } from './lib/layout';

const nodeTypes = { tableNode: TableNode };
const edgeTypes = { customEdge: CustomEdge };

// Ancho de respaldo si React Flow aún no midió el nodo (antes del primer render)
const FALLBACK_NODE_WIDTH = 320;

/**
 * Simple Floating Edges (adaptado a handles por columna):
 * en lugar de recalcular geométricamente el punto de intersección sobre el
 * borde del nodo (como en el ejemplo clásico de node-a-node), aquí cada
 * columna ya tiene un handle "target" y un handle "source" en AMBOS lados
 * (ver TableNode.tsx, sufijos __L / __R). Esta función sólo decide, según
 * la posición X real de los dos nodos, qué lado debe quedar activo en cada
 * extremo del edge para que la línea nunca tenga que "rodear" la tabla.
 */
function getDynamicHandleSides(
  sourceNode: Node,
  targetNode: Node
): { sourceSide: 'L' | 'R'; targetSide: 'L' | 'R' } {
  const sourceWidth = sourceNode.width ?? FALLBACK_NODE_WIDTH;
  const targetWidth = targetNode.width ?? FALLBACK_NODE_WIDTH;
  const sourceCenterX = sourceNode.position.x + sourceWidth / 2;
  const targetCenterX = targetNode.position.x + targetWidth / 2;

  // Caso normal (como hasta ahora): la tabla origen está a la izquierda
  // de la tabla destino -> sale por su derecha, entra por la izquierda del destino.
  if (sourceCenterX <= targetCenterX) {
    return { sourceSide: 'R', targetSide: 'L' };
  }

  // La tabla origen quedó a la derecha de la tabla destino (p. ej. el usuario
  // la arrastró al otro lado) -> invertimos: sale por su izquierda, entra
  // por la derecha del destino.
  return { sourceSide: 'L', targetSide: 'R' };
}

/**
 * Devuelve el edge con sourceHandle/targetHandle recalculados para el frame
 * actual, a partir de los handles "base" (sin sufijo) guardados en edge.data.
 * Si todavía no encontramos ambos nodos (no debería pasar) devolvemos el
 * edge tal cual, sin tocar sus handles.
 */
function withFloatingHandles(edge: Edge, nodesById: Map<string, Node>): Edge {
  const baseSourceHandle = edge.data?.baseSourceHandle;
  const baseTargetHandle = edge.data?.baseTargetHandle;
  if (!baseSourceHandle || !baseTargetHandle) return edge;

  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  if (!sourceNode || !targetNode) return edge;

  const { sourceSide, targetSide } = getDynamicHandleSides(sourceNode, targetNode);
  return {
    ...edge,
    sourceHandle: `${baseSourceHandle}__${sourceSide}`,
    targetHandle: `${baseTargetHandle}__${targetSide}`,
  };
}

/**
 * Determina las etiquetas de cardinalidad de una relación, igual que
 * dbdiagram.io: se basan únicamente en la columna que tiene la FK
 * (rel.sourceColumn) y su definición real en el esquema parseado.
 *
 * Si esa columna es PK o tiene UNIQUE -> relación 1:1
 *   lado FK   : "1" (obligatoria) o "0..1" (si la columna es NULLABLE)
 *   lado ref. : igual, "1" o "0..1"
 *
 * Si no -> relación normal 1:N
 *   lado FK   : "*" (muchas filas pueden compartir la misma referencia)
 *   lado ref. : "1" (obligatoria) o "0..1" (si la FK es NULLABLE, la
 *               referencia es opcional)
 */
function getCardinalityLabels(
  tables: Table[],
  sourceTable: string,
  sourceColumn: string
): { source: string; target: string } {
  const table = tables.find((t) => t.name.toLowerCase() === sourceTable.toLowerCase());
  const col = table?.columns.find((c) => c.name.toLowerCase() === sourceColumn.toLowerCase());
  const isUniqueOnThisSide = col?.isUniqueColumn === true || col?.isUnique === true;
  const isNullable = col?.isNullable !== false;

  if (isUniqueOnThisSide) {
    const label = isNullable ? '0..1' : '1';
    return { source: label, target: label }; // 1:1 o 0..1:0..1
  }

  // Relación normal 1:N
  return {
    source: '*',
    target: isNullable ? '0..1' : '1'
  };
}

const DEFAULT_SQL = `-- ============================================
-- EJEMPLOS DE RELACIONES EN POSTGRESQL
-- ============================================
-- 1. RELACIÓN UNO A MUCHOS (1:N) - La más común
-- Un usuario puede tener muchos posts, pero cada post pertenece a un solo usuario
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT,
  author_id INTEGER NOT NULL,
  published_at TIMESTAMPTZ,
  -- Foreign Key con ON DELETE CASCADE
  -- Si se elimina el usuario, se eliminan todos sus posts
  FOREIGN KEY (author_id) REFERENCES users(id)
  ON DELETE CASCADE
  ON UPDATE CASCADE
);

-- 2. RELACIÓN UNO A MUCHOS con SET NULL
-- Una categoría puede tener muchos productos
-- Si se elimina la categoría, los productos quedan sin categoría
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  category_id INTEGER,
  -- ON DELETE SET NULL: Si se elimina la categoría,
  -- el producto permanece pero sin categoría
  FOREIGN KEY (category_id) REFERENCES categories(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE
);

`;

export default function Home() {
  const [sqlInput, setSqlInput] = useState(DEFAULT_SQL);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ tables: number; relations: number; indexes: number } | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [isTextSelectionMode, setIsTextSelectionMode] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [edgeType, setEdgeType] = useState<'default' | 'smoothstep' | 'step' | 'straight'>('default');

  const handleGenerate = useCallback(() => {
    setError(null);
    setSelectedTableId(null);

    try {
      const { tables, relationships } = parsePostgresSQL(sqlInput);

const flowNodes: Node[] = tables.map((table) => {
  const nodeId = sanitizeId(table.name);
  return {
    id: nodeId,
    type: 'tableNode',
    data: {
      label: table.name,
      nodeId,
      schema: table.schema,
      columns: table.columns,
      indexes: table.indexes,
      triggers: table.triggers, // ← faltaba: sin esto TableNode nunca ve los triggers
      comment: table.comment,
    },
    position: { x: 0, y: 0 },
  };
});

      const edgeCountMap: Record<string, number> = {};

      // Mapas para contar cuántas líneas apuntan a un handle específico
      // Esto nos permite saber si necesitamos separar las etiquetas
      const targetHandleCounts: Record<string, number> = {};
      const sourceHandleCounts: Record<string, number> = {};

      // Primera pasada: contar ocurrencias para asignar turnos
      relationships.forEach((rel) => {
        const sHandle = buildHandleId(sanitizeId(rel.sourceTable), rel.sourceColumn, 'source');
        const tHandle = buildHandleId(sanitizeId(rel.targetTable), rel.targetColumn, 'target');

        targetHandleCounts[tHandle] = (targetHandleCounts[tHandle] || 0) + 1;
        sourceHandleCounts[sHandle] = (sourceHandleCounts[sHandle] || 0) + 1;
      });

      // Contadores de estado actual para asignar posiciones (se resetean por handle)
      const currentTargetCounts: Record<string, number> = {};
      const currentSourceCounts: Record<string, number> = {};

      const flowEdges: Edge[] = relationships.map((rel, i) => {
        const sourceNodeId = sanitizeId(rel.sourceTable);
        const targetNodeId = sanitizeId(rel.targetTable);

        const sHandle = buildHandleId(sourceNodeId, rel.sourceColumn, 'source');
        const tHandle = buildHandleId(targetNodeId, rel.targetColumn, 'target');

        const edgeKey = `${sHandle}->${tHandle}`;

        if (edgeCountMap[edgeKey] === undefined) {
          edgeCountMap[edgeKey] = 0;
        } else {
          edgeCountMap[edgeKey]++;
        }

        const currentCount = edgeCountMap[edgeKey];
        const offsetSign = currentCount % 2 === 0 ? 1 : -1;
        const calculatedOffset = Math.ceil(currentCount / 2) * 18 * offsetSign;

        // --- NUEVO: Cálculo de Badge Offset Y (Vertical) ---
        // Si hay más de una línea apuntando al MISMO destino, desplazamos las etiquetas verticalmente
        const isTargetCrowded = targetHandleCounts[tHandle] > 1;
        let targetBadgeOffsetY = 0;

        if (isTargetCrowded) {
          const currentTIdx = (currentTargetCounts[tHandle] || 0);
          // Escalonamiento: 0, -22, +22, -44, +44...
          targetBadgeOffsetY = (currentTIdx % 2 === 0 ? 1 : -1) * Math.ceil((currentTIdx + 1) / 2) * 22;
          currentTargetCounts[tHandle] = currentTIdx + 1;
        }

        // Si hay más de una línea saliendo del MISMO origen, desplazamos las etiquetas
        const isSourceCrowded = sourceHandleCounts[sHandle] > 1;
        let sourceBadgeOffsetY = 0;

        if (isSourceCrowded) {
          const currentSIdx = (currentSourceCounts[sHandle] || 0);
          sourceBadgeOffsetY = (currentSIdx % 2 === 0 ? 1 : -1) * Math.ceil((currentSIdx + 1) / 2) * 22;
          currentSourceCounts[sHandle] = currentSIdx + 1;
        }
        // ---------------------------------------------

        const actionSuffix = [
          rel.onDelete && `ON DELETE ${rel.onDelete}`,
          rel.onUpdate && `ON UPDATE ${rel.onUpdate}`,
        ]
          .filter(Boolean)
          .join(' · ');

        const cleanLabel = actionSuffix
          ? `${rel.sourceColumn} → ${rel.targetColumn}  (${actionSuffix})`
          : `${rel.sourceColumn} → ${rel.targetColumn}`;

        // Cardinalidad estilo dbdiagram.io: "1" / "0..1" / "*" según si la
        // columna FK es PK/UNIQUE y si admite NULL.
        const cardinalityLabels = getCardinalityLabels(tables, rel.sourceTable, rel.sourceColumn);

        return {
          id: `e-${i}-${sourceNodeId}-${rel.sourceColumn}-${targetNodeId}-${rel.targetColumn}`,
          source: sourceNodeId,
          target: targetNodeId,
          // Valores iniciales (comportamiento "normal": origen -> derecha, destino -> izquierda).
          // Se recalculan en cada render vía withFloatingHandles/displayEdges.
          sourceHandle: `${sHandle}__R`,
          targetHandle: `${tHandle}__L`,
          type: 'customEdge',
          animated: true, // Animación de círculo siempre activa
          style: { stroke: '#4f46e5' },
          label: cleanLabel,
          data: {
            sourceTable: sourceNodeId,
            targetTable: targetNodeId,
            offset: calculatedOffset,
            // Handles base (sin sufijo __L/__R), usados para resolver
            // dinámicamente el lado correcto según la posición de las tablas.
            baseSourceHandle: sHandle,
            baseTargetHandle: tHandle,
            // Etiquetas de cardinalidad ("1", "0..1", "*") mostradas como
            // píldoras junto a cada tabla, igual que en dbdiagram.io.
            cardinalityLabels,
            // NUEVO: Offsets verticales para evitar superposición de badges
            sourceBadgeOffsetY,
            targetBadgeOffsetY,
          }
        };
      });

      const { nodes: ln, edges: le } = getLayoutedElements(flowNodes, flowEdges, 'LR');

      const layoutedEdges = le.map((edge) => {
        if (!edge.data?.isFocused) return edge;

        const sourceNode = ln.find(n => n.id === edge.source);
        const targetNode = ln.find(n => n.id === edge.target);

        if (sourceNode && targetNode) {
          const yDiff = targetNode.position.y - sourceNode.position.y;
          const dynamicOffset = yDiff > 0 ? 30 : -30;

          return {
            ...edge,
            data: {
              ...edge.data,
              offset: dynamicOffset,
            }
          };
        }

        return edge;
      });

      setNodes(ln);
      setEdges(layoutedEdges);
      const indexCount = tables.reduce((acc, t) => acc + (t.indexes?.length ?? 0), 0);
      setStats({ tables: tables.length, relations: relationships.length, indexes: indexCount });
    } catch (err: any) {
      setError(err.message ?? 'Error inesperado al procesar el código SQL.');
      setNodes([]);
      setEdges([]);
      setStats(null);
    }
  }, [sqlInput, setNodes, setEdges]);

  useEffect(() => {
    handleGenerate();
  }, [handleGenerate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        setIsTextSelectionMode(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        setIsTextSelectionMode(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedTableId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedTableId(null);
  }, []);

  const displayNodes = nodes.map((node) => {
    if (!selectedTableId) return node;
    const isCurrent = node.id === selectedTableId;
    const isConnected = edges.some(
      (e) => (e.source === selectedTableId && e.target === node.id) ||
             (e.target === selectedTableId && e.source === node.id)
    );

    return {
      ...node,
      className: isCurrent || isConnected ? '' : 'node-dimmed',
    };
  });

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const displayEdges = edges.map((edge) => {
    const floatingEdge = withFloatingHandles(edge, nodesById);
    
    // Si no hay selección, devolvemos la arista flotante con el tipo de línea global
    if (!selectedTableId) {
      return {
        ...floatingEdge,
        data: {
          ...floatingEdge.data,
          edgeType: edgeType, // Asegurar que el tipo de línea se aplique siempre
        }
      };
    }

    // Lógica de selección existente
    const belongsToSelection = edge.source === selectedTableId || edge.target === selectedTableId;

    return {
      ...floatingEdge,
      animated: belongsToSelection,
      data: {
        ...floatingEdge.data,
        isFocused: belongsToSelection,
        styleType: 'bezier',
        isDimmed: !belongsToSelection,
        edgeType: edgeType, // También aplicar aquí cuando hay selección
      }
    };
  });

  return (
    <main className="h-screen w-screen flex bg-slate-100 overflow-hidden text-slate-900 antialiased font-sans">
      {/* Panel lateral izquierdo con animación */}
      <aside
        className={`flex-shrink-0 flex flex-col gap-3.5 p-5 border-r border-slate-200 bg-white shadow-xl z-10 transition-all duration-300 ease-in-out ${
          isSidebarOpen ? 'w-[390px] opacity-100' : 'w-0 opacity-0 overflow-hidden border-r-0'
        }`}
      >
        <div className="pb-1 border-b border-slate-100">
          <h1 className="text-lg font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <span className="text-2xl">📊</span>
            <span>Schema <span className="text-indigo-600">Visualizer</span></span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Ingresa tu código estructurado DDL de PostgreSQL
          </p>
        </div>

        <textarea
          className="flex-1 p-3.5 border border-slate-200 rounded-xl font-mono text-[11px] leading-relaxed focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-none bg-slate-50/50 text-slate-800 placeholder-slate-300 transition-colors"
          value={sqlInput}
          onChange={(e) => setSqlInput(e.target.value)}
          placeholder="-- Pega tus sentencias CREATE TABLE e INDEX aquí..."
          spellCheck={false}
        />

        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg font-medium animate-pulse">
            ⚠️ {error}
          </div>
        )}

        {stats && !error && (
          <div className="grid grid-cols-3 gap-2 text-center text-[11px] border border-slate-100 rounded-xl p-2.5 bg-slate-50/50">
            <div className="p-2.5 bg-white border border-slate-100 rounded-lg shadow-sm">
              <span className="block text-base font-extrabold text-slate-950">{stats.tables}</span> tablas
            </div>
            <div className="p-2.5 bg-white border border-slate-100 rounded-lg shadow-sm">
              <span className="block text-base font-extrabold text-indigo-600">{stats.relations}</span> relaciones
            </div>
            <div className="p-2.5 bg-white border border-slate-100 rounded-lg shadow-sm">
              <span className="block text-base font-extrabold text-amber-600">{stats.indexes}</span> índices
            </div>
          </div>
        )}

        <button
          onClick={handleGenerate}
          className="bg-indigo-600 text-white py-3 rounded-xl font-semibold text-sm hover:bg-indigo-700 active:scale-[0.99] transition-all shadow-md shadow-indigo-200"
        >
          Generar Diagrama de Entidades
        </button>

        {/* Selector de tipo de línea */}
        <div className="flex flex-col gap-1.5 border-t border-slate-100 pt-3">
          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
            Tipo de Línea
          </label>
          <select
            value={edgeType}
            onChange={(e) => setEdgeType(e.target.value as 'default' | 'smoothstep' | 'step' | 'straight')}
            className="w-full px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none cursor-pointer hover:bg-slate-50 transition-colors"
          >
            <option value="default">Curva (Bezier)</option>
            <option value="smoothstep">Suave (SmoothStep)</option>
            <option value="step">Escalera (Step)</option>
            <option value="straight">Recta (Straight)</option>
          </select>
        </div>

        <div className="text-[10px] text-slate-400 flex flex-col gap-2 border-t border-slate-100 pt-3.5">
          <span className="font-semibold text-slate-500 uppercase tracking-wider text-[9px]">💡 Tips de Navegación</span>
          <p className="text-slate-500 leading-normal">
            Haz <strong>clic sobre una tabla</strong> para resaltar sus relaciones. Las líneas mantendrán su estilo curvo original. Haz clic en el fondo para restaurar el esquema completo.
          </p>
          <p className="text-slate-500 leading-normal">
            <strong>Para copiar texto:</strong> Mantén presionada la tecla <kbd className="px-1.5 py-0.5 bg-slate-200 rounded text-[9px] font-mono">Ctrl</kbd> (o <kbd className="px-1.5 py-0.5 bg-slate-200 rounded text-[9px] font-mono">⌘ Cmd</kbd> en Mac) y el cursor cambiará a texto. Ahora puedes seleccionar y copiar normalmente.
          </p>
          <p className="text-slate-500 leading-normal">
            <strong>🎯 Animación:</strong> Los círculos animados viajan a lo largo de las líneas mostrando la dirección de las relaciones Foreign Key, desde la tabla que tiene la FK hacia la tabla referenciada.
          </p>
        </div>
      </aside>

      {/* Botón toggle elegante para mostrar/ocultar el panel */}
      <button
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
        className={`absolute top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-8 h-16 bg-white border border-slate-200 shadow-lg hover:shadow-xl hover:bg-indigo-50 hover:border-indigo-300 transition-all duration-300 group ${
          isSidebarOpen
            ? 'left-[390px] -translate-x-1/2 rounded-r-xl border-l-0'
            : 'left-0 rounded-r-xl'
        }`}
        title={isSidebarOpen ? 'Ocultar panel lateral' : 'Mostrar panel lateral'}
      >
        <svg
          className={`w-4 h-4 text-slate-500 group-hover:text-indigo-600 transition-all duration-300 ${
            isSidebarOpen ? 'rotate-180' : 'rotate-0'
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 19l-7-7 7-7"
          />
        </svg>
      </button>

      {/* Contenedor del canvas */}
      <div className={`flex-1 h-full relative transition-all duration-300 ${isTextSelectionMode ? 'text-select-mode' : ''}`}>
        {nodes.length > 0 ? (
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            className="bg-slate-50"
            proOptions={{ hideAttribution: true }}
            panOnDrag={!isTextSelectionMode}
            nodesDraggable={!isTextSelectionMode}
            nodesConnectable={!isTextSelectionMode}
            selectionMode={isTextSelectionMode ? SelectionMode.Full : SelectionMode.Partial}
          >
            <Background color="#94a3b8" gap={20} size={1} style={{ opacity: 0.3 }} />
            <Controls className="!bg-white !shadow-xl !border-slate-100 !rounded-xl !p-1" />
            <MiniMap
              className="!bg-white !shadow-xl !border-slate-100 !rounded-xl !overflow-hidden"
              nodeColor="#e0e7ff"
              nodeStrokeColor="#a5b4fc"
              maskColor="rgba(15, 23, 42, 0.03)"
              zoomable
              pannable
            />
          </ReactFlow>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400 select-none bg-slate-50">
            <span className="text-6xl">📐</span>
            <p className="text-base font-semibold text-slate-800">El espacio de trabajo está vacío</p>
          </div>
        )}
      </div>
    </main>
  );
}