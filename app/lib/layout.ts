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

// Tipos de organización automática disponibles en la barra lateral,
// inspirados en las opciones de dbdiagram.io
export type LayoutType = 'LR' | 'snowflake' | 'compact';

// Calcula el tamaño estimado de un nodo (tabla o procedimiento) reutilizando
// la misma lógica que ya usaba el layout jerárquico (dagre), para que las 3
// organizaciones midan los nodos exactamente igual y no se solapen entre sí.
function getNodeSize(node: Node): { width: number; height: number } {
  const colCount = node.data?.columns?.length ?? 1;
  const idxCount = visibleIndexCount(node);
  const trgCount = visibleTriggerCount(node);
  return { width: NODE_WIDTH, height: getNodeHeight(colCount, idxCount, trgCount) };
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

/* ============================================================
 * SNOWFLAKE (copo de nieve)
 * Coloca la tabla más conectada en el centro y distribuye el resto
 * en anillos concéntricos según su distancia (BFS) respecto a ella.
 * Ideal para diagramas tipo data warehouse con muchas relaciones.
 * ============================================================ */
export function getSnowflakeLayout(nodes: Node[], edges: Edge[]) {
  if (nodes.length === 0) return { nodes: [], edges };

  // Grado (cantidad de conexiones) y adyacencia no dirigida por nodo
  const degree: Record<string, number> = {};
  const adjacency: Record<string, Set<string>> = {};
  nodes.forEach((n) => {
    degree[n.id] = 0;
    adjacency[n.id] = new Set();
  });
  edges.forEach((e) => {
    if (!(e.source in adjacency) || !(e.target in adjacency)) return;
    degree[e.source] = (degree[e.source] ?? 0) + 1;
    degree[e.target] = (degree[e.target] ?? 0) + 1;
    adjacency[e.source].add(e.target);
    adjacency[e.target].add(e.source);
  });

  // La tabla con más conexiones se convierte en el centro del copo de nieve
  const centerId = [...nodes].sort((a, b) => (degree[b.id] ?? 0) - (degree[a.id] ?? 0))[0].id;

  // BFS para calcular la distancia (anillo) de cada tabla respecto al centro
  const distance: Record<string, number> = { [centerId]: 0 };
  const queue: string[] = [centerId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const currentDist = distance[current];
    adjacency[current]?.forEach((neighbor) => {
      if (!(neighbor in distance)) {
        distance[neighbor] = currentDist + 1;
        queue.push(neighbor);
      }
    });
  }

  // Las tablas sin camino hacia el centro (componentes desconectados) se
  // agrupan en un anillo adicional, más externo que el resto
  const maxReachedDistance = Math.max(0, ...Object.values(distance));
  nodes.forEach((n) => {
    if (!(n.id in distance)) distance[n.id] = maxReachedDistance + 1;
  });

  const ringGroups: Record<number, Node[]> = {};
  nodes.forEach((n) => {
    const d = distance[n.id];
    (ringGroups[d] ||= []).push(n);
  });
  // Dentro de cada anillo, las tablas más conectadas se reparten primero
  Object.values(ringGroups).forEach((group) =>
    group.sort((a, b) => (degree[b.id] ?? 0) - (degree[a.id] ?? 0))
  );

  const sizes: Record<string, { width: number; height: number }> = {};
  nodes.forEach((n) => (sizes[n.id] = getNodeSize(n)));

  const RING_SPACING = 420; // Separación radial mínima entre anillos
  const BASE_RADIUS = 60;
  const positions: Record<string, { x: number; y: number }> = {};

  Object.keys(ringGroups)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((ring) => {
      const group = ringGroups[ring];

      if (ring === 0) {
        group.forEach((n) => (positions[n.id] = { x: 0, y: 0 }));
        return;
      }

      // El radio crece según el anillo, pero también según cuánto "perímetro"
      // se necesita para que las tablas de ese anillo no se encimen entre sí
      const maxSpan = Math.max(...group.map((n) => Math.max(sizes[n.id].width, sizes[n.id].height))) + 90;
      const circumferenceNeeded = group.length * maxSpan;
      const radiusForSpacing = circumferenceNeeded / (2 * Math.PI);
      const radius = Math.max(BASE_RADIUS + ring * RING_SPACING, radiusForSpacing);

      const angleStep = (2 * Math.PI) / group.length;
      // Se alterna el ángulo inicial por anillo para que las tablas no queden
      // perfectamente alineadas de forma radial (evita cruces visuales)
      const angleOffset = ring % 2 === 0 ? 0 : angleStep / 2;

      group.forEach((n, idx) => {
        const angle = idx * angleStep + angleOffset - Math.PI / 2;
        positions[n.id] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      });
    });

  const layoutedNodes = nodes.map((n) => {
    const { width, height } = sizes[n.id];
    const pos = positions[n.id];
    return {
      ...n,
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
      position: { x: pos.x - width / 2, y: pos.y - height / 2 },
    };
  });

  return { nodes: layoutedNodes, edges };
}

/* ============================================================
 * COMPACT (compacto)
 * Ordena las tablas mediante BFS (para que las relacionadas queden
 * contiguas) y las acomoda en una cuadrícula rectangular lo más
 * cuadrada posible. Ideal para esquemas con pocas tablas/relaciones.
 * ============================================================ */
export function getCompactLayout(nodes: Node[], edges: Edge[]) {
  if (nodes.length === 0) return { nodes: [], edges };

  const sizes: Record<string, { width: number; height: number }> = {};
  nodes.forEach((n) => (sizes[n.id] = getNodeSize(n)));

  const adjacency: Record<string, Set<string>> = {};
  nodes.forEach((n) => (adjacency[n.id] = new Set()));
  edges.forEach((e) => {
    if (!(e.source in adjacency) || !(e.target in adjacency)) return;
    adjacency[e.source].add(e.target);
    adjacency[e.target].add(e.source);
  });

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const ordered: Node[] = [];

  // Recorre todos los componentes conexos con BFS para que las tablas
  // relacionadas entre sí terminen juntas dentro de la cuadrícula
  nodes.forEach((startNode) => {
    if (visited.has(startNode.id)) return;
    const queue = [startNode.id];
    visited.add(startNode.id);
    while (queue.length > 0) {
      const currentId = queue.shift() as string;
      const currentNode = nodesById.get(currentId);
      if (currentNode) ordered.push(currentNode);
      const neighbors = Array.from(adjacency[currentId] ?? []).sort();
      neighbors.forEach((neighborId) => {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      });
    }
  });

  // Cuadrícula lo más cuadrada posible (mismo número aprox. de filas y columnas)
  const columnCount = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const GAP_X = 90;
  const GAP_Y = 90;
  const columnWidth = NODE_WIDTH + GAP_X;

  const rows: Node[][] = [];
  for (let i = 0; i < ordered.length; i += columnCount) {
    rows.push(ordered.slice(i, i + columnCount));
  }
  const rowHeights = rows.map(
    (row) => Math.max(...row.map((n) => sizes[n.id].height)) + GAP_Y
  );

  const layoutedNodes: Node[] = [];
  let currentY = 0;
  rows.forEach((row, rowIdx) => {
    row.forEach((n, colIdx) => {
      layoutedNodes.push({
        ...n,
        targetPosition: Position.Top,
        sourcePosition: Position.Bottom,
        position: { x: colIdx * columnWidth, y: currentY },
      });
    });
    currentY += rowHeights[rowIdx];
  });

  return { nodes: layoutedNodes, edges };
}

/* ============================================================
 * Dispatcher: elige el algoritmo de organización automática según
 * la opción seleccionada por el usuario en la barra lateral.
 * ============================================================ */
export function getLayoutByType(nodes: Node[], edges: Edge[], layoutType: LayoutType) {
  switch (layoutType) {
    case 'snowflake':
      return getSnowflakeLayout(nodes, edges);
    case 'compact':
      return getCompactLayout(nodes, edges);
    case 'LR':
    default:
      return getLayoutedElements(nodes, edges, 'LR');
  }
}