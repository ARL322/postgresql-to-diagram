"use client";
import { Handle, Position, NodeProps } from 'reactflow';
import { Column, IndexInfo } from '../lib/types';
import { buildHandleId } from '../lib/sqlParser';
import { useTheme } from 'next-themes';

interface TableNodeData {
  label: string;
  nodeId: string;
  schema?: string;
  columns: Column[];
  indexes?: IndexInfo[];
  comment?: string;
}

export default function TableNode({ data }: NodeProps<TableNodeData>) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const displayName = data.label;
  const allIndexes = data.indexes ?? [];

  return (
    <div
      className={`rounded-md shadow-sm border min-w-[280px] ${
        isDark 
          ? 'bg-zinc-900 border-zinc-700' 
          : 'bg-white border-gray-300'
      }`}
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-3 py-2 border-b rounded-t-md ${
        isDark 
          ? 'bg-zinc-800 border-zinc-700' 
          : 'bg-gray-50 border-gray-300'
      }`}>
        <div className="flex items-center gap-2 overflow-hidden">
          <span className={`font-semibold text-sm truncate ${
            isDark ? 'text-zinc-100' : 'text-gray-800'
          }`}>{displayName}</span>
        </div>
      </div>

      {/* Columns */}
      <div className={`divide-y ${isDark ? 'divide-zinc-700' : 'divide-gray-200'}`}>
        {data.columns.map((col, idx) => {
          const targetHandleId = buildHandleId(data.nodeId, col.name, 'target');
          const sourceHandleId = buildHandleId(data.nodeId, col.name, 'source');

          return (
            <div
              key={idx}
              className={`relative flex items-center px-3 py-1.5 gap-2 ${
                isDark ? 'hover:bg-zinc-800' : 'hover:bg-gray-50'
              }`}
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
                <div className="flex items-center gap-0.5 text-xs flex-shrink-0">
                  {col.isPK && <span title="Primary Key">🔑</span>}
                  {col.isFKSource && <span title="Foreign Key">🔗</span>}
                </div>
                
                <span className={`text-xs font-mono truncate ${
                  col.isPK 
                    ? (isDark ? 'font-bold text-zinc-100' : 'font-bold text-gray-900')
                    : (isDark ? 'text-zinc-300' : 'text-gray-700')
                }`}>
                  {col.name}
                </span>

                <span className={`text-xs font-mono truncate flex-shrink-0 ${
                  isDark ? 'text-zinc-500' : 'text-gray-400'
                }`}>
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
        <div className={`border-t rounded-b-md px-3 py-2 ${
          isDark 
            ? 'border-zinc-700 bg-zinc-800' 
            : 'border-gray-300 bg-gray-50'
        }`}>
          <div className={`text-xs font-medium mb-1 ${
            isDark ? 'text-zinc-400' : 'text-gray-500'
          }`}>
            Indexes ({allIndexes.length})
          </div>
          <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto">
            {allIndexes.map((idx, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <span className={isDark ? 'text-zinc-500' : 'text-gray-400'}>{idx.isUnique ? '💎' : '⚡'}</span>
                <span className={`font-mono truncate ${
                  isDark ? 'text-zinc-300' : 'text-gray-600'
                }`}>{idx.name}</span>
                <span className={`font-mono text-xs ${
                  isDark ? 'text-zinc-500' : 'text-gray-400'
                }`}>
                  ({idx.columns.join(', ')})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}