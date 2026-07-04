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
      className="bg-card rounded-md shadow-sm border border-border min-w-[280px]"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border rounded-t-md">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="font-semibold text-sm text-foreground truncate" title={displayName}>
            {displayName}
          </span>
        </div>
      </div>

      {/* Columns */}
      <div className="divide-y divide-border">
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
  <div className="flex items-center gap-0.5 text-xs text-muted-foreground flex-shrink-0">
    {col.isPK && <span title="Primary Key">🔑</span>}
    {col.isFKSource && <span title="Foreign Key">🔗</span>}
  </div>
  
  <span className={`text-xs font-mono truncate ${
    col.isPK ? 'font-bold text-foreground' : 'text-foreground/80'
  }`}>
    {col.name}
  </span>

  <span className="text-xs text-muted-foreground font-mono truncate flex-shrink-0">
    {col.type.toLowerCase()}
  </span>

  {/* Indicador NULL / NOT NULL */}
  <span className={`text-[10px] font-medium px-1 rounded ${
    col.isNullable === false 
      ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400' 
      : 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400'
  }`} title={col.isNullable === false ? 'NOT NULL' : 'NULL'}>
    {col.isNullable === false ? 'NN' : 'N'}
  </span>

  {/* Valor por defecto si existe */}
  {col.defaultValue && (
    <span className="text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400 px-1 rounded font-mono truncate max-w-[80px]" title={`Default: ${col.defaultValue}`}>
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

      {/* Handle especial para conexiones desde procedimientos almacenados */}
      <Handle
        type="target"
        position={Position.Left}
        id={`${buildHandleId(data.nodeId, '_proc_target', 'target')}__L`}
        className="!w-0 !h-0 !opacity-0"
        style={{ left: 0 }}
      />
      <Handle
        type="target"
        position={Position.Right}
        id={`${buildHandleId(data.nodeId, '_proc_target', 'target')}__R`}
        className="!w-0 !h-0 !opacity-0"
        style={{ right: 0 }}
      />

      {/* Indexes & Triggers Footer */}
      {(allIndexes.length > 0 || allTriggers.length > 0) && (
        <div className="border-t border-border bg-muted/50 rounded-b-md px-3 py-2">
          {allIndexes.length > 0 && (
            <>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Indexes ({allIndexes.length})
              </div>
              <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto mb-2">
                {allIndexes.map((idx, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">{idx.isUnique ? '💎' : '⚡'}</span>
                    <span className="font-mono text-foreground/80 truncate">{idx.name}</span>
                    <span className="text-muted-foreground font-mono text-xs">({idx.columns.join(', ')})</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {allTriggers.length > 0 && (
            <>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Triggers ({allTriggers.length})
              </div>
              <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto">
                {allTriggers.map((trg, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs">
                    <span className="text-muted-foreground">🔔</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-foreground/80 truncate" title={trg.name}>
                        {trg.name}
                      </div>
                      <div className="text-muted-foreground text-[10px]">
                        {trg.timing} {trg.events.join(' / ')} → {trg.function}
                      </div>
                      {trg.forEachRow && (
                        <div className="text-muted-foreground text-[10px]">FOR EACH ROW</div>
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