//
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

export interface Table {
  name: string;
  schema?: string;
  columns: Column[];
  indexes?: IndexInfo[];
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