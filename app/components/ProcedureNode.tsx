"use client";
import { Handle, Position, NodeProps } from 'reactflow';
import { ProcedureTableOperation, ProcedureVariable } from '../lib/types';
import { buildHandleId } from '../lib/sqlParser';

interface ProcedureNodeData {
  label: string;
  nodeId: string;
  schema?: string;
  parameters?: string[];
  variables?: ProcedureVariable[];
  returnType?: string;
  language?: string;
  affectedTables: ProcedureTableOperation[];
  comment?: string;
}

// Colores por tipo de operación
const operationColors: Record<string, string> = {
  INSERT: 'bg-green-100 text-green-700 border-green-300 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800',
  UPDATE: 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-800',
  DELETE: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800',
  SELECT: 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-950/50 dark:text-purple-400 dark:border-purple-800',
};

const operationIcons: Record<string, string> = {
  INSERT: '➕',
  UPDATE: '✏️',
  DELETE: '🗑️',
  SELECT: '🔍',
};

export default function ProcedureNode({ data }: NodeProps<ProcedureNodeData>) {
  const displayName = data.schema ? `${data.schema}.${data.label}` : data.label;
  const allAffectedTables = data.affectedTables ?? [];
  const isProcedure = data.returnType === 'PROCEDURE';
  const headerIcon = isProcedure ? '⚙️' : '🧩';
  const headerTitle = isProcedure ? 'Procedimiento Almacenado' : 'Función';

  return (
<div
      className="bg-card rounded-md shadow-sm border border-border min-w-[280px]"
    >
      {/* Header - Diferenciado visualmente como Procedimiento */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border rounded-t-md">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="text-sm" title={headerTitle}>{headerIcon}</span>
          <span className="font-semibold text-sm text-foreground truncate" title={displayName}>
            {displayName}
          </span>
        </div>
      </div>

      {/* Parámetros y Retorno */}
      <div className="divide-y divide-border">
        {data.parameters && data.parameters.length > 0 && (
          <div className="px-3 py-2">
            <div className="text-xs font-medium text-muted-foreground mb-1">Parámetros:</div>
            <div className="flex flex-col gap-0.5">
              {data.parameters.map((param, idx) => (
                <div key={idx} className="text-xs font-mono text-foreground/80 truncate">
                  {param}
                </div>
              ))}
            </div>
          </div>
        )}

        {data.variables && data.variables.length > 0 && (
          <div className="px-3 py-2 border-t border-border">
            <div className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
              <span>🧮</span>
              <span>Variables:</span>
            </div>
            <div className="flex flex-col gap-0.5">
              {data.variables.map((v, idx) => (
                <div key={idx} className="flex items-center gap-1.5 text-xs font-mono truncate">
                  {v.isConstant && <span title="CONSTANT" className="text-amber-500 dark:text-amber-400">🔒</span>}
                  <span className="text-orange-700 dark:text-orange-400 truncate">{v.name}</span>
                  <span className="text-muted-foreground">{v.type.toLowerCase()}</span>
                  {v.defaultValue && (
                    <span
                      className="text-[10px] bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400 px-1 rounded font-mono truncate max-w-[90px]"
                      title={`Default: ${v.defaultValue}`}
                    >
                      := {v.defaultValue.length > 10 ? v.defaultValue.substring(0, 10) + '...' : v.defaultValue}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {data.returnType && (
          <div className="px-3 py-2 border-t border-border">
            <div className="text-xs font-medium text-muted-foreground">Retorna:</div>
            <div className="text-xs font-mono text-foreground/80">{data.returnType}</div>
          </div>
        )}

        {data.language && (
          <div className="px-3 py-2 border-t border-border">
            <div className="text-xs font-medium text-muted-foreground">Lenguaje:</div>
            <div className="text-xs font-mono text-foreground/80">{data.language}</div>
          </div>
        )}
      </div>

      {/* Tablas Afectadas - Footer con operaciones */}
      {allAffectedTables.length > 0 && (
       <div className="border-t border-border bg-muted/50 rounded-b-md px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
            <span>📊</span>
            <span>Tablas Afectadas:</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {allAffectedTables.map((op, idx) => {
              const handleId = buildHandleId(data.nodeId, `${op.tableName}-${op.operationType}`, 'source');
              const colorClass = operationColors[op.operationType] || 'bg-muted text-foreground border-border';
              const icon = operationIcons[op.operationType] || '⚡';

              return (
                <div
                  key={idx}
                  className="relative flex items-center gap-2 p-1.5 rounded border border-border bg-muted/50"
                >
                  {/* Handle source para conectar con las tablas afectadas */}
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={`${handleId}__R`}
                    className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-card hover:!opacity-100 transition-opacity"
                    style={{ right: -6 }}
                  />
                  <Handle
                    type="source"
                    position={Position.Left}
                    id={`${handleId}__L`}
                    className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-card hover:!opacity-100 transition-opacity"
                    style={{ left: -6 }}
                  />

                  {/* Icono de operación */}
                  <span className="text-sm" title={op.operationType}>{icon}</span>

                  {/* Etiqueta de operación con color */}
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${colorClass}`}>
                    {op.operationType}
                  </span>

                  {/* Nombre de la tabla */}
                  <span className="text-xs font-mono text-foreground/80 truncate flex-1" title={op.tableName}>
                    {op.tableName}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Comentario opcional */}
      {data.comment && (
        <div className="border-t border-border bg-yellow-50 dark:bg-yellow-950/30 px-3 py-1.5 rounded-b-md">
          <div className="text-[10px] text-muted-foreground italic truncate" title={data.comment}>
            💬 {data.comment}
          </div>
        </div>
      )}
    </div>
  );
}