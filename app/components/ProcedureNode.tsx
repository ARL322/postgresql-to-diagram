"use client";
import { Handle, Position, NodeProps } from 'reactflow';
import { ProcedureTableOperation } from '../lib/types';
import { buildHandleId } from '../lib/sqlParser';

interface ProcedureNodeData {
  label: string;
  nodeId: string;
  schema?: string;
  parameters?: string[];
  returnType?: string;
  language?: string;
  affectedTables: ProcedureTableOperation[];
  comment?: string;
}

// Colores por tipo de operación
const operationColors: Record<string, string> = {
  INSERT: 'bg-green-100 text-green-700 border-green-300',
  UPDATE: 'bg-blue-100 text-blue-700 border-blue-300',
  DELETE: 'bg-red-100 text-red-700 border-red-300',
  SELECT: 'bg-purple-100 text-purple-700 border-purple-300',
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

  return (
    <div
      className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-md shadow-sm border-2 border-indigo-400 min-w-[280px]"
    >
      {/* Header - Diferenciado visualmente como Procedimiento */}
      <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-r from-indigo-500 to-purple-500 border-b border-indigo-600 rounded-t-md">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="text-lg" title="Procedimiento Almacenado">⚙️</span>
          <span className="font-semibold text-sm text-white truncate" title={displayName}>
            {displayName}
          </span>
        </div>
      </div>

      {/* Parámetros y Retorno */}
      <div className="divide-y divide-gray-200">
        {data.parameters && data.parameters.length > 0 && (
          <div className="px-3 py-2">
            <div className="text-xs font-medium text-indigo-600 mb-1">Parámetros:</div>
            <div className="flex flex-col gap-0.5">
              {data.parameters.map((param, idx) => (
                <div key={idx} className="text-xs font-mono text-gray-600 truncate">
                  {param}
                </div>
              ))}
            </div>
          </div>
        )}

        {data.returnType && (
          <div className="px-3 py-2 border-t border-gray-200">
            <div className="text-xs font-medium text-indigo-600">Retorna:</div>
            <div className="text-xs font-mono text-gray-600">{data.returnType}</div>
          </div>
        )}

        {data.language && (
          <div className="px-3 py-2 border-t border-gray-200">
            <div className="text-xs font-medium text-indigo-600">Lenguaje:</div>
            <div className="text-xs font-mono text-gray-600">{data.language}</div>
          </div>
        )}
      </div>

      {/* Tablas Afectadas - Footer con operaciones */}
      {allAffectedTables.length > 0 && (
        <div className="border-t-2 border-indigo-300 bg-white rounded-b-md px-3 py-2">
          <div className="text-xs font-bold text-indigo-700 mb-2 flex items-center gap-1">
            <span>📊</span>
            <span>Tablas Afectadas:</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {allAffectedTables.map((op, idx) => {
              const handleId = buildHandleId(data.nodeId, `${op.tableName}-${op.operationType}`, 'source');
              const colorClass = operationColors[op.operationType] || 'bg-gray-100 text-gray-700 border-gray-300';
              const icon = operationIcons[op.operationType] || '⚡';

              return (
                <div
                  key={idx}
                  className="relative flex items-center gap-2 p-1.5 rounded border border-gray-200 bg-gray-50"
                >
                  {/* Handle source para conectar con las tablas afectadas */}
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={`${handleId}__R`}
                    className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-white hover:!opacity-100 transition-opacity"
                    style={{ right: -6 }}
                  />
                  <Handle
                    type="source"
                    position={Position.Left}
                    id={`${handleId}__L`}
                    className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-white hover:!opacity-100 transition-opacity"
                    style={{ left: -6 }}
                  />

                  {/* Icono de operación */}
                  <span className="text-sm" title={op.operationType}>{icon}</span>

                  {/* Etiqueta de operación con color */}
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${colorClass}`}>
                    {op.operationType}
                  </span>

                  {/* Nombre de la tabla */}
                  <span className="text-xs font-mono text-gray-700 truncate flex-1" title={op.tableName}>
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
        <div className="border-t border-gray-200 bg-yellow-50 px-3 py-1.5 rounded-b-md">
          <div className="text-[10px] text-gray-500 italic truncate" title={data.comment}>
            💬 {data.comment}
          </div>
        </div>
      )}
    </div>
  );
}
