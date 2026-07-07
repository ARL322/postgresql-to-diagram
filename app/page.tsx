"use client";
import { useState, useCallback, useEffect } from 'react';
import ReactFlow, {
  Node, Edge, Background, Controls, MiniMap,
  useNodesState, useEdgesState, useReactFlow, ReactFlowProvider, SelectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import './styles/custom-flow.css';
import TableNode from './components/TableNode';
import ProcedureNode from './components/ProcedureNode';
import CustomEdge from './components/CustomEdge';
import { parsePostgresSQL, sanitizeId, buildHandleId } from './lib/sqlParser';
import type { Table, Procedure } from './lib/types';
import { getLayoutByType, LayoutType } from './lib/layout';
import FileBrowserModal from './components/FileBrowserModal';
import DiagramToolbar from './components/Diagramtoolbar';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';





const nodeTypes = { tableNode: TableNode, procedureNode: ProcedureNode };
const edgeTypes = { customEdge: CustomEdge };

// Opciones de organización automática (estilo dbdiagram.io) mostradas en la barra lateral
const LAYOUT_OPTIONS: { value: LayoutType; label: string; icon: string; description: string }[] = [
  {
    value: 'LR',
    label: 'Left-right',
    icon: '➡️',
    description:
      'Organiza las tablas de izquierda a derecha según la dirección de su relación. Ideal para diagramas con largas relaciones, como los flujos de trabajo ETL.',
  },
  {
    value: 'snowflake',
    label: 'Snowflake',
    icon: '❄️',
    description:
      'Organiza las tablas en forma de copo de nieve, con las tablas más conectadas en el centro. Ideal para diagramas con muchas conexiones, como los almacenes de datos.',
  },
  {
    value: 'compact',
    label: 'Compact',
    icon: '▦',
    description:
      'Organiza las tablas en un diseño rectangular compacto. Ideal para diagramas con pocas relaciones y tablas.',
  },
];

// Ancho de respaldo si React Flow aún no midió el nodo (antes del primer render)
const FALLBACK_NODE_WIDTH = 320;

// Para las líneas ortogonales (Step / Smoothstep): varias relaciones entre
// PARES de tablas distintos pueden terminar compartiendo el mismo "tramo
// vertical" (el codo de la línea), porque por defecto ese codo se calcula
// en el punto medio entre origen y destino, y muchas relaciones caen en un
// punto medio muy similar. STEP_LANE_BUCKET agrupa las líneas cuyo punto
// medio cae en una franja cercana, y STEP_LANE_SPACING separa cada línea
// del grupo en su propio "carril" para que no se dibujen unas sobre otras.
const STEP_LANE_BUCKET = 100;
const STEP_LANE_SPACING = 40;

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

  // Caso normal: la tabla origen está a la izquierda de la tabla destino
  if (sourceCenterX <= targetCenterX) {
    return { sourceSide: 'R', targetSide: 'L' };
  }

  // La tabla origen quedó a la derecha de la tabla destino
  return { sourceSide: 'L', targetSide: 'R' };
}

/**
 * Devuelve el edge con sourceHandle/targetHandle recalculados para el frame
 * actual, a partir de los handles "base" (sin sufijo) guardados en edge.data.
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
 * Determina las etiquetas de cardinalidad de una relación
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
    return { source: label, target: label };
  }

  return {
    source: '*',
    target: isNullable ? '0..1' : '1'
  };
}

const DEFAULT_SQL = `-- TABLAS RELACIONADAS (1:N)
CREATE TABLE clientes (
    id_cliente SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    correo VARCHAR(150) UNIQUE NOT NULL,
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pedidos (
    id_pedido SERIAL PRIMARY KEY,
    id_cliente INTEGER NOT NULL,
    descripcion VARCHAR(200) NOT NULL,
    total NUMERIC(10,2) NOT NULL,
    fecha_pedido TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_pedidos_clientes
        FOREIGN KEY (id_cliente)
        REFERENCES clientes(id_cliente)
        ON DELETE CASCADE
);

-- ==========================================================
-- ÍNDICES
-- ==========================================================

CREATE INDEX idx_clientes_correo
ON clientes(correo);

CREATE INDEX idx_pedidos_cliente
ON pedidos(id_cliente);

-- ==========================================================
-- TRIGGER SOBRE LA TABLA clientes
-- Actualiza automáticamente la fecha_actualizacion
-- ==========================================================

CREATE OR REPLACE FUNCTION fn_actualizar_fecha_cliente()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.fecha_actualizacion := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clientes_actualizacion
BEFORE UPDATE
ON clientes
FOR EACH ROW
EXECUTE FUNCTION fn_actualizar_fecha_cliente();

-- ==========================================================
-- FUNCIÓN
-- Modifica datos de una de las tablas (clientes)
-- ==========================================================

CREATE OR REPLACE FUNCTION fn_actualizar_correo_cliente(
    p_id_cliente INTEGER,
    p_nuevo_correo VARCHAR(150)
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_existe INTEGER;
    v_fecha_actual TIMESTAMP;
BEGIN

    -- Obtener la fecha actual
    v_fecha_actual := CURRENT_TIMESTAMP;

    -- Verificar si el cliente existe
    SELECT COUNT(*)
    INTO v_existe
    FROM clientes
    WHERE id_cliente = p_id_cliente;

    IF v_existe = 0 THEN
        RAISE EXCEPTION 'El cliente con ID % no existe', p_id_cliente;
    END IF;

    -- Actualizar el correo
    UPDATE clientes
    SET correo = p_nuevo_correo
    WHERE id_cliente = p_id_cliente;

END;
$$;
-- ==========================================================
-- PROCEDIMIENTO ALMACENADO
-- Actualiza y elimina registros de una tabla
-- ==========================================================

CREATE OR REPLACE PROCEDURE sp_gestionar_pedido(
    IN p_id_pedido INTEGER,
    IN p_nuevo_total NUMERIC(10,2),
    IN p_eliminar BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_existe_pedido INTEGER;
    v_fecha_operacion TIMESTAMP;
    v_total_anterior NUMERIC(10,2);
    v_mensaje VARCHAR(100);
BEGIN

    -- Guardar fecha actual
    v_fecha_operacion := CURRENT_TIMESTAMP;

    -- Verificar si el pedido existe
    SELECT COUNT(*)
    INTO v_existe_pedido
    FROM pedidos
    WHERE id_pedido = p_id_pedido;

    IF v_existe_pedido = 0 THEN
        RAISE EXCEPTION 'El pedido % no existe', p_id_pedido;
    END IF;

    -- Obtener el total actual
    SELECT total
    INTO v_total_anterior
    FROM pedidos
    WHERE id_pedido = p_id_pedido;

    IF p_eliminar THEN

        DELETE
        FROM pedidos
        WHERE id_pedido = p_id_pedido;

        v_mensaje := 'Pedido eliminado';

    ELSE

        UPDATE pedidos
        SET total = p_nuevo_total
        WHERE id_pedido = p_id_pedido;

        v_mensaje := 'Pedido actualizado';

    END IF;

    RAISE NOTICE '% - Fecha: %', v_mensaje, v_fecha_operacion;

END;
$$;


`;

function SchemaVisualizer() {
  const [sqlInput, setSqlInput] = useState(DEFAULT_SQL);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { screenToFlowPosition, fitView, setCenter, getNode } = useReactFlow();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ tables: number; relations: number; indexes: number; procedures: number } | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  // Id del nodo que el buscador acaba de localizar; se usa para dispararle
  // un resaltado (pulso) temporal, además del zoom/centrado a su posición.
  const [searchHighlightId, setSearchHighlightId] = useState<string | null>(null);
  const [isTextSelectionMode, setIsTextSelectionMode] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [edgeType, setEdgeType] = useState<'default' | 'smoothstep' | 'step' | 'straight'>('default');
  const [layoutType, setLayoutType] = useState<LayoutType>('LR');
  // Se incrementa cada vez que se aplica manualmente un nuevo layout, para
  // disparar un fitView confiable una vez que React Flow ya midió los nodos
  const [layoutVersion, setLayoutVersion] = useState(0);
  // Pestaña de esquema activa: 'ALL' muestra todas las tablas mezcladas (comportamiento
  // original); cualquier otro valor filtra el canvas para mostrar solo las tablas/
  // procedimientos que pertenecen a ese schema (ej. 'productos', 'public', etc.)
  const [activeSchemaTab, setActiveSchemaTab] = useState<string>('ALL');

  const handleGenerate = useCallback(() => {
    setError(null);
    setSelectedTableId(null);
    setActiveSchemaTab('ALL');

    try {
      const { tables, relationships, procedures } = parsePostgresSQL(sqlInput);

      const flowNodes: Node[] = [
        // Nodos de tablas
        ...tables.map((table) => {
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
              triggers: table.triggers,
              comment: table.comment,
            },
            position: { x: 0, y: 0 },
          };
        }),
        // Nodos de procedimientos almacenados y funciones
        ...procedures.map((proc) => {
          const nodeId = sanitizeId(`proc_${proc.name}`);
          return {
            id: nodeId,
            type: 'procedureNode',
            data: {
              label: proc.name,
              nodeId,
              schema: proc.schema,
              parameters: proc.parameters,
              variables: proc.variables,
              returnType: proc.returnType,
              language: proc.language,
              affectedTables: proc.affectedTables,
              comment: proc.comment,
            },
            position: { x: 0, y: 0 },
          };
        }),
      ];

      const edgeCountMap: Record<string, number> = {};
      const targetHandleCounts: Record<string, number> = {};
      const sourceHandleCounts: Record<string, number> = {};

      relationships.forEach((rel) => {
        const sHandle = buildHandleId(sanitizeId(rel.sourceTable), rel.sourceColumn, 'source');
        const tHandle = buildHandleId(sanitizeId(rel.targetTable), rel.targetColumn, 'target');

        targetHandleCounts[tHandle] = (targetHandleCounts[tHandle] || 0) + 1;
        sourceHandleCounts[sHandle] = (sourceHandleCounts[sHandle] || 0) + 1;
      });

      const currentTargetCounts: Record<string, number> = {};
      const currentSourceCounts: Record<string, number> = {};

      // Conteo de handles compartidos para las líneas Procedimiento → Tabla.
      // Todas las operaciones (INSERT/UPDATE/DELETE/SELECT) de un mismo
      // procedimiento que afectan a la MISMA tabla llegan al mismo punto fijo
      // (_proc_target) del nodo destino. Sin un desplazamiento por línea, las
      // curvas que salen de alturas distintas pero convergen en el mismo
      // punto terminan cruzándose entre sí. Aquí contamos cuántas líneas
      // comparten ese punto de llegada para poder abrirlas en abanico.
      const procTargetHandleCounts: Record<string, number> = {};
      procedures.forEach((proc) => {
        proc.affectedTables.forEach((op) => {
          const tHandle = buildHandleId(sanitizeId(op.tableName), '_proc_target', 'target');
          procTargetHandleCounts[tHandle] = (procTargetHandleCounts[tHandle] || 0) + 1;
        });
      });
      const currentProcTargetCounts: Record<string, number> = {};

      const flowEdges: Edge[] = [
        // Relaciones entre tablas (Foreign Keys)
        ...relationships.map((rel, i) => {
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

          const isTargetCrowded = targetHandleCounts[tHandle] > 1;
          let targetBadgeOffsetY = 0;

          if (isTargetCrowded) {
            const currentTIdx = (currentTargetCounts[tHandle] || 0);
            targetBadgeOffsetY = (currentTIdx % 2 === 0 ? 1 : -1) * Math.ceil((currentTIdx + 1) / 2) * 22;
            currentTargetCounts[tHandle] = currentTIdx + 1;
          }

          const isSourceCrowded = sourceHandleCounts[sHandle] > 1;
          let sourceBadgeOffsetY = 0;

          if (isSourceCrowded) {
            const currentSIdx = (currentSourceCounts[sHandle] || 0);
            sourceBadgeOffsetY = (currentSIdx % 2 === 0 ? 1 : -1) * Math.ceil((currentSIdx + 1) / 2) * 22;
            currentSourceCounts[sHandle] = currentSIdx + 1;
          }

          const actionSuffix = [
            rel.onDelete && `ON DELETE ${rel.onDelete}`,
            rel.onUpdate && `ON UPDATE ${rel.onUpdate}`,
          ]
            .filter(Boolean)
            .join(' · ');

          const cleanLabel = actionSuffix
            ? `${rel.sourceColumn} → ${rel.targetColumn}  (${actionSuffix})`
            : `${rel.sourceColumn} → ${rel.targetColumn}`;

          const cardinalityLabels = getCardinalityLabels(tables, rel.sourceTable, rel.sourceColumn);

          return {
            id: `e-fk-${i}-${sourceNodeId}-${rel.sourceColumn}-${targetNodeId}-${rel.targetColumn}`,
            source: sourceNodeId,
            target: targetNodeId,
            sourceHandle: `${sHandle}__R`,
            targetHandle: `${tHandle}__L`,
            type: 'customEdge',
            animated: true,
            style: { stroke: '#4f46e5' },
            label: cleanLabel,
            data: {
              sourceTable: sourceNodeId,
              targetTable: targetNodeId,
              offset: calculatedOffset,
              baseSourceHandle: sHandle,
              baseTargetHandle: tHandle,
              cardinalityLabels,
              sourceBadgeOffsetY,
              targetBadgeOffsetY,
              relationType: 'FK',
            }
          };
        }),
        // Relaciones desde procedimientos hacia tablas afectadas
        ...procedures.flatMap((proc) => {
          const procNodeId = sanitizeId(`proc_${proc.name}`);
          const procEdges: Edge[] = [];

          proc.affectedTables.forEach((op) => {
            const targetNodeId = sanitizeId(op.tableName);
            const handleId = buildHandleId(procNodeId, `${op.tableName}-${op.operationType}`, 'source');

            const operationColors: Record<string, string> = {
              INSERT: '#16a34a',
              UPDATE: '#2563eb',
              DELETE: '#dc2626',
              SELECT: '#9333ea',
            };

            const targetHandleId = buildHandleId(targetNodeId, '_proc_target', 'target');

            // Si varias operaciones del procedimiento apuntan a esta misma
            // tabla, todas comparten el mismo punto de llegada. Repartimos
            // cada línea alrededor del centro (…, -2, -1, 0, 1, 2, …) según
            // el orden en que aparecen (que coincide con el orden vertical
            // en que se dibujan las filas dentro del nodo del procedimiento),
            // para que las curvas se abran en abanico y queden paralelas en
            // vez de cruzarse, tal como en dbdiagram.io.
            const crowdCount = procTargetHandleCounts[targetHandleId] || 1;
            const crowdIdx = currentProcTargetCounts[targetHandleId] || 0;
            currentProcTargetCounts[targetHandleId] = crowdIdx + 1;

            const fanStep = crowdIdx - (crowdCount - 1) / 2;
            const targetBadgeOffsetY = crowdCount > 1 ? fanStep * 26 : 0;
            const procEdgeOffset = crowdCount > 1 ? fanStep * 20 : 0;

            procEdges.push({
              id: `e-proc-${proc.name}-${op.tableName}-${op.operationType}`,
              source: procNodeId,
              target: targetNodeId,
              sourceHandle: `${handleId}__R`,
              targetHandle: `${targetHandleId}__L`,
              type: 'customEdge',
              animated: true,
              style: { stroke: operationColors[op.operationType] || '#6b7280' },
              label: `${op.operationType}`,
              data: {
                sourceTable: procNodeId,
                targetTable: targetNodeId,
                offset: procEdgeOffset,
                baseSourceHandle: handleId,
                baseTargetHandle: targetHandleId,
                //cardinalityLabels: { source: '1', target: '*' },
                cardinalityLabels: { source: '', target: '' },
                sourceBadgeOffsetY: 0,
                targetBadgeOffsetY,
                relationType: 'PROCEDURE',
                operationType: op.operationType,
              }
            });
          });

          return procEdges;
        }),
      ];

      const { nodes: ln, edges: le } = getLayoutByType(flowNodes, flowEdges, layoutType);

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
      const procedureCount = procedures.length;
      
      // SOLUCIÓN AL ERROR: Eliminada la propiedad redundante 'relationships'
      setStats({ 
        tables: tables.length, 
        relations: relationships.length, 
        indexes: indexCount,
        procedures: procedureCount 
      });
      // También centra la vista al (re)generar el diagrama desde el SQL
      setLayoutVersion((v) => v + 1);
    } catch (err: any) {
      setError(err.message ?? 'Error inesperado al procesar el código SQL.');
      setNodes([]);
      setEdges([]);
      setStats(null);
    }
  }, [sqlInput, setNodes, setEdges, layoutType]);

  // Reorganiza el diagrama YA generado con un nuevo algoritmo de layout,
  // sin necesidad de volver a parsear el SQL (mantiene tablas/relaciones actuales)
  const handleLayoutChange = useCallback((newLayout: LayoutType) => {
    setLayoutType(newLayout);
    setNodes((currentNodes) => {
      if (currentNodes.length === 0) return currentNodes;
      const { nodes: relaidNodes } = getLayoutByType(currentNodes, edges, newLayout);
      return relaidNodes;
    });
    // Dispara el efecto de abajo, que espera a que React Flow ya haya
    // confirmado y medido las nuevas posiciones antes de centrar la vista
    setLayoutVersion((v) => v + 1);
  }, [edges, setNodes]);

  // Centra automáticamente el diagrama cada vez que se cambia de opción de
  // organización automática (Left-right / Snowflake / Compact). Se usa un
  // pequeño retraso porque React Flow necesita re-medir los nodos después
  // de que React confirme las nuevas posiciones; un rAF inmediato a veces
  // corre demasiado pronto y el encuadre queda desalineado.
  useEffect(() => {
    if (layoutVersion === 0) return; // valor por defecto antes de la primera generación/reorganización
    const timeoutId = window.setTimeout(() => {
      fitView({ padding: 0.2, duration: 400 });
    }, 60);
    return () => window.clearTimeout(timeoutId);
  }, [layoutVersion, fitView]);

  useEffect(() => {
    handleGenerate();
  }, [handleGenerate]);

  // Lista de esquemas presentes en el diagrama actual (derivada de los nodos ya
  // generados). Las tablas/procedimientos sin schema explícito se agrupan bajo
  // "public", que es el esquema por defecto en PostgreSQL.
  const schemaTabs = nodes.length
    ? Array.from(
        new Set(nodes.map((n) => (n.data?.schema as string | undefined) || 'public'))
      ).sort((a, b) => a.localeCompare(b))
    : [];

  // Si el schema seleccionado deja de existir (por ejemplo, se regeneró el SQL
  // y ya no contiene ese schema), regresa automáticamente a la vista "Todos".
  useEffect(() => {
    if (activeSchemaTab !== 'ALL' && !schemaTabs.includes(activeSchemaTab)) {
      setActiveSchemaTab('ALL');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaTabs.join('|')]);

  // Al cambiar de pestaña de esquema, reencuadra la vista para centrar
  // solo las tablas visibles en ese momento.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      fitView({ padding: 0.2, duration: 300 });
    }, 60);
    return () => window.clearTimeout(timeoutId);
  }, [activeSchemaTab, fitView]);

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

// Llamado desde el buscador (SchemaSearch) al elegir una tabla, columna,
// función o procedimiento: centra la vista sobre el nodo correspondiente,
// lo selecciona (para resaltar sus relaciones) y además dispara un pulso
// visual breve para que sea fácil ubicarlo entre muchas tablas.
const handleFocusNode = useCallback((nodeId: string) => {
  const node = getNode(nodeId);
  if (!node) return;

  const width = node.width ?? FALLBACK_NODE_WIDTH;
  const height = node.height ?? 200;
  const centerX = node.position.x + width / 2;
  const centerY = node.position.y + height / 2;

  setCenter(centerX, centerY, { zoom: 1, duration: 600 });
  setSelectedTableId(node.id);
  setSearchHighlightId(node.id);
}, [getNode, setCenter]);

// Quita el pulso visual pasado un momento, para que no quede permanente
useEffect(() => {
  if (!searchHighlightId) return;
  const timeoutId = window.setTimeout(() => setSearchHighlightId(null), 1800);
  return () => window.clearTimeout(timeoutId);
}, [searchHighlightId]);



  const displayNodes = nodes.map((node) => {
    const isSearchHighlight = node.id === searchHighlightId;

    if (!selectedTableId) {
      return { ...node, className: isSearchHighlight ? 'node-search-highlight' : '' };
    }

    const isCurrent = node.id === selectedTableId;
    const isConnected = edges.some(
      (e) => (e.source === selectedTableId && e.target === node.id) ||
             (e.target === selectedTableId && e.source === node.id)
    );

    const classes = [
      isCurrent || isConnected ? '' : 'node-dimmed',
      isSearchHighlight ? 'node-search-highlight' : '',
    ].filter(Boolean).join(' ');

    return { ...node, className: classes };
  });

  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  // Sólo aplica a los tipos de línea ortogonales (Step / Smoothstep), que son
  // los que sufren de tramos superpuestos cuando varias relaciones distintas
  // comparten un mismo "corredor" vertical entre las tablas.
  const stepLaneOffsetByEdgeId: Record<string, number> = {};
  if (edgeType === 'step' || edgeType === 'smoothstep') {
    const bucketGroups: Record<number, string[]> = {};

    edges.forEach((edge) => {
      const sourceNode = nodesById.get(edge.source);
      const targetNode = nodesById.get(edge.target);
      if (!sourceNode || !targetNode) return;

      const { sourceSide, targetSide } = getDynamicHandleSides(sourceNode, targetNode);
      const sourceWidth = sourceNode.width ?? FALLBACK_NODE_WIDTH;
      const targetWidth = targetNode.width ?? FALLBACK_NODE_WIDTH;

      // Aproximación del punto X real de cada extremo, según de qué lado
      // (izquierdo/derecho) sale o entra la línea al nodo.
      const approxSourceX = sourceNode.position.x + (sourceSide === 'R' ? sourceWidth : 0);
      const approxTargetX = targetNode.position.x + (targetSide === 'R' ? targetWidth : 0);
      const midpointX = (approxSourceX + approxTargetX) / 2;

      const bucketKey = Math.round(midpointX / STEP_LANE_BUCKET);
      (bucketGroups[bucketKey] ||= []).push(edge.id);
    });

    Object.values(bucketGroups).forEach((edgeIds) => {
      const count = edgeIds.length;
      if (count <= 1) return;
      edgeIds.forEach((edgeId, idx) => {
        stepLaneOffsetByEdgeId[edgeId] = (idx - (count - 1) / 2) * STEP_LANE_SPACING;
      });
    });
  }

const displayEdges = edges.map((edge) => {
  const floatingEdge = withFloatingHandles(edge, nodesById);
  
  const belongsToSelection = selectedTableId 
    ? (edge.source === selectedTableId || edge.target === selectedTableId) 
    : false;

  return {
    ...floatingEdge,
    animated: belongsToSelection || edge.animated, // ← Mantiene animación original
    data: {
      ...floatingEdge.data,
      isFocused: belongsToSelection,
      isDimmed: selectedTableId ? !belongsToSelection : false,
      edgeType: edgeType,           // ← Respeta el tipo de línea seleccionado
      stepCenterOffset: stepLaneOffsetByEdgeId[edge.id] ?? 0,
    }
  };
});

// Filtrado por pestaña de esquema: si hay una pestaña específica activa,
// solo se muestran las tablas/procedimientos de ese schema, y solo las
// relaciones cuyos dos extremos sigan visibles (evita líneas "colgando"
// hacia tablas de otro esquema que quedaron ocultas).
const schemaFilteredNodes = activeSchemaTab === 'ALL'
  ? displayNodes
  : displayNodes.filter((n) => ((n.data?.schema as string | undefined) || 'public') === activeSchemaTab);

const visibleNodeIdSet = new Set(schemaFilteredNodes.map((n) => n.id));

const schemaFilteredEdges = activeSchemaTab === 'ALL'
  ? displayEdges
  : displayEdges.filter((e) => visibleNodeIdSet.has(e.source) && visibleNodeIdSet.has(e.target));


const [filePath, setFilePath] = useState('');
const [isWatching, setIsWatching] = useState(false);
const [isBrowserOpen, setIsBrowserOpen] = useState(false);
// Controla qué pestaña de la fuente de datos está activa en el sidebar
const [sourceMode, setSourceMode] = useState<'paste' | 'file'>('paste');

// Recupera la última ruta usada al cargar la página (F5, recarga, etc.)
useEffect(() => {
  const savedPath = localStorage.getItem('sqlFilePath');
  if (savedPath) setFilePath(savedPath);
}, []);

// Guarda la ruta cada vez que cambia, para recordarla la próxima vez
useEffect(() => {
  if (filePath) {
    localStorage.setItem('sqlFilePath', filePath);
  } else {
    localStorage.removeItem('sqlFilePath');
  }
}, [filePath]);

useEffect(() => {
  if (!isWatching || !filePath) return;

  const es = new EventSource(`/api/watch-sql?path=${encodeURIComponent(filePath)}`);
  es.onmessage = (e) => {
    const { content } = JSON.parse(e.data);
    setSqlInput(content);
  };
  es.onerror = () => {
    es.close();
    setIsWatching(false);   // ← refleja el estado real en el botón
  };

  return () => es.close();
}, [isWatching, filePath]);

  return (
    <main className="h-screen w-screen flex bg-background overflow-hidden text-foreground antialiased font-sans">
      <aside
        className={`flex-shrink-0 flex flex-col gap-3.5 p-5 border-r border-border bg-card shadow-xl z-10 transition-all duration-300 ease-in-out ${
          isSidebarOpen ? 'w-[390px] opacity-100' : 'w-0 opacity-0 overflow-hidden border-r-0'
        }`}
      >
        <div className="pb-1 border-b border-border">
          <h1 className="text-lg font-bold tracking-tight text-foreground flex items-center gap-2">
            <span className="text-2xl">📊</span>
            <span>Schema <span className="text-indigo-600 dark:text-indigo-400">Visualizer</span></span>
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Ingresa tu código estructurado DDL de PostgreSQL
          </p>
        </div>

        {/* Pestañas de fuente de datos: pegar SQL directamente o vincular un
            archivo local. Antes ambos flujos se mostraban siempre juntos;
            ahora solo se ve el que estás usando. */}
        <div className="flex border border-border rounded-lg overflow-hidden text-xs shrink-0">
          <button
            type="button"
            onClick={() => setSourceMode('paste')}
            className={`flex-1 py-1.5 font-medium transition-colors ${
              sourceMode === 'paste'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            📝 Pegar SQL
          </button>
          <button
            type="button"
            onClick={() => setSourceMode('file')}
            className={`flex-1 py-1.5 font-medium transition-colors border-l border-border ${
              sourceMode === 'file'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            📂 Archivo
          </button>
        </div>

        {sourceMode === 'file' && (
          <div className="flex gap-2 shrink-0">
            <Input
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="Local File"
              className="flex-1 h-8 text-xs"
              disabled={isWatching}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setIsBrowserOpen(true)}
              disabled={isWatching}
              className="h-8 w-8 shrink-0"
              title="Buscar archivo"
            >
              📂
            </Button>
            <Button
              type="button"
              variant={isWatching ? 'secondary' : 'outline'}
              onClick={() => setIsWatching(!isWatching)}
              className={`h-8 shrink-0 text-xs ${isWatching ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-400' : ''}`}
            >
              {isWatching ? '🟢 Sincronizado' : '🔗 Vincular'}
            </Button>
          </div>
        )}

        <FileBrowserModal
          isOpen={isBrowserOpen}
          onClose={() => setIsBrowserOpen(false)}
          onSelect={(path) => setFilePath(path)}
        />

        <Textarea
          className="flex-1 p-3.5 rounded-xl font-mono text-[11px] leading-relaxed resize-none bg-muted/50 placeholder:text-muted-foreground/60 transition-colors"
          value={sqlInput}
          onChange={(e) => setSqlInput(e.target.value)}
          placeholder="-- Pega tus sentencias CREATE TABLE, FUNCTION o PROCEDURE aquí..."
          spellCheck={false}
        />

        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg font-medium animate-pulse dark:bg-rose-950/40 dark:border-rose-900 dark:text-rose-400">
            ⚠️ {error}
          </div>
        )}

        {stats && !error && (
          <div className="grid grid-cols-4 gap-1 text-center text-[10px] border border-border rounded-xl p-2 bg-muted/50">
            <div className="p-2 bg-card border border-border rounded-lg shadow-sm">
              <span className="block text-base font-extrabold text-foreground">{stats.tables}</span> tablas
            </div>
            <div className="p-2 bg-card border border-border rounded-lg shadow-sm">
              <span className="block text-base font-extrabold text-indigo-600 dark:text-indigo-400">{stats.relations}</span> rels
            </div>
            <div className="p-2 bg-card border border-border rounded-lg shadow-sm">
              <span className="block text-base font-extrabold text-amber-600 dark:text-amber-400">{stats.indexes}</span> índices
            </div>
            <div className="p-2 bg-card border border-border rounded-lg shadow-sm">
              <span className="block text-base font-extrabold text-emerald-600 dark:text-emerald-400">{stats.procedures}</span> procs/fns
            </div>
          </div>
        )}

<Button
  onClick={handleGenerate}
  className="w-full py-6 rounded-xl font-semibold text-sm transition-all font-sans"
>
  Generar Diagrama de Entidades
</Button>
      </aside>

      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
        className={`absolute top-1/2 -translate-y-1/2 z-20 h-16 w-8 rounded-l-none shadow-lg hover:shadow-xl hover:bg-indigo-50 hover:border-indigo-300 dark:hover:bg-indigo-950/40 dark:hover:border-indigo-800 transition-all duration-300 group ${
          isSidebarOpen ? 'left-[390px] -translate-x-1/2 border-l-0' : 'left-0'
        }`}
      >
        <svg
          className={`w-4 h-4 text-muted-foreground group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-all duration-300 ${isSidebarOpen ? 'rotate-180' : 'rotate-0'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </Button>

      <div
        className={`flex-1 h-full relative transition-all duration-300 ${isTextSelectionMode ? 'text-select-mode' : ''}`}
        onContextMenu={(e) => e.preventDefault()}
      >
        {nodes.length > 0 && (
          <DiagramToolbar
            nodes={nodes}
            onFocusNode={handleFocusNode}
            edgeType={edgeType}
            onEdgeTypeChange={setEdgeType}
            layoutType={layoutType}
            onLayoutChange={handleLayoutChange}
            layoutOptions={LAYOUT_OPTIONS}
          />
        )}

        {/* Pestañas de esquema: "Todos" muestra el diagrama completo sin
            separar; cada pestaña adicional (una por schema detectado en el
            SQL, ej. "productos") filtra el canvas a solo esas tablas. */}
        {schemaTabs.length > 1 && (
          <div className="absolute top-3 left-3 z-30 flex flex-wrap gap-1 max-w-[60%] p-1 rounded-xl bg-card/95 border border-border shadow-lg backdrop-blur-sm">
            <button
              type="button"
              onClick={() => setActiveSchemaTab('ALL')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                activeSchemaTab === 'ALL'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
              title="Ver todas las tablas de todos los esquemas juntas"
            >
              🗂️ Todos
            </button>
            {schemaTabs.map((schema) => (
              <button
                key={schema}
                type="button"
                onClick={() => setActiveSchemaTab(schema)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  activeSchemaTab === schema
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
                title={`Ver solo el esquema "${schema}"`}
              >
                {schema}
              </button>
            ))}
          </div>
        )}

        {nodes.length > 0 ? (
          <ReactFlow
  nodes={schemaFilteredNodes}
  edges={schemaFilteredEdges}
  onNodesChange={onNodesChange}
  onEdgesChange={onEdgesChange}
  nodeTypes={nodeTypes}
  edgeTypes={edgeTypes}
  onNodeClick={onNodeClick}
  onPaneClick={onPaneClick}

  fitView
  fitViewOptions={{ padding: 0.2 }}
  className="bg-muted/30 dark:bg-background"
  proOptions={{ hideAttribution: true }}
  panOnDrag={isTextSelectionMode ? false : [1]}
  panOnScroll
  zoomOnScroll={false}
  zoomOnDoubleClick={false}
  zoomActivationKeyCode="Control"
  nodesDraggable={!isTextSelectionMode}
  nodesConnectable={!isTextSelectionMode}
  selectionMode={isTextSelectionMode ? SelectionMode.Full : SelectionMode.Partial}
>
            <Background color={isDark ? '#475569' : '#94a3b8'} gap={20} size={1} style={{ opacity: 0.3 }} />
            <Controls className="!bg-card !shadow-xl !border-border !rounded-xl !p-1 [&_button]:!bg-card [&_button]:!border-border [&_button]:!text-foreground [&_button:hover]:!bg-muted" />
            <MiniMap
              className="!bg-card !shadow-xl !border-border !rounded-xl !overflow-hidden"
              nodeColor={(n) => n.type === 'procedureNode' ? (isDark ? '#064e3b' : '#ecfdf5') : (isDark ? '#312e81' : '#e0e7ff')}
              nodeStrokeColor={(n) => n.type === 'procedureNode' ? '#059669' : '#a5b4fc'}
              maskColor={isDark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(15, 23, 42, 0.03)'}
              zoomable
              pannable
            />
          </ReactFlow>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground select-none bg-muted/30 dark:bg-background">
            <span className="text-6xl">📐</span>
            <p className="text-base font-semibold text-foreground">El espacio de trabajo está vacío</p>
          </div>
        )}
      </div>
    </main>
  );
}

export default function Home() {
  return (
    <ReactFlowProvider>
      <SchemaVisualizer />
    </ReactFlowProvider>
  );
}