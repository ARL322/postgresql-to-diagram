import { parse } from 'pgsql-ast-parser';
import { ParsedSchema, Table, Column, Relationship, IndexInfo } from './types';
//
function getName(name: any): string {
  if (!name) return '';
  if (typeof name === 'string') return name.trim();
  if (name?.name) return String(name.name).trim();
  return String(name).trim();
}

// Sanitize IDs: replace anything that's not alphanumeric, underscore, or dash
export function sanitizeId(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Build the canonical handle ID for a given nodeId + columnName
// This MUST be used consistently in both TableNode and page.tsx
export function buildHandleId(nodeId: string, columnName: string, side: 'source' | 'target'): string {
  return `${sanitizeId(`${nodeId}-${columnName}`).toLowerCase()}-${side}`;
}

// Qualified key used to match a table regardless of whether the schema
// prefix was used when referencing it later (e.g. in CREATE INDEX or FK).
function tableKey(schema: string | undefined, name: string): string {
  return `${(schema ?? '').toLowerCase()}::${name.toLowerCase()}`;
}

function getDataTypeString(dataType: any): string {
  if (!dataType) return 'UNKNOWN';
  if (typeof dataType === 'string') return dataType.toUpperCase();

  // pgsql-ast-parser returns objects like { kind: 'array', arrayOf: { name: 'text' } }
  const kind = dataType.kind || dataType.type || '';
  const name = dataType.name || '';

  if (kind === 'array') {
    const inner = getDataTypeString(dataType.arrayOf);
    return `${inner}[]`;
  }
  
  // Extraer el nombre base del tipo de dato
  let baseType = name ? String(name).toUpperCase() : String(kind).toUpperCase();
  if (!baseType || baseType === 'OBJECT') baseType = 'UNKNOWN';

  // CORRECCIÓN: Capturar longitud o precisión si existen en el AST (ej. VARCHAR(255), NUMERIC(10,2))
if (dataType.config && Array.isArray(dataType.config)) {
    const params = dataType.config.map((c: any) => c.value ?? c).filter(Boolean);
    if (params.length) return `${baseType}(${params.join(',')})`;
  } else if (dataType.length !== undefined) {
    return `${baseType}(${dataType.length})`;
  }
  return baseType;
}

// Best-effort rendering of a DEFAULT expression back to readable SQL text.
// pgsql-ast-parser expression nodes vary a lot in shape, so this stays
// defensive and falls back gracefully instead of throwing.
function getDefaultValueString(expr: any): string | undefined {
  if (expr === undefined || expr === null) return undefined;
  if (typeof expr === 'string') return expr;
  if (typeof expr === 'number' || typeof expr === 'boolean') return String(expr);

  switch (expr.type) {
    case 'string':
      return `'${expr.value}'`;
    case 'numeric':
    case 'integer':
      return String(expr.value);
    case 'boolean':
      return String(expr.value);
    case 'null':
      return 'NULL';
    case 'call': {
      const fnName = getName(expr.function);
      return `${fnName}()`;
    }
    case 'cast':
      return getDefaultValueString(expr.operand);
    case 'unary':
      return `${expr.op}${getDefaultValueString(expr.operand) ?? ''}`;
    case 'ref':
      return getName(expr.name ?? expr);
    default:
      // Fall back to whatever a `.name`/`.value` field offers, otherwise omit it
      // rather than guessing wrong — better no badge than a misleading one.
      if (expr.value !== undefined) return String(expr.value);
      if (expr.name) return getName(expr.name);
      return undefined;
  }
}

function extractComment(stmt: any): string | undefined {
  // pgsql-ast-parser doesn't always retain leading SQL comments on the
  // statement node itself, so this is intentionally tolerant.
  return stmt?.comment ? String(stmt.comment).trim() : undefined;
}

// Split a SQL script into individual top-level statements (on ';'),
// respecting single-quoted strings (with '' escaping), double-quoted
// identifiers, dollar-quoted strings ($$...$$ / $tag$...$tag$), and
// parenthesis nesting so semicolons inside those don't split early.
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const ch = sql[i];

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (ch === "'") {
        // '' is an escaped quote, stay inside the string
        if (sql[i + 1] === "'") {
          current += "'";
          i += 2;
          continue;
        }
        inSingleQuote = false;
      }
      i++;
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (ch === '"') inDoubleQuote = false;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      current += ch;
      i++;
      continue;
    }
    const dollarMatch = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i));
    if (dollarMatch) {
      dollarTag = dollarMatch[0];
      current += dollarTag;
      i += dollarTag.length;
      continue;
    }
    if (ch === '(') {
      depth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      current += ch;
      i++;
      continue;
    }
    if (ch === ';' && depth === 0) {
      statements.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current);
  return statements;
}

export function parsePostgresSQL(sql: string): ParsedSchema {
  const tables: Table[] = [];
  // Map from "schema::table" (lowercased) -> Table, so CREATE INDEX /
  // ALTER TABLE statements that reference a table can find it later
  // regardless of statement order.
  const tablesByKey = new Map<string, Table>();
  const relationships: Relationship[] = [];

  // CREATE INDEX statements are collected separately because they can
  // appear before or after the CREATE TABLE in the script.
  const pendingIndexStatements: any[] = [];
  // ALTER TABLE ... ADD CONSTRAINT (FK/UNIQUE/PK) added after table creation.
  const pendingAlterStatements: any[] = [];

  const statements = splitStatements(sql);

  for (const rawStmt of statements) {
    const stmtText = rawStmt.trim();
    if (!stmtText) continue;

    let stmtAst: any[];
    try {
      stmtAst = parse(stmtText) as any[];
    } catch {
      // Ignore statements we don't care about / can't parse:
      continue;
    }

    for (const stmt of stmtAst) {
      if (stmt.type === 'create table') {
        const tableName = getName(stmt.name);
        const schema = stmt.name?.schema ? getName(stmt.name.schema) : undefined;
        const columns: Column[] = [];
        const indexes: IndexInfo[] = [];

        // Pass 1: extract columns + inline PK/FK/UNIQUE/NOT NULL/DEFAULT
        if (stmt.columns) {
          for (const col of stmt.columns) {
            if (col.kind === 'column') {
              let isPK = false;
              let isFKSource = false;
              let isUnique = false;
              let isNullable = true;
              let defaultValue: string | undefined;
              const colName = getName(col.name);

              if (col.constraints) {
                for (const c of col.constraints) {
                  if (c.type === 'primary key') {
                    isPK = true;
                    isNullable = false;
                  }
                  if (c.type === 'not null') isNullable = false;
                  if (c.type === 'null') isNullable = true;
                  if (c.type === 'unique') isUnique = true;
                  if (c.type === 'default') {
                    defaultValue = getDefaultValueString(c.default);
                  }

                  if (c.type === 'reference' || c.type === 'foreign key' || c.type === 'foreign_key') {
                    isFKSource = true;
                    const targetTable = getName(
                      c.foreignTable || c.references?.table || c.table
                    );
                    const targetCol = getName(
                      c.foreignColumns?.[0] || c.references?.columns?.[0] || c.columns?.[0]
                    );
                    if (targetTable && targetCol) {
                      relationships.push({
                        sourceTable: tableName,
                        sourceColumn: colName,
                        targetTable,
                        targetColumn: targetCol,
                        constraintName: c.constraintName ? getName(c.constraintName) : undefined,
                        onDelete: c.onDelete ? String(c.onDelete).toUpperCase() : undefined,
                        onUpdate: c.onUpdate ? String(c.onUpdate).toUpperCase() : undefined,
                      });
                    }
                  }
                }
              }

              columns.push({
                name: colName,
                type: getDataTypeString(col.dataType),
                isPK,
                isFKSource,
                isUnique,
                isNullable,
                defaultValue,
              });

              if (isUnique && !isPK) {
                indexes.push({ columns: [colName], isUnique: true, fromConstraint: true });
              }
            }
          }
        }

        // Pass 2: table-level constraints (PK, FK, UNIQUE)
        if (stmt.constraints) {
          for (const constraint of stmt.constraints) {
            const cAny = constraint as any;
            if (cAny.type === 'foreign key' || cAny.type === 'foreign_key') {
              const sourceCols: any[] = cAny.localColumns || cAny.columns || [];
              const targetCols: any[] = cAny.foreignColumns || cAny.references?.columns || [];
              const targetTable = getName(
                cAny.foreignTable || cAny.references?.table || cAny.table
              );

              for (let i = 0; i < sourceCols.length; i++) {
                const sourceColName = getName(sourceCols[i]);
                const targetColName = getName(targetCols[i] ?? targetCols[0]);

                if (targetTable && targetColName) {
                  relationships.push({
                    sourceTable: tableName,
                    sourceColumn: sourceColName,
                    targetTable,
                    targetColumn: targetColName,
                    constraintName: cAny.constraintName ? getName(cAny.constraintName) : undefined,
                    onDelete: cAny.onDelete ? String(cAny.onDelete).toUpperCase() : undefined,
                    onUpdate: cAny.onUpdate ? String(cAny.onUpdate).toUpperCase() : undefined,
                  });
                  const col = columns.find(c => c.name === sourceColName);
                  if (col) col.isFKSource = true;
                }
              }
            } else if (cAny.type === 'primary key') {
              const pkCols: any[] = cAny.columns || [];
              const pkColNames: string[] = [];
              for (const pkCol of pkCols) {
                const name = getName(pkCol);
                pkColNames.push(name);
                const col = columns.find(c => c.name === name);
                if (col) {
                  col.isPK = true;
                  col.isNullable = false;
                }
              }
              if (pkColNames.length > 1) {
                indexes.push({
                  name: cAny.constraintName ? getName(cAny.constraintName) : undefined,
                  columns: pkColNames,
                  isUnique: true,
                  fromConstraint: true,
                });
              }
            } else if (cAny.type === 'unique') {
              const uqCols: any[] = cAny.columns || [];
              const uqColNames = uqCols.map(getName);
              uqColNames.forEach((name) => {
                const col = columns.find(c => c.name === name);
                if (col) col.isUnique = true;
              });
              indexes.push({
                name: cAny.constraintName ? getName(cAny.constraintName) : undefined,
                columns: uqColNames,
                isUnique: true,
                fromConstraint: true,
              });
            }
          }
        }

        const table: Table = { name: tableName, schema, columns, indexes, comment: extractComment(stmt) };
        tables.push(table);
        tablesByKey.set(tableKey(schema, tableName), table);
      } else if (stmt.type === 'create index') {
        pendingIndexStatements.push(stmt);
      } else if (stmt.type === 'alter table') {
        pendingAlterStatements.push(stmt);
      }
    }
  }

  // Resolve CREATE INDEX statements against the tables collected above.
  for (const stmt of pendingIndexStatements) {
    const sAny = stmt as any;
    const onTable = sAny.table || sAny.on;
    const schema = onTable?.schema ? getName(onTable.schema) : undefined;
    const tableName = getName(onTable);
    const table =
      tablesByKey.get(tableKey(schema, tableName)) ??
      [...tablesByKey.values()].find(t => t.name.toLowerCase() === tableName.toLowerCase());

    if (!table) continue;

    const indexCols: any[] = sAny.expressions || sAny.columns || [];
    const columnNames = indexCols
      .map((e: any) => getName(e.expression ?? e.name ?? e))
      .filter(Boolean);
    if (columnNames.length === 0) continue;

    const indexName = sAny.indexName || sAny.name ? getName(sAny.indexName || sAny.name) : undefined;
    const isUnique = Boolean(sAny.unique);

    table.indexes = table.indexes || [];
    table.indexes.push({ name: indexName, columns: columnNames, isUnique });

    if (isUnique) {
      columnNames.forEach((name) => {
        const col = table.columns.find(c => c.name === name);
        if (col) col.isUnique = true;
      });
    }
  }

  // Resolve ALTER TABLE ... ADD CONSTRAINT (FK / UNIQUE / PK) statements.
  for (const stmt of pendingAlterStatements) {
    const schema = stmt.table?.schema ? getName(stmt.table.schema) : undefined;
    const tableName = getName(stmt.table);
    const table =
      tablesByKey.get(tableKey(schema, tableName)) ??
      [...tablesByKey.values()].find(t => t.name.toLowerCase() === tableName.toLowerCase());

    const changes: any[] = stmt.changes || [];
    for (const change of changes) {
      const constraint: any = change.constraint ?? change;
      if (!constraint || !constraint.type) continue;

      const typeStr = String(constraint.type).toLowerCase();

      if (typeStr === 'foreign key' || typeStr === 'foreign_key') {
        const sourceCols: any[] = constraint.localColumns || constraint.columns || [];
        const targetCols: any[] = constraint.foreignColumns || constraint.references?.columns || [];
        const targetTable = getName(
          constraint.foreignTable || constraint.references?.table || constraint.table
        );
        for (let i = 0; i < sourceCols.length; i++) {
          const sourceColName = getName(sourceCols[i]);
          const targetColName = getName(targetCols[i] ?? targetCols[0]);
          if (targetTable && targetColName && tableName) {
            relationships.push({
              sourceTable: tableName,
              sourceColumn: sourceColName,
              targetTable,
              targetColumn: targetColName,
              constraintName: constraint.constraintName ? getName(constraint.constraintName) : undefined,
              onDelete: constraint.onDelete ? String(constraint.onDelete).toUpperCase() : undefined,
              onUpdate: constraint.onUpdate ? String(constraint.onUpdate).toUpperCase() : undefined,
            });
            if (table) {
              const col = table.columns.find(c => c.name === sourceColName);
              if (col) col.isFKSource = true;
            }
          }
        }
      } else if (typeStr === 'unique' && table) {
        const uqCols: any[] = constraint.columns || [];
        const uqColNames = uqCols.map(getName);
        uqColNames.forEach((name) => {
          const col = table.columns.find(c => c.name === name);
          if (col) col.isUnique = true;
        });
        table.indexes = table.indexes || [];
        table.indexes.push({
          name: constraint.constraintName ? getName(constraint.constraintName) : undefined,
          columns: uqColNames,
          isUnique: true,
          fromConstraint: true,
        });
      } else if (typeStr === 'primary key' && table) {
        const pkCols: any[] = constraint.columns || [];
        pkCols.forEach((pkCol) => {
          const name = getName(pkCol);
          const col = table.columns.find(c => c.name === name);
          if (col) {
            col.isPK = true;
            col.isNullable = false;
          }
        });
      }
    }
  }

  if (tables.length === 0) {
    throw new Error('No se encontraron sentencias CREATE TABLE válidas. Revisa el DDL.');
  }

  return { tables, relationships };
}