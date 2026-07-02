"use client";
import { Handle, Position, NodeProps } from 'reactflow';
import { Column, IndexInfo, TriggerInfo } from '../lib/types';
import { buildHandleId } from '../lib/sqlParser';

interface TableNodeData {
  label: string;
  nodeId: string;
  schema?: string;
  columns: Column[];
  indexes?: IndexInfo[];
  triggers?: TriggerInfo[];
  comment?: string;
}

export default function TableNode({ data }: NodeProps<TableNodeData>) {
  const displayName = data.schema ? `${data.schema}.${data.label}` : data.label;
  const allIndexes = data.indexes ?? [];
  const allTriggers = data.triggers ?? [];

  return (
    <div
      className="bg-white rounded-md shadow-sm border border-gray-300 min-w-[280px]"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-300 rounded-t-md">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="font-semibold text-sm text-gray-800 truncate" title={displayName}>
            {displayName}
          </span>
        </div>
      </div>

      {/* Columns */}
      <div className="divide-y divide-gray-200">
        {data.columns.map((col, idx) => {
          const targetHandleId = buildHandleId(data.nodeId, col.name, 'target');
          const sourceHandleId = buildHandleId(data.nodeId, col.name, 'source');

          return (
            <div
              key={idx}
              className="relative flex items-center px-3 py-1.5 gap-2"
            >
              {/* Left Handles */}
              <Handle
                type="target"
                position={Position.Left}
                id={`${targetHandleId}__L`}
                className="!w-2 !h-2 !bg-indigo-500 !border-0 !opacity-0 hover:!opacity-100 transition-opacity"
                style={{ left: -4 }}
              />
              <Handle
                type="source"
                position={Position.Left}
                id={`${sourceHandleId}__L`}
                className="!w-2 !h-2 !bg-indigo-500 !border-0 !opacity-0 hover:!opacity-100 transition-opacity"
                style={{ left: -4 }}
              />

              {/* Column Info */}
<div className="flex items-center gap-1.5 flex-1 min-w-0">
  <div className="flex items-center gap-0.5 text-xs text-gray-500 flex-shrink-0">
    {col.isPK && <span title="Primary Key">🔑</span>}
    {col.isFKSource && <span title="Foreign Key">🔗</span>}
  </div>
  
  <span className={`text-xs font-mono truncate ${
    col.isPK ? 'font-bold text-gray-900' : 'text-gray-700'
  }`}>
    {col.name}
  </span>

  <span className="text-xs text-gray-400 font-mono truncate flex-shrink-0">
    {col.type.toLowerCase()}
  </span>

  {/* Indicador NULL / NOT NULL */}
  <span className={`text-[10px] font-medium px-1 rounded ${
    col.isNullable === false 
      ? 'bg-red-100 text-red-700' 
      : 'bg-green-100 text-green-700'
  }`} title={col.isNullable === false ? 'NOT NULL' : 'NULL'}>
    {col.isNullable === false ? 'NN' : 'N'}
  </span>

  {/* Valor por defecto si existe */}
  {col.defaultValue && (
    <span className="text-[10px] bg-blue-100 text-blue-700 px-1 rounded font-mono truncate max-w-[80px]" title={`Default: ${col.defaultValue}`}>
      D:{col.defaultValue.length > 8 ? col.defaultValue.substring(0, 8) + '...' : col.defaultValue}
    </span>
  )}
</div>

              {/* Right Handles */}
              <Handle
                type="target"
                position={Position.Right}
                id={`${targetHandleId}__R`}
                className="!w-2 !h-2 !bg-indigo-500 !border-0 !opacity-0 hover:!opacity-100 transition-opacity"
                style={{ right: -4 }}
              />
              <Handle
                type="source"
                position={Position.Right}
                id={`${sourceHandleId}__R`}
                className="!w-2 !h-2 !bg-indigo-500 !border-0 !opacity-0 hover:!opacity-100 transition-opacity"
                style={{ right: -4 }}
              />
            </div>
          );
        })}
      </div>

      {/* Indexes & Triggers Footer */}
      {(allIndexes.length > 0 || allTriggers.length > 0) && (
        <div className="border-t border-gray-300 bg-gray-50 rounded-b-md px-3 py-2">
          {allIndexes.length > 0 && (
            <>
              <div className="text-xs font-medium text-gray-500 mb-1">
                Indexes ({allIndexes.length})
              </div>
              <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto mb-2">
                {allIndexes.map((idx, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs">
                    <span className="text-gray-400">{idx.isUnique ? '💎' : '⚡'}</span>
                    <span className="font-mono text-gray-600 truncate">{idx.name}</span>
                    <span className="text-gray-400 font-mono text-xs">({idx.columns.join(', ')})</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {allTriggers.length > 0 && (
            <>
              <div className="text-xs font-medium text-gray-500 mb-1">
                Triggers ({allTriggers.length})
              </div>
              <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto">
                {allTriggers.map((trg, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs">
                    <span className="text-gray-400">🔔</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-gray-600 truncate" title={trg.name}>
                        {trg.name}
                      </div>
                      <div className="text-gray-400 text-[10px]">
                        {trg.timing} {trg.events.join(' / ')} → {trg.function}
                      </div>
                      {trg.forEachRow && (
                        <div className="text-gray-400 text-[10px]">FOR EACH ROW</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}