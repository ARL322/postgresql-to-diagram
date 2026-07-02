export interface Column {
  name: string;
  type: string;
  isPK: boolean;
  isNullable?: boolean;
  isFKSource?: boolean;
  isUnique?: boolean;
  isUniqueColumn?: boolean;     // ← Clave para cardinalidad correcta
  defaultValue?: string;
  comment?: string;
}

export interface IndexInfo {
  name?: string;
  columns: string[];
  isUnique: boolean;
  fromConstraint?: boolean;
}

export interface TriggerInfo {
  name?: string;
  timing: string;        // BEFORE, AFTER, INSTEAD OF
  events: string[];     // INSERT, UPDATE, DELETE
  onTable?: string;
  function: string;
  forEachRow?: boolean;
  when?: string;
  functionCode?: string; // Cuerpo de la función, cuando proviene de un CREATE FUNCTION ... RETURNS TRIGGER en el mismo script
}

export interface Table {
  name: string;
  schema?: string;
  columns: Column[];
  indexes?: IndexInfo[];
  triggers?: TriggerInfo[];
  comment?: string;
}

export interface Relationship {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  constraintName?: string;
  onDelete?: string;
  onUpdate?: string;
}

// Información sobre qué operación realiza el procedimiento en cada tabla
export interface ProcedureTableOperation {
  tableName: string;
  operationType: 'INSERT' | 'UPDATE' | 'DELETE' | 'SELECT';
}

export interface Procedure {
  name: string;
  schema?: string;
  parameters?: string[];
  returnType?: string;
  language?: string;
  code?: string;
  affectedTables: ProcedureTableOperation[]; // Tablas que afecta y qué operación hace
  comment?: string;
}

export interface ParsedSchema {
  tables: Table[];
  relationships: Relationship[];
  procedures: Procedure[];  // ← NUEVO: lista de procedimientos almacenados
}