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

export interface ParsedSchema {
  tables: Table[];
  relationships: Relationship[];
}