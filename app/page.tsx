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

-- 3. RELACIÓN MUCHOS A MUCHOS (N:M)
-- Un post puede tener muchas etiquetas y una etiqueta puede estar en muchos posts
CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  color VARCHAR(7) DEFAULT '#000000'
);

-- Tabla intermedia (junction table)
CREATE TABLE post_tags (
  post_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  -- Composite Primary Key
  PRIMARY KEY (post_id, tag_id),
  -- Foreign Keys con restricciones
  FOREIGN KEY (post_id) REFERENCES posts(id)
  ON DELETE CASCADE
  ON UPDATE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id)
  ON DELETE CASCADE
  ON UPDATE CASCADE
);

-- 4. RELACIÓN UNO A UNO (1:1)
-- Cada usuario tiene un único perfil
CREATE TABLE user_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL,  -- UNIQUE es clave aquí
  bio TEXT,
  avatar_url VARCHAR(500),
  birth_date DATE,
  -- Relación 1:1 con users
  FOREIGN KEY (user_id) REFERENCES users(id)
  ON DELETE CASCADE
  ON UPDATE CASCADE
);

-- 5. RELACIÓN UNO A MUCHOS con RESTRICT
-- Un departamento tiene muchos empleados
-- RESTRICT impide eliminar el departamento si tiene empleados
CREATE TABLE departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  budget DECIMAL(12, 2)
);

CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  department_id INTEGER NOT NULL,
  hire_date DATE DEFAULT CURRENT_DATE,
  salary DECIMAL(10, 2),
  -- ON DELETE RESTRICT (o NO ACTION):
  -- No se puede eliminar el departamento si tiene empleados
  FOREIGN KEY (department_id) REFERENCES departments(id)
  ON DELETE RESTRICT
  ON UPDATE CASCADE
);

-- 6. RELACIÓN AUTORREFERENCIADA (Self-referencing)
-- Un empleado puede tener un supervisor que también es empleado
CREATE TABLE employees_hierarchy (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  position VARCHAR(100),
  supervisor_id INTEGER,
  -- Foreign Key que referencia a la misma tabla
  FOREIGN KEY (supervisor_id) REFERENCES employees_hierarchy(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE
);

-- 7. RELACIÓN CON MÚLTIPLES FOREIGN KEYS
-- Una orden tiene múltiples direcciones (envío y facturación)
CREATE TABLE addresses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  street VARCHAR(200) NOT NULL,
  city VARCHAR(100) NOT NULL,
  country VARCHAR(100) NOT NULL,
  postal_code VARCHAR(20),
  FOREIGN KEY (user_id) REFERENCES users(id)
  ON DELETE CASCADE
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  order_date TIMESTAMPTZ DEFAULT NOW(),
  shipping_address_id INTEGER NOT NULL,
  billing_address_id INTEGER NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  total_amount DECIMAL(10, 2),
  FOREIGN KEY (user_id) REFERENCES users(id)
  ON DELETE CASCADE,
  FOREIGN KEY (shipping_address_id) REFERENCES addresses(id)
  ON DELETE RESTRICT,
  FOREIGN KEY (billing_address_id) REFERENCES addresses(id)
  ON DELETE RESTRICT
);

-- 8. RELACIÓN CON CLAVE FORÁNEA COMPUESTA
-- Un estudiante puede estar inscrito en muchos cursos
CREATE TABLE students (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL
);

CREATE TABLE courses (
  id SERIAL PRIMARY KEY,
  course_code VARCHAR(20) UNIQUE NOT NULL,
  course_name VARCHAR(200) NOT NULL,
  credits INTEGER NOT NULL
);

CREATE TABLE enrollments (
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  enrollment_date DATE DEFAULT CURRENT_DATE,
  grade DECIMAL(4, 2),
  PRIMARY KEY (student_id, course_id),
  FOREIGN KEY (student_id) REFERENCES students(id)
  ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id)
  ON DELETE CASCADE
);

-- 9. RELACIÓN CON ACCIONES DIFERENTES EN DELETE Y UPDATE
CREATE TABLE publishers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  founded_year INTEGER
);

CREATE TABLE books (
  id SERIAL PRIMARY KEY,
  title VARCHAR(300) NOT NULL,
  isbn VARCHAR(13) UNIQUE,
  publisher_id INTEGER NOT NULL,
  published_date DATE,
  -- UPDATE CASCADE mantiene la integridad
  -- DELETE SET DEFAULT asigna un publisher por defecto
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
  ON DELETE SET DEFAULT
  ON UPDATE CASCADE
);

-- ============================================
-- EJEMPLOS DE INSERCIÓN DE DATOS
-- ============================================
-- Insertar usuarios
INSERT INTO users (username, email) VALUES
('john_doe', 'john@example.com'),
('jane_smith', 'jane@example.com');

-- Insertar posts (relación 1:N)
INSERT INTO posts (title, content, author_id) VALUES
('Mi primer post', 'Contenido del post...', 1),
('Aprendiendo SQL', 'SQL es genial...', 1),
('Post de Jane', 'Otro contenido...', 2);

-- Insertar tags (relación N:M)
INSERT INTO tags (name, color) VALUES
('sql', '#3498db'),
('database', '#2ecc71'),
('tutorial', '#e74c3c');

-- Insertar post_tags (relación N:M)
INSERT INTO post_tags (post_id, tag_id) VALUES
(1, 1),  -- Post 1 tiene tag sql
(1, 3),  -- Post 1 tiene tag tutorial
(2, 1),  -- Post 2 tiene tag sql
(2, 2);  -- Post 2 tiene tag database

-- Insertar user_profiles (relación 1:1)
INSERT INTO user_profiles (user_id, bio, avatar_url) VALUES
(1, 'Desarrollador backend', 'https://example.com/avatar1.jpg');

-- ============================================
-- CONSULTAS EJEMPLO CON JOINS
-- ============================================
-- Obtener todos los posts con su autor
SELECT
  p.id,
  p.title,
  p.content,
  u.username as author,
  u.email
FROM posts p
INNER JOIN users u ON p.author_id = u.id;

-- Obtener posts con sus tags (relación N:M)
SELECT
  p.title as post_title,
  t.name as tag_name,
  t.color
FROM posts p
INNER JOIN post_tags pt ON p.id = pt.post_id
INNER JOIN tags t ON pt.tag_id = t.id
ORDER BY p.title, t.name;

-- Obtener usuario con su perfil (relación 1:1)
SELECT
  u.username,
  u.email,
  up.bio,
  up.avatar_url
FROM users u
LEFT JOIN user_profiles up ON u.id = up.user_id;

-- Contar posts por usuario
SELECT
  u.username,
  COUNT(p.id) as total_posts
FROM users u
LEFT JOIN posts p ON u.id = p.author_id
GROUP BY u.id, u.username
ORDER BY total_posts DESC;

-- ============================================
-- OPCIONES DE FOREIGN KEY
-- ============================================
/*
ON DELETE:
  CASCADE: Elimina las filas hijas cuando se elimina la padre
  SET NULL: Establece la FK como NULL cuando se elimina la padre
  SET DEFAULT: Establece la FK al valor por defecto
  RESTRICT: Rechaza la eliminación si hay filas hijas (verifica inmediatamente)
  NO ACTION: Rechaza la eliminación si hay filas hijas (verifica al final)

ON UPDATE:
  CASCADE: Actualiza las FK cuando cambia la PK padre
  SET NULL: Establece la FK como NULL cuando se actualiza la PK
  SET DEFAULT: Establece la FK al valor por defecto
  RESTRICT: Rechaza la actualización si hay filas hijas
  NO ACTION: Rechaza la actualización si hay filas hijas
*/`;

export default function Home() {
  const [isDark, setIsDark] = useState(false);
  const [sqlInput, setSqlInput] = useState(DEFAULT_SQL);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ tables: number; relations: number; indexes: number } | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [isTextSelectionMode, setIsTextSelectionMode] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Efecto para aplicar la clase 'dark' al elemento html
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

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
            comment: table.comment,
            isDark,
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

  // Actualizar el modo dark en todos los nodos cuando cambia isDark
  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => ({
        ...node,
        data: {
          ...node.data,
          isDark,
        },
      }))
    );
  }, [isDark, setNodes]);

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
      data: {
        ...node.data,
        isDark,
      },
    };
  });

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const displayEdges = edges.map((edge) => {
    const floatingEdge = withFloatingHandles(edge, nodesById);
    if (!selectedTableId) return floatingEdge;

    const belongsToSelection = edge.source === selectedTableId || edge.target === selectedTableId;

    return {
      ...floatingEdge,
      animated: belongsToSelection, // Solo animar las aristas que pertenecen a la selección
      data: {
        ...floatingEdge.data,
        isFocused: belongsToSelection,
        styleType: 'bezier',
        isDimmed: !belongsToSelection,
      }
    };
  });

  return (
    <main className={`h-screen w-screen flex overflow-hidden antialiased font-sans ${isDark ? 'bg-zinc-950 text-zinc-100' : 'bg-slate-100 text-slate-900'}`}>
      {/* Panel lateral izquierdo con animación */}
      <aside
        className={`flex-shrink-0 flex flex-col gap-3.5 p-5 border-r ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-slate-200 bg-white'} shadow-xl z-10 transition-all duration-300 ease-in-out ${
          isSidebarOpen ? 'w-[390px] opacity-100' : 'w-0 opacity-0 overflow-hidden border-r-0'
        }`}
      >
        <div className={`flex items-center justify-between pb-1 border-b ${isDark ? 'border-zinc-800' : 'border-slate-100'}`}>
          <h1 className={`text-lg font-bold tracking-tight ${isDark ? 'text-zinc-100' : 'text-slate-900'} flex items-center gap-2`}>
            <span className="text-2xl">📊</span>
            <span>Schema <span className="text-indigo-600">Visualizer</span></span>
          </h1>
          <button
            onClick={() => setIsDark(!isDark)}
            className={`p-2 rounded-lg border transition-all hover:scale-105 active:scale-95 ${
              isDark 
                ? 'bg-zinc-800 border-zinc-700 text-yellow-400 hover:bg-zinc-700' 
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
            title={isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
          >
            {isDark ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
        </div>
        <div className={`${isDark ? 'border-zinc-800' : 'border-slate-100'}`}>
          <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-slate-400'}`}>
            Ingresa tu código estructurado DDL de PostgreSQL
          </p>
        </div>

        <textarea
          className={`flex-1 p-3.5 border rounded-xl font-mono text-[11px] leading-relaxed focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-none ${
            isDark 
              ? 'border-zinc-700 bg-zinc-800 text-zinc-100 placeholder-zinc-600' 
              : 'border-slate-200 bg-slate-50/50 text-slate-800 placeholder-slate-300'
          }`}
          value={sqlInput}
          onChange={(e) => setSqlInput(e.target.value)}
          placeholder="-- Pega tus sentencias CREATE TABLE e INDEX aquí..."
          spellCheck={false}
        />

        {error && (
          <div className={`p-3 border text-xs rounded-lg font-medium animate-pulse ${
            isDark 
              ? 'bg-rose-950/50 border-rose-900 text-rose-400' 
              : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}>
            ⚠️ {error}
          </div>
        )}

        {stats && !error && (
          <div className={`grid grid-cols-3 gap-2 text-center text-[11px] border rounded-xl p-2.5 ${
            isDark ? 'border-zinc-800 bg-zinc-800/50' : 'border-slate-100 bg-slate-50/50'
          }`}>
            <div className={`p-2.5 border rounded-lg shadow-sm ${
              isDark ? 'bg-zinc-800 border-zinc-700' : 'bg-white border-slate-100'
            }`}>
              <span className={`block text-base font-extrabold ${isDark ? 'text-zinc-100' : 'text-slate-950'}`}>{stats.tables}</span> tablas
            </div>
            <div className={`p-2.5 border rounded-lg shadow-sm ${
              isDark ? 'bg-zinc-800 border-zinc-700' : 'bg-white border-slate-100'
            }`}>
              <span className="block text-base font-extrabold text-indigo-600">{stats.relations}</span> relaciones
            </div>
            <div className={`p-2.5 border rounded-lg shadow-sm ${
              isDark ? 'bg-zinc-800 border-zinc-700' : 'bg-white border-slate-100'
            }`}>
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

        <div className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-slate-400'} flex flex-col gap-2 border-t ${isDark ? 'border-zinc-800' : 'border-slate-100'} pt-3.5`}>
          <span className={`font-semibold ${isDark ? 'text-zinc-400' : 'text-slate-500'} uppercase tracking-wider text-[9px]`}>💡 Tips de Navegación</span>
          <p className={`${isDark ? 'text-zinc-400' : 'text-slate-500'} leading-normal`}>
            Haz <strong>clic sobre una tabla</strong> para resaltar sus relaciones. Las líneas mantendrán su estilo curvo original. Haz clic en el fondo para restaurar el esquema completo.
          </p>
          <p className={`${isDark ? 'text-zinc-400' : 'text-slate-500'} leading-normal`}>
            <strong>Para copiar texto:</strong> Mantén presionada la tecla <kbd className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${isDark ? 'bg-zinc-700 text-zinc-200' : 'bg-slate-200 text-slate-700'}`}>Ctrl</kbd> (o <kbd className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${isDark ? 'bg-zinc-700 text-zinc-200' : 'bg-slate-200 text-slate-700'}`}>⌘ Cmd</kbd> en Mac) y el cursor cambiará a texto. Ahora puedes seleccionar y copiar normalmente.
          </p>
          <p className={`${isDark ? 'text-zinc-400' : 'text-slate-500'} leading-normal`}>
            <strong>🎯 Animación:</strong> Los círculos animados viajan a lo largo de las líneas mostrando la dirección de las relaciones Foreign Key, desde la tabla que tiene la FK hacia la tabla referenciada.
          </p>
        </div>
      </aside>

      {/* Botón toggle elegante para mostrar/ocultar el panel */}
      <button
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
        className={`absolute top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-8 h-16 border shadow-lg hover:shadow-xl transition-all duration-300 group ${
          isDark 
            ? 'bg-zinc-900 border-zinc-700 hover:bg-zinc-800 hover:border-zinc-600' 
            : 'bg-white border-slate-200 hover:bg-indigo-50 hover:border-indigo-300'
        } ${
          isSidebarOpen ? 'left-[390px] -translate-x-1/2 rounded-r-xl border-l-0' : 'left-0 rounded-r-xl'
        }`}
        title={isSidebarOpen ? 'Ocultar panel lateral' : 'Mostrar panel lateral'}
      >
        <svg
          className={`w-4 h-4 ${isDark ? 'text-zinc-500 group-hover:text-indigo-400' : 'text-slate-500 group-hover:text-indigo-600'} transition-all duration-300 ${
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
            className={isDark ? 'bg-zinc-950' : 'bg-slate-50'}
            proOptions={{ hideAttribution: true }}
            panOnDrag={!isTextSelectionMode}
            nodesDraggable={!isTextSelectionMode}
            nodesConnectable={!isTextSelectionMode}
            selectionMode={isTextSelectionMode ? SelectionMode.Full : SelectionMode.Partial}
          >
            <Background color={isDark ? '#3f3f46' : '#94a3b8'} gap={20} size={1} style={{ opacity: 0.3 }} />
            <Controls className={isDark ? '!bg-zinc-900 !shadow-xl !border-zinc-700 !rounded-xl !p-1 !text-zinc-100' : '!bg-white !shadow-xl !border-slate-100 !rounded-xl !p-1'} />
            <MiniMap
              className={isDark ? '!bg-zinc-900 !shadow-xl !border-zinc-700 !rounded-xl !overflow-hidden' : '!bg-white !shadow-xl !border-slate-100 !rounded-xl !overflow-hidden'}
              nodeColor={isDark ? '#3f3f46' : '#e0e7ff'}
              nodeStrokeColor={isDark ? '#71717a' : '#a5b4fc'}
              maskColor={isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(15, 23, 42, 0.03)'}
              zoomable
              pannable
            />
          </ReactFlow>
        ) : (
          <div className={`flex flex-col items-center justify-center h-full gap-3 text-slate-400 select-none ${isDark ? 'bg-zinc-950 text-zinc-400' : 'bg-slate-50'}`}>
            <span className="text-6xl">📐</span>
            <p className={`text-base font-semibold ${isDark ? 'text-zinc-200' : 'text-slate-800'}`}>El espacio de trabajo está vacío</p>
          </div>
        )}
      </div>
    </main>
  );
}