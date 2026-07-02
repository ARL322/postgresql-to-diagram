import dagre from 'dagre';
import { Node, Edge, Position } from 'reactflow';
//
const NODE_WIDTH = 320;         // Sincronizado exactamente con el componente TableNode
const COL_HEIGHT = 37;          // Incrementado milimétricamente para dar holgura a las filas
const HEADER_HEIGHT = 50;       // Altura real del header textificado de la tabla
const INDEX_ROW_HEIGHT = 44;    // Espacio asignado por cada tarjeta de índice en el footer
const INDEX_HEADER_HEIGHT = 32; // Separación del título de la sección de índices

function visibleIndexCount(node: Node): number {
  const indexes = node.data.indexes as { columns: string[] }[] | undefined;
  if (!indexes || indexes.length === 0) return 0;
  return indexes.length;
}

function visibleTriggerCount(node: Node): number {
  const triggers = node.data.triggers as unknown[] | undefined;
  if (!triggers || triggers.length === 0) return 0;
  return triggers.length;
}

export function getNodeHeight(columnCount: number, indexCount = 0, triggerCount = 0): number {
  const indexSection = indexCount > 0 ? INDEX_HEADER_HEIGHT + indexCount * INDEX_ROW_HEIGHT : 0;
  const triggerSection = triggerCount > 0 ? INDEX_HEADER_HEIGHT + triggerCount * INDEX_ROW_HEIGHT : 0;
  return HEADER_HEIGHT + columnCount * COL_HEIGHT + indexSection + triggerSection + 16;
}

export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'LR' | 'TB' = 'LR'
) {
  const isHorizontal = direction === 'LR';
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  
  // Modificamos ranksep y nodesep para ensanchar el pasillo por donde cruzan las conexiones (Edges)
  dagreGraph.setGraph({ 
    rankdir: direction, 
    ranksep: 220, // Más separación horizontal para evitar colisiones en las líneas cruzadas
    nodesep: 110  // Más separación vertical para dar holgura a conexiones complejas
  });

  nodes.forEach((node) => {
    const colCount = node.data.columns?.length ?? 1;
    const idxCount = visibleIndexCount(node);
    const trgCount = visibleTriggerCount(node);
    dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: getNodeHeight(colCount, idxCount, trgCount) });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const pos = dagreGraph.node(node.id);
    const colCount = node.data.columns?.length ?? 1;
    const idxCount = visibleIndexCount(node);
    const trgCount = visibleTriggerCount(node);
    return {
      ...node,
      targetPosition: isHorizontal ? Position.Left : Position.Top,
      sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - getNodeHeight(colCount, idxCount, trgCount) / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}