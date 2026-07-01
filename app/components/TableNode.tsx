"use client";
import { Handle, Position, NodeProps } from 'reactflow';
import { Column, IndexInfo } from '../lib/types';
import { buildHandleId } from '../lib/sqlParser';

interface TableNodeData {
  label: string;
  nodeId: string;
  schema?: string;
  columns: Column[];
  indexes?: IndexInfo[];
  comment?: string;
}

export default function TableNode({ data }: NodeProps<TableNodeData>) {
  const displayName = data.label;
  const allIndexes = data.indexes ?? [];

  return (
    <div
      className="bg-white rounded-md shadow-sm border border-gray-300 min-w-[280px]"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-300 rounded-t-md">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="font-semibold text-sm text-gray-800 truncate">{displayName}</span>
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

      {/* Indexes Footer */}
      {allIndexes.length > 0 && (
        <div className="border-t border-gray-300 bg-gray-50 rounded-b-md px-3 py-2">
          <div className="text-xs font-medium text-gray-500 mb-1">
            Indexes ({allIndexes.length})
          </div>
          <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto">
            {allIndexes.map((idx, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <span className="text-gray-400">{idx.isUnique ? '💎' : '⚡'}</span>
                <span className="font-mono text-gray-600 truncate">{idx.name}</span>
                <span className="text-gray-400 font-mono text-xs">({idx.columns.join(', ')})</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}