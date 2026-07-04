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

// Variable interna declarada en el bloque DECLARE de un procedimiento/función
// PL/pgSQL. A diferencia de los parámetros (que vienen de la firma de la
// función), estas se extraen del cuerpo del código.
export interface ProcedureVariable {
  name: string;
  type: string;
  defaultValue?: string;
  isConstant?: boolean;
}

export interface Procedure {
  name: string;
  schema?: string;
  parameters?: string[];
  variables?: ProcedureVariable[]; // ← NUEVO: variables internas (DECLARE), separadas de los parámetros
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