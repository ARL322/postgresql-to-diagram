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
  const displayName = data.schema ? `${data.schema}.${data.label}` : data.label;
  const allIndexes = data.indexes ?? [];

  return (
    <div
      style={{ minWidth: 320 }}
      className="bg-white rounded-2xl shadow-xl border border-slate-200/80 hover:border-indigo-500/80 hover:shadow-2xl transition-all duration-300 font-sans overflow-visible group"
    >
      {/* Encabezado Estilo Entidad Prisma */}
      <div
        className="bg-slate-900 text-slate-100 px-4 py-3.5 rounded-t-2xl font-semibold flex items-center justify-between gap-2 border-b border-slate-950/20"
        title={data.comment}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
          <span className="truncate text-xs tracking-wider font-mono font-bold text-slate-200 uppercase">{displayName}</span>
        </div>
        {data.comment && (
          <span className="cursor-help text-[10px] bg-slate-800 text-slate-400 hover:text-white px-2 py-0.5 rounded font-mono transition-colors" title={data.comment}>
            COMMENT
          </span>
        )}
      </div>

      {/* Listado de Campos de la Entidad */}
      <div className="bg-white divide-y divide-slate-100 py-1">
        {data.columns.map((col, idx) => {
          const targetHandleId = buildHandleId(data.nodeId, col.name, 'target');
          const sourceHandleId = buildHandleId(data.nodeId, col.name, 'source');

          return (
            <div
              key={idx}
              className="relative flex justify-between items-center px-4 py-2 hover:bg-slate-50 transition-colors gap-2"
            >
              {/* Conectores Flotantes: cada lado tiene tanto target como source
                  superpuestos en el mismo punto, así React Flow puede elegir
                  dinámicamente el lado correcto según la posición relativa de
                  la tabla conectada (ver getDynamicHandleSides en page.tsx) */}
              <Handle
                type="target"
                position={Position.Left}
                id={`${targetHandleId}__L`}
                style={{ 
                  width: 6, 
                  height: 6, 
                  background: '#4f46e5', 
                  border: '2px solid #ffffff', 
                  left: -3,
                  boxShadow: '0 0 0 2px rgba(99, 102, 241, 0.2)'
                }}
              />
              <Handle
                type="source"
                position={Position.Left}
                id={`${sourceHandleId}__L`}
                style={{ 
                  width: 6, 
                  height: 6, 
                  background: '#4f46e5', 
                  border: '2px solid #ffffff', 
                  left: -3,
                  boxShadow: '0 0 0 2px rgba(99, 102, 241, 0.2)'
                }}
              />

              {/* Lado Izquierdo: Llaves, Nombre de Campo y Nullability */}
              <div className="flex items-center gap-2 overflow-hidden min-w-0 flex-1">
                <div className="flex items-center justify-center flex-shrink-0 gap-0.5 text-[11px] select-none">
  {col.isPK && <span title="Primary Key">🔑</span>}
  {col.isFKSource && <span title="Foreign Key">🔗</span>}
</div>
                
                <span
                  className={`truncate text-xs font-mono tracking-tight ${
                    col.isPK ? 'font-bold text-slate-900' : 'text-slate-700'
                  }`}
                >
                  {col.name}
                </span>

                <div className="flex items-center gap-1 flex-shrink-0 select-none">
                  {col.isUniqueColumn && !col.isPK && (
                    <span className="text-[8px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded-xs uppercase">
                      uq
                    </span>
                  )}
                  {col.isNullable === false ? (
                    <span className="text-[8px] font-extrabold text-rose-700 bg-rose-50 border border-rose-100 px-1 rounded-xs uppercase">
                      nn
                    </span>
                  ) : (
                    <span className="text-[8px] font-medium text-slate-400 bg-slate-50 border border-slate-200/60 px-1 rounded-xs uppercase">
                      null
                    </span>
                  )}
                </div>
              </div>

              {/* Lado Derecho: Expresiones por Defecto y Data-Type */}
              <div className="flex items-center gap-2 flex-shrink-0 max-w-[45%] select-none">
                {col.defaultValue && (
                  <span className="text-[9px] text-emerald-600 font-mono truncate max-w-[70px] bg-emerald-50/50 border border-emerald-100 px-1 rounded" title={`Default: ${col.defaultValue}`}>
                    {col.defaultValue}
                  </span>
                )}
                <span className="text-slate-500 text-[10px] font-mono bg-slate-100 border border-slate-200/40 px-2 py-0.5 rounded-md font-medium">
                  {col.type.toLowerCase()}
                </span>
              </div>

              <Handle
                type="target"
                position={Position.Right}
                id={`${targetHandleId}__R`}
                style={{ 
                  width: 6, 
                  height: 6, 
                  background: '#4f46e5', 
                  border: '2px solid #ffffff', 
                  right: -3,
                  boxShadow: '0 0 0 2px rgba(99, 102, 241, 0.2)'
                }}
              />
              <Handle
                type="source"
                position={Position.Right}
                id={`${sourceHandleId}__R`}
                style={{ 
                  width: 6, 
                  height: 6, 
                  background: '#4f46e5', 
                  border: '2px solid #ffffff', 
                  right: -3,
                  boxShadow: '0 0 0 2px rgba(99, 102, 241, 0.2)'
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Footer Avanzado de Índices y Constraints */}
      {allIndexes.length > 0 && (
        <div className="border-t border-slate-100 bg-slate-50/70 rounded-b-2xl px-4 py-3">
          <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2 select-none">
            Índices y Claves ({allIndexes.length})
          </div>
          <div className="flex flex-col gap-1.5 max-h-[150px] overflow-y-auto">
            {allIndexes.map((idx, i) => (
              <div key={i} className="flex items-center gap-2 text-xs bg-white border border-slate-200/50 p-2 rounded-xl shadow-xs">
                <span className="text-xs select-none" title={idx.isUnique ? 'Índice Único (Constraint)' : 'Índice Estándar'}>
                  {idx.isUnique ? '💎' : '⚡'}
                </span>
                <div className="flex flex-col min-w-0 flex-1 font-mono leading-normal">
                  <span className="text-slate-700 font-bold text-[10px] truncate" title={idx.name}>
                    {idx.name ?? `idx_sys_${i}`}
                  </span>
                  <span className="text-indigo-600 font-medium text-[9px] truncate">
                    fields: <span className="bg-indigo-50/60 px-1 rounded text-indigo-700 font-bold font-mono">{idx.columns.join(', ')}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}