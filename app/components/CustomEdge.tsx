"use client";
import React, { useState } from 'react';
import { EdgeProps, getBezierPath, getSmoothStepPath, getStraightPath, EdgeLabelRenderer, Position } from 'reactflow';

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

  // Extraemos las propiedades de control enviadas desde page.tsx
  const isFocused = data?.isFocused ?? false;
  const isDimmed = data?.isDimmed ?? false;
  
  // Determinar el tipo de línea: 'default' | 'smoothstep' | 'step' | 'straight'
  const edgeType = data?.edgeType || 'default';
  
  const edgeOffset = data?.offset ?? 0;
  const cardinalityLabels: { source: string; target: string } =
    data?.cardinalityLabels ?? { source: '*', target: '1' };

  // NUEVO: Offsets verticales para evitar superposición de badges
  const sourceBadgeOffsetY = data?.sourceBadgeOffsetY ?? 0;
  const targetBadgeOffsetY = data?.targetBadgeOffsetY ?? 0;

  // Función auxiliar para obtener el path según el tipo
  const getPath = (
    sx: number, sy: number, sp: Position,
    tx: number, ty: number, tp: Position
  ) => {
    const commonProps = { sourceX: sx, sourceY: sy, sourcePosition: sp, targetX: tx, targetY: ty, targetPosition: tp };
    
    switch (edgeType) {
      case 'smoothstep':
        // getSmoothStepPath devuelve [path, labelX, labelY, offsetX, offsetY]
        return getSmoothStepPath({ ...commonProps, borderRadius: 12, offset: 35 + edgeOffset });
      case 'step':
        // Simulamos step usando smoothstep con borderRadius 0
        return getSmoothStepPath({ ...commonProps, borderRadius: 0, offset: 35 + edgeOffset });
      case 'straight':
        // getStraightPath devuelve [path, labelX, labelY]
        return getStraightPath(commonProps);
      case 'default':
      default:
        // getBezierPath devuelve [path, labelX, labelY]
        return getBezierPath(commonProps);
    }
  };

  // Decidir el algoritmo geométrico de la línea
  // Nota: Algunas funciones devuelven 5 elementos, otras 3. Usamos índices explícitos.
  const pathResult = getPath(sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition);
  const edgePath = pathResult[0];
  const labelX = pathResult[1];
  const labelY = pathResult[2];

  // ¿La curva va de derecha a izquierda? Si seguimos ese mismo trazado para
  // el texto, los glifos quedarían boca abajo/espejados (textPath sigue la
  // dirección del path). Para evitarlo, cuando esto pasa generamos un
  // segundo path -solo para el texto-, con la misma forma pero recorrido en
  // sentido inverso (izquierda -> derecha), así el texto siempre se lee bien.
  const isPathRightToLeft = sourceX > targetX;
  
  let textPath = edgePath;
  if (isPathRightToLeft) {
     const reverseResult = getPath(targetX, targetY, targetPosition, sourceX, sourceY, sourcePosition);
     textPath = reverseResult[0];
  }

  // Definición de colores y grosores según el estado interactivo
  let strokeColor = style.stroke || '#4f46e5';
  let strokeWidth = 2;
  let dotColor = '#4f46e5';

  if (isFocused) {
    strokeColor = '#16a34a';
    dotColor = '#16a34a';
    strokeWidth = 3.5;
  } else if (isHovered) {
    strokeColor = '#4338ca';
    dotColor = '#4338ca';
    strokeWidth = 3;
  }

  // Clases CSS dinámicas
  const edgeClassName = `react-flow__edge-path ${isDimmed ? 'edge-dimmed' : ''}`;

  // Mostrar el texto flotante horizontal si está en hover o si la tabla padre está seleccionada
  const showHorizontalLabel = isHovered || isFocused;

  // Solo animar si está habilitado y no está atenuado
  const shouldAnimate = animated && !isDimmed;

  // Posición de las píldoras de cardinalidad: pegadas a cada tabla,
  // desplazadas hacia afuera del nodo (mismo criterio L/R que el resto
  // del componente) y un poco hacia arriba de la línea para no taparla.
  // NUEVO: se aplica el offset vertical (badgeOffsetY) para evitar
  // superposición cuando múltiples líneas convergen en el mismo handle.
  const sourceBadgeDir = sourcePosition === Position.Left ? -1 : 1;
  const targetBadgeDir = targetPosition === Position.Left ? -1 : 1;
  const badgeDistance = 22;

  const sourceBadgeX = sourceX + sourceBadgeDir * badgeDistance;
  const targetBadgeX = targetX + targetBadgeDir * badgeDistance;

  return (
    <>
      {/* Línea visible de la arista */}
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
          cursor: 'pointer',
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      />

      {/* Píldoras de Cardinalidad (estilo dbdiagram.io), siempre visibles */}
      <EdgeLabelRenderer>
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
      </EdgeLabelRenderer>

      {/* Path invisible más ancho para interactuar cómodamente con el mouse */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={15}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      />

      {/* Círculo animado que viaja a lo largo del path */}
      {shouldAnimate && (
        <circle r="5" fill={dotColor} opacity="0.9">
          <animateMotion
            dur="2s"
            repeatCount="indefinite"
            path={edgePath}
          />
        </circle>
      )}

      {label && !isDimmed && (
        <>
          {/* MODO TEXTO HORIZONTAL (Activo en Hover común OR en Selección Verde) */}
          {showHorizontalLabel && (
            <EdgeLabelRenderer>
              <div
                className="custom-edge-label-renderer"
                style={{
                  transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                }}
              >
                <div className={`horizontal-edge-label ${isFocused ? 'active-green' : ''}`}>
                  {label.toString()}
                </div>
              </div>
            </EdgeLabelRenderer>
          )}

          {/* MODO NORMAL: Texto curvo que sigue la línea */}
          {!showHorizontalLabel && (
            <EdgeLabelRenderer>
              <div className="absolute inset-0 pointer-events-none overflow-visible">
                <svg className="w-full h-full overflow-visible absolute inset-0">
                  <path id={`path-${id}`} d={textPath} fill="none" className="pointer-events-none" />
                  <text dy="-6" className="select-none font-mono font-bold text-[10px] fill-indigo-950/80">
                    <textPath
                      href={`#path-${id}`}
                      startOffset="50%"
                      textAnchor="middle"
                    >
                      {label.toString()}
                    </textPath>
                  </text>
                </svg>
              </div>
            </EdgeLabelRenderer>
          )}
        </>
      )}
    </>
  );
}