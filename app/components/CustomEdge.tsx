"use client";
import React, { useState } from 'react';
import { EdgeProps, getBezierPath, getSmoothStepPath, getStraightPath, EdgeLabelRenderer, Position, useReactFlow } from 'reactflow';
import { useTheme } from 'next-themes';

interface Waypoint {
  x: number;
  y: number;
}

/* ==================== FUNCIONES AUXILIARES ==================== */
function buildPointsPath(points: { x: number; y: number }[], radius: number): string {
  if (points.length < 3 || radius <= 0) {
    return 'M ' + points.map((p) => `${p.x},${p.y}`).join(' L ');
  }

  let d = `M ${points[0].x},${points[0].y} `;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const distPrev = Math.hypot(curr.x - prev.x, curr.y - prev.y) || 1;
    const distNext = Math.hypot(next.x - curr.x, next.y - curr.y) || 1;
    const r = Math.min(radius, distPrev / 2, distNext / 2);

    const beforeX = curr.x - ((curr.x - prev.x) / distPrev) * r;
    const beforeY = curr.y - ((curr.y - prev.y) / distPrev) * r;
    const afterX = curr.x + ((next.x - curr.x) / distNext) * r;
    const afterY = curr.y + ((next.y - curr.y) / distNext) * r;

    d += `L ${beforeX},${beforeY} Q ${curr.x},${curr.y} ${afterX},${afterY} `;
  }
  const last = points[points.length - 1];
  d += `L ${last.x},${last.y}`;
  return d;
}

function buildBezierThroughPoint(
  sourceX: number, sourceY: number, sourcePosition: Position,
  waypoint: Waypoint,
  targetX: number, targetY: number, targetPosition: Position,
): string {
  const arriveAtWaypointSide = waypoint.x >= sourceX ? Position.Left : Position.Right;
  const leaveWaypointSide = targetX >= waypoint.x ? Position.Right : Position.Left;

  const [seg1] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX: waypoint.x, targetY: waypoint.y, targetPosition: arriveAtWaypointSide,
  });
  const [seg2] = getBezierPath({
    sourceX: waypoint.x, sourceY: waypoint.y, sourcePosition: leaveWaypointSide,
    targetX, targetY, targetPosition,
  });

  const seg2Continuation = seg2.replace(/^M[^C]*/, '');
  return `${seg1} ${seg2Continuation}`;
}

/**
 * Construye una curva Bezier cúbica que nace y termina EXACTAMENTE en el
 * punto de conexión real (para que la línea siga tocando el handle), pero
 * desplaza verticalmente sus puntos de control cerca de cada extremo.
 *
 * Esto es clave cuando varias relaciones distintas llegan al mismo nodo (o
 * incluso al mismo handle/columna): en lugar de que todas las curvas se
 * superpongan o se crucen entre sí al converger en el mismo punto, cada
 * una se "abre" (fan-out) según el offset que le corresponde, logrando que
 * varias líneas se vean paralelas y distinguibles entre sí.
 */
function buildFannedBezierPath(
  sourceX: number, sourceY: number, sourcePosition: Position,
  targetX: number, targetY: number, targetPosition: Position,
  sourceOffset: number, targetOffset: number,
): [string, number, number] {
  const distX = Math.abs(targetX - sourceX);
  // Fuerza horizontal de la curva, similar al comportamiento por defecto de React Flow
  const curveStrength = Math.max(distX * 0.5, 80);

  const sourceDir = sourcePosition === Position.Left ? -1 : 1;
  const targetDir = targetPosition === Position.Left ? -1 : 1;

  const cp1x = sourceX + sourceDir * curveStrength;
  const cp1y = sourceY + sourceOffset;
  const cp2x = targetX + targetDir * curveStrength;
  const cp2y = targetY + targetOffset;

  const path = `M ${sourceX},${sourceY} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${targetX},${targetY}`;
  const labelX = (cp1x + cp2x) / 2;
  const labelY = (cp1y + cp2y) / 2;
  return [path, labelX, labelY];
}

function getWaypointPoints(
  edgeType: string,
  sourceX: number, sourceY: number,
  waypoint: Waypoint,
  targetX: number, targetY: number,
): { x: number; y: number }[] {
  if (edgeType === 'straight') {
    return [{ x: sourceX, y: sourceY }, waypoint, { x: targetX, y: targetY }];
  }
  return [
    { x: sourceX, y: sourceY },
    { x: waypoint.x, y: sourceY },
    { x: waypoint.x, y: waypoint.y },
    { x: targetX, y: waypoint.y },
    { x: targetX, y: targetY },
  ];
}

/* ==================== COMPONENTE ==================== */
export default function CustomEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  label,
  data,
  animated = false,
}: EdgeProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDraggingPoint, setIsDraggingPoint] = useState(false);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const { screenToFlowPosition, setEdges } = useReactFlow();

  const waypoint: Waypoint | undefined = data?.waypoint;
  const isFocused = data?.isFocused ?? false;
  const isDimmed = data?.isDimmed ?? false;
  const edgeType = data?.edgeType || 'default';
  const edgeOffset = data?.offset ?? 0;
  const cardinalityLabels = data?.cardinalityLabels ?? { source: '*', target: '1' };

  const sourceBadgeOffsetY = data?.sourceBadgeOffsetY ?? 0;
  const targetBadgeOffsetY = data?.targetBadgeOffsetY ?? 0;

  // Cuánto "abrir" la curva cerca de cada extremo cuando varias relaciones
  // comparten el mismo handle (ya calculado en page.tsx como el mismo offset
  // que separa las píldoras de cardinalidad, así ambos quedan alineados)
  const getPath = (
    sx: number, sy: number, sp: Position, tx: number, ty: number, tp: Position,
    sOffset = 0, tOffset = 0,
  ) => {
    const commonProps = { sourceX: sx, sourceY: sy, sourcePosition: sp, targetX: tx, targetY: ty, targetPosition: tp };
    const crowdKick = Math.max(Math.abs(sOffset), Math.abs(tOffset));
    // Desplaza el "codo" (tramo vertical/horizontal intermedio) de las líneas
    // ortogonales para que relaciones entre pares de tablas distintos que
    // comparten el mismo corredor no se dibujen exactamente una encima de
    // la otra (ver stepLaneOffsetByEdgeId en page.tsx).
    //
    // IMPORTANTE: el codo (centerX) sólo es válido si queda ENTRE el origen
    // y el destino. Si el desplazamiento del carril lo empuja más allá de
    // cualquiera de los dos extremos (típico en líneas cortas o muy cerca
    // de un nodo), React Flow no puede trazar una "S" limpia y en su lugar
    // dibuja un rizo/bucle para poder volver al punto de conexión real. Por
    // eso acotamos (clamp) el valor dentro de un margen de seguridad.
    const stepCenterOffset = data?.stepCenterOffset ?? 0;
    const minX = Math.min(sx, tx);
    const maxX = Math.max(sx, tx);
    const CENTER_MARGIN = 40; // distancia mínima del codo a cualquiera de los dos extremos
    let centerX = (sx + tx) / 2 + stepCenterOffset;
    if (maxX - minX > CENTER_MARGIN * 2) {
      centerX = Math.min(Math.max(centerX, minX + CENTER_MARGIN), maxX - CENTER_MARGIN);
    } else {
      // La distancia entre origen y destino es demasiado corta para separar
      // carriles sin generar un bucle: se ignora el desplazamiento y se usa
      // el punto medio real, que es el único valor seguro en ese caso.
      centerX = (sx + tx) / 2;
    }

    // El "offset" (stub) es cuánto avanza la línea en línea recta antes de
    // doblar hacia el codo. Si ese stub es más largo que el espacio real
    // disponible entre el origen/destino y el centerX ya acotado arriba
    // (algo común cuando varias líneas crowded suman un crowdKick grande),
    // React Flow no tiene espacio para trazar el doblez y termina
    // plegando la línea sobre sí misma, generando el mismo efecto de rizo.
    // Por eso el stub también se acota al espacio disponible.
    const baseOffset = 35 + edgeOffset + crowdKick;
    const availableSpace = Math.min(centerX - minX, maxX - centerX);
    const safeOffset = Math.max(12, Math.min(baseOffset, availableSpace - 8));

    switch (edgeType) {
      case 'smoothstep': return getSmoothStepPath({ ...commonProps, borderRadius: 12, offset: safeOffset, centerX });
      case 'step': return getSmoothStepPath({ ...commonProps, borderRadius: 0, offset: safeOffset, centerX });
      case 'straight': return getStraightPath(commonProps);
      // Bezier (curva por defecto): si varias relaciones comparten el mismo
      // handle, se abren en abanico para no cruzarse; si no hay cruce
      // potencial, se usa el cálculo estándar de React Flow sin cambios.
      default:
        return (sOffset !== 0 || tOffset !== 0)
          ? buildFannedBezierPath(sx, sy, sp, tx, ty, tp, sOffset, tOffset)
          : getBezierPath(commonProps);
    }
  };

  let edgePath: string;
  let labelX: number;
  let labelY: number;

  // Además de separar el "codo" intermedio (arriba), cuando varias líneas
  // comparten el mismo handle también conviene separar unos pocos píxeles
  // el punto donde REALMENTE tocan el nodo. Sin esto, dos líneas orto-
  // gonales pueden llegar exactamente al mismo pixel de entrada/salida y
  // sus curvas de redondeo (borderRadius) se solapan justo ahí, dando la
  // apariencia de un pequeño rizo. Sólo aplica a Step/Smoothstep: en Bezier
  // y en modo waypoint el punto de conexión ya se maneja aparte.
  const isOrthogonal = edgeType === 'step' || edgeType === 'smoothstep';
  const TERMINAL_NUDGE_MAX = 3;
  const sourceTerminalNudge = isOrthogonal
    ? Math.max(-TERMINAL_NUDGE_MAX, Math.min(TERMINAL_NUDGE_MAX, sourceBadgeOffsetY * 0.35))
    : 0;
  const targetTerminalNudge = isOrthogonal
    ? Math.max(-TERMINAL_NUDGE_MAX, Math.min(TERMINAL_NUDGE_MAX, targetBadgeOffsetY * 0.35))
    : 0;
  const drawSourceY = sourceY + sourceTerminalNudge;
  const drawTargetY = targetY + targetTerminalNudge;

  if (waypoint) {
    if (edgeType === 'default') {
      edgePath = buildBezierThroughPoint(sourceX, sourceY, sourcePosition, waypoint, targetX, targetY, targetPosition);
    } else {
      const points = getWaypointPoints(edgeType, sourceX, sourceY, waypoint, targetX, targetY);
      const radius = edgeType === 'smoothstep' ? 12 : 0;
      edgePath = buildPointsPath(points, radius);
    }
    labelX = waypoint.x;
    labelY = waypoint.y;
  } else {
    const pathResult = getPath(sourceX, drawSourceY, sourcePosition, targetX, drawTargetY, targetPosition, sourceBadgeOffsetY, targetBadgeOffsetY);
    edgePath = pathResult[0];
    labelX = pathResult[1];
    labelY = pathResult[2];
  }

  const isPathRightToLeft = sourceX > targetX;
  let textPath = edgePath;
  if (waypoint && isPathRightToLeft) {
    if (edgeType === 'default') {
      textPath = buildBezierThroughPoint(targetX, targetY, targetPosition, waypoint, sourceX, sourceY, sourcePosition);
    } else {
      const reversedPoints = getWaypointPoints(edgeType, targetX, targetY, waypoint, sourceX, sourceY);
      const radius = edgeType === 'smoothstep' ? 12 : 0;
      textPath = buildPointsPath(reversedPoints, radius);
    }
  } else if (isPathRightToLeft) {
    const reverseResult = getPath(targetX, drawTargetY, targetPosition, sourceX, drawSourceY, sourcePosition, targetBadgeOffsetY, sourceBadgeOffsetY);
    textPath = reverseResult[0];
  }

  let strokeColor = style.stroke || '#4f46e5';
  let strokeWidth = 2;
  let dotColor = '#4f46e5';

  if (isFocused) {
    strokeColor = '#16a34a';
    dotColor = '#16a34a';
    //strokeWidth = 6;
  } else if (isHovered) {
    strokeColor = '#4338ca';
    dotColor = '#4338ca';
    //strokeWidth = 5;
  }

  const edgeClassName = `react-flow__edge-path ${isDimmed ? 'edge-dimmed' : ''}`;
  const showHorizontalLabel = isFocused;
  const shouldAnimate = animated && !isDimmed;

  const sourceBadgeDir = sourcePosition === Position.Left ? -1 : 1;
  const targetBadgeDir = targetPosition === Position.Left ? -1 : 1;
  const badgeDistance = 22;

  const sourceBadgeX = sourceX + sourceBadgeDir * badgeDistance;
  const targetBadgeX = targetX + targetBadgeDir * badgeDistance;

  // ==================== CLIC PARA CREAR WAYPOINT ====================
  const handleEdgeClick = (e: React.MouseEvent) => {
    if (waypoint) return;

    e.stopPropagation();
    e.preventDefault();

    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

    setEdges((eds) =>
      eds.map((ed) =>
        ed.id === id ? { ...ed, data: { ...ed.data, waypoint: flowPos } } : ed
      )
    );
  };

  const handleWaypointPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsDraggingPoint(true);

    const startPointerFlowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const startWaypoint = waypoint ?? startPointerFlowPos;
    const grabOffsetX = startWaypoint.x - startPointerFlowPos.x;
    const grabOffsetY = startWaypoint.y - startPointerFlowPos.y;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const flowPos = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      const newWaypoint = { x: flowPos.x + grabOffsetX, y: flowPos.y + grabOffsetY };
      setEdges((eds) =>
        eds.map((ed) =>
          ed.id === id ? { ...ed, data: { ...ed.data, waypoint: newWaypoint } } : ed
        )
      );
    };

    const onPointerUp = () => {
      setIsDraggingPoint(false);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const handleWaypointDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEdges((eds) =>
      eds.map((ed) => {
        if (ed.id !== id) return ed;
        const { waypoint: _discard, ...restData } = ed.data ?? {};
        return { ...ed, data: restData };
      })
    );
  };

  return (
    <>
      {/* ==================== PATH PRINCIPAL (visible) ==================== */}
      <path
        id={id}
        className={edgeClassName}
        d={edgePath}
        style={{
          ...style,
          stroke: strokeColor,
          strokeWidth: strokeWidth,
          fill: 'none',
          strokeDasharray: 'none', // ← Línea sólida
          transition: 'stroke 0.2s, stroke-width 0.2s, opacity 0.2s',
          cursor: waypoint ? 'default' : 'pointer',   // ← Cambia según estado
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={handleEdgeClick}
      />

    {/*
    <path
        id={id}
        className={edgeClassName}
        d={edgePath}
        style={{
          ...style,
          stroke: strokeColor,
          strokeWidth: strokeWidth,
          fill: 'none',
          transition: 'stroke 0.2s, stroke-width 0.2s, opacity 0.2s',
          cursor: waypoint ? 'default' : 'pointer',   // ← Cambia según estado
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={handleEdgeClick}
      />


<path
  id={id}
  className={edgeClassName}
  d={edgePath}
  style={{
    ...style,
    stroke: strokeColor,
    strokeWidth: strokeWidth,
    fill: 'none',
    strokeDasharray: 'none',        // ← Línea sólida
    transition: 'stroke 0.2s, stroke-width 0.2s, opacity 0.2s',
    cursor: waypoint ? 'default' : 'pointer',
  }}
  onMouseEnter={() => setIsHovered(true)}
  onMouseLeave={() => setIsHovered(false)}
  onClick={handleEdgeClick}
/>
    
    */} 

      {/* Píldoras de Cardinalidad */}
   <EdgeLabelRenderer>
  {cardinalityLabels.source && (
    <div
      className="cardinality-badge"
      style={{
        transform: `translate(-50%, -50%) translate(${sourceBadgeX}px, ${sourceY - 9 + sourceBadgeOffsetY}px)`,
        borderColor: strokeColor,
        color: strokeColor,
        opacity: isDimmed ? 0.12 : 1,
      }}
    >
      {cardinalityLabels.source}
    </div>
  )}

  {cardinalityLabels.target && (
    <div
      className="cardinality-badge"
      style={{
        transform: `translate(-50%, -50%) translate(${targetBadgeX}px, ${targetY - 9 + targetBadgeOffsetY}px)`,
        borderColor: strokeColor,
        color: strokeColor,
        opacity: isDimmed ? 0.12 : 1,
      }}
    >
      {cardinalityLabels.target}
    </div>
  )}
</EdgeLabelRenderer>

      {/* Waypoint */}
      {waypoint && !isDimmed && (
        <EdgeLabelRenderer>
          <div
            onPointerDown={handleWaypointPointerDown}
            onDoubleClick={handleWaypointDoubleClick}
            title="Arrastra para mover · Doble clic para eliminar"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${waypoint.x}px, ${waypoint.y}px)`,
              width: isDraggingPoint ? 16 : 12,
              height: isDraggingPoint ? 16 : 12,
              borderRadius: '50%',
              background: isDraggingPoint ? '#16a34a' : strokeColor,
              border: `2px solid ${isDark ? '#0a0a0a' : 'white'}`,
              boxShadow: '0 1px 5px rgba(15, 23, 42, 0.35)',
              cursor: isDraggingPoint ? 'grabbing' : 'grab',
              pointerEvents: 'all',
              zIndex: 20,
            }}
          />
        </EdgeLabelRenderer>
      )}

      {/* ==================== PATH INVISIBLE (solo para mejor hit area) ==================== */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={28}
        style={{ 
          cursor: waypoint ? 'default' : 'pointer' 
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={handleEdgeClick}
      />

      {/* Animación */}
      {shouldAnimate && (
        <circle r="5" fill={dotColor} opacity="0.9">
          <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}

      {label && !isDimmed && (
        showHorizontalLabel ? (
          <EdgeLabelRenderer>
            <div className="custom-edge-label-renderer" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
              <div className={`horizontal-edge-label ${isFocused ? 'active-green' : ''}`}>
                {label.toString()}
              </div>
            </div>
          </EdgeLabelRenderer>
        ) : (
          <EdgeLabelRenderer>
            <div className="absolute inset-0 pointer-events-none overflow-visible">
              <svg className="w-full h-full overflow-visible absolute inset-0">
                <path id={`path-${id}`} d={textPath} fill="none" />
                <text dy="-6" className="select-none font-mono font-bold text-[10px] fill-indigo-950/80 dark:fill-indigo-300">
                  <textPath href={`#path-${id}`} startOffset="50%" textAnchor="middle">
                    {label.toString()}
                  </textPath>
                </text>
              </svg>
            </div>
          </EdgeLabelRenderer>
        )
      )}
    </>
  );
}