import { parse } from 'pgsql-ast-parser';
import { ParsedSchema, Table, Column, Relationship, IndexInfo, TriggerInfo, Procedure, ProcedureTableOperation } from './types';

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
  const procedures: Procedure[] = [];

 // CREATE INDEX statements are collected separately because they can
  // appear before or after the CREATE TABLE in the script.
  const pendingIndexStatements: any[] = [];
  // ALTER TABLE ... ADD CONSTRAINT (FK/UNIQUE/PK) added after table creation.
  const pendingAlterStatements: any[] = [];
  // CREATE TRIGGER statements collected separately.
  const pendingTriggerStatements: any[] = [];
  // CREATE FUNCTION statements that return TRIGGER, keyed by lowercased
  // function name so lookups from CREATE TRIGGER (regex fallback) match
  // regardless of the casing used in either statement.
  const triggerFunctions = new Map<string, { name: string; code: string; returns: string }>();
  // Pending procedure/function statements for later processing
  const pendingProcedureStatements: any[] = [];

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
      } else if (stmt.type === 'create trigger') {
        pendingTriggerStatements.push(stmt);
      } else if (stmt.type === 'create function') {
        // Guardar funciones que retornan TRIGGER para vincularlas con
        // los triggers que las invoquen (getDataTypeString no aplica aquí
        // porque `returns` para funciones es un DataTypeDef simple, no
        // una columna, así que basta con leer `.name`).
        const funcName = getName(stmt.name);
        const returns = stmt.returns && 'name' in stmt.returns
          ? String((stmt.returns as any).name).toUpperCase()
          : '';
        if (returns === 'TRIGGER' && funcName) {
          triggerFunctions.set(funcName.toLowerCase(), {
            name: funcName,
            code: stmt.code || '',
            returns,
          });
        } else {
          // Procedimientos almacenados (funciones regulares) - guardarlos para procesar después
          pendingProcedureStatements.push(stmt);
        }
      } else if (stmt.type === 'create procedure') {
        // Soporte explícito para CREATE PROCEDURE (PostgreSQL 11+)
        pendingProcedureStatements.push(stmt);
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

  // Helper: given a raw "function()" / "schema.function(args)" string,
  // find its code among the CREATE FUNCTION ... RETURNS TRIGGER statements
  // collected earlier. Strips arguments/parens and schema qualification
  // before doing a case-insensitive lookup.
  const resolveTriggerFunctionCode = (rawFuncName: string): string | undefined => {
    const bare = rawFuncName.replace(/\(.*$/, '').trim(); // drop "(args)"
    const unqualified = bare.includes('.') ? bare.split('.').pop()! : bare;
    return triggerFunctions.get(unqualified.toLowerCase())?.code;
  };

  // Resolve CREATE TRIGGER statements. pgsql-ast-parser 12.0.2 does not
  // support the CREATE TRIGGER grammar at all (it throws and the whole
  // statement is skipped by the outer try/catch), so `pendingTriggerStatements`
  // will normally stay empty. We fall back to a regex-based parser run
  // against the full raw SQL so triggers still show up in the diagram.
  // The AST-based loop below is kept as a forward-compatible path in case
  // a future version of the library (or a different parser) does populate
  // `pendingTriggerStatements`.
  const triggerRegex =
    /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)(?:\s+OR\s+(INSERT|UPDATE|DELETE))?(?:\s+OR\s+(INSERT|UPDATE|DELETE))?\s+ON\s+(?:[\w"]+\.)?(\w+)(?:\s+FOR\s+EACH\s+(ROW|STATEMENT))?\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([\w".]+)\s*\(/gi;

  const triggersHandledByRegex = new Set<string>();

  for (const match of sql.matchAll(triggerRegex)) {
    const [, triggerName, timingRaw, ev1, ev2, ev3, tableName, forEachRaw, rawFuncName] = match;

    const table = [...tablesByKey.values()].find(
      t => t.name.toLowerCase() === tableName.toLowerCase()
    );
    if (!table) continue;

    const timing = timingRaw.toUpperCase().replace(/\s+/g, ' ');
    const events = [ev1, ev2, ev3].filter(Boolean).map(e => e.toUpperCase());
    const forEachRow = (forEachRaw || '').toUpperCase() === 'ROW';
    const functionLabel = `${rawFuncName}()`;
    const functionCode = resolveTriggerFunctionCode(rawFuncName);

    table.triggers = table.triggers || [];
    table.triggers.push({
      name: triggerName,
      timing,
      events,
      onTable: table.name,
      function: functionLabel,
      forEachRow,
      functionCode,
    });

    triggersHandledByRegex.add(triggerName.toLowerCase());
  }

  // Resolve CREATE TRIGGER statements that the AST parser *did* manage to
  // produce (currently a no-op with pgsql-ast-parser 12.0.2, kept for when
  // the library adds support or is swapped out). Skips anything the regex
  // fallback above already added, to avoid duplicate trigger entries.
  for (const stmt of pendingTriggerStatements) {
    const sAny = stmt as any;
    const onTable = sAny.table || sAny.on;
    const schema = onTable?.schema ? getName(onTable.schema) : undefined;
    const tableName = getName(onTable);
    const table =
      tablesByKey.get(tableKey(schema, tableName)) ??
      [...tablesByKey.values()].find(t => t.name.toLowerCase() === tableName.toLowerCase());

    if (!table) continue;

    const triggerName = sAny.triggerName || sAny.name ? getName(sAny.triggerName || sAny.name) : undefined;
    if (triggerName && triggersHandledByRegex.has(triggerName.toLowerCase())) continue;

    const timing = sAny.timing ? String(sAny.timing).toUpperCase() : 'UNKNOWN';
    const events: string[] = [];
    if (sAny.events) {
      const evArray = Array.isArray(sAny.events) ? sAny.events : [sAny.events];
      evArray.forEach((ev: any) => {
        const evStr = String(ev).toUpperCase();
        if (evStr && !events.includes(evStr)) events.push(evStr);
      });
    }
    const funcName = sAny.functionCall?.name 
      ? `${getName(sAny.functionCall.name)}(${(sAny.functionCall.args || []).map((a: any) => String(a)).join(', ')})`
      : (sAny.functionName ? `${getName(sAny.functionName)}()` : 'UNKNOWN');
    const forEachRow = Boolean(sAny.forEach === 'row' || sAny.forEachRow);
    const whenClause = sAny.when ? String(sAny.when) : undefined;
    const functionCode = resolveTriggerFunctionCode(funcName);

    table.triggers = table.triggers || [];
    table.triggers.push({
      name: triggerName,
      timing,
      events,
      onTable: tableName,
      function: funcName,
      forEachRow,
      when: whenClause,
      functionCode,
    });
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

  // Procesar procedimientos almacenados y funciones (CREATE FUNCTION / CREATE PROCEDURE)
  for (const stmt of pendingProcedureStatements) {
    const procName = getName(stmt.name);
    const schema = stmt.name?.schema ? getName(stmt.name.schema) : undefined;
    
    // Extraer parámetros
    const parameters: string[] = [];
    if (stmt.args && Array.isArray(stmt.args)) {
      for (const arg of stmt.args) {
        const paramName = arg.name ? getName(arg.name) : '';
        const paramType = getDataTypeString(arg.dataType || arg.type || arg);
        const mode = arg.mode ? String(arg.mode).toUpperCase() : 'IN';
        if (paramName || paramType !== 'UNKNOWN') {
          parameters.push(`${mode} ${paramName} ${paramType}`.trim());
        }
      }
    }

    // Tipo de retorno
    let returnType: string | undefined;
    if (stmt.returns) {
      returnType = getDataTypeString(stmt.returns);
    }

    // Lenguaje
    const language = stmt.language ? String(stmt.language).toUpperCase() : 'SQL';

    // Código del procedimiento
    const code = stmt.code || stmt.body || '';

    // Analizar el código para detectar operaciones INSERT, UPDATE, DELETE, SELECT en tablas
    const affectedTables: ProcedureTableOperation[] = [];
    const tableNamesLower = new Map(tables.map(t => [t.name.toLowerCase(), t.name]));

    // Buscar patrones de operaciones en el código
    const codeUpper = code.toUpperCase();
    
    // Patrones regex para detectar operaciones
    const insertPattern = /INSERT\s+INTO\s+(\w+)/gi;
    const updatePattern = /UPDATE\s+(\w+)/gi;
    const deletePattern = /DELETE\s+FROM\s+(\w+)/gi;
    const selectPattern = /SELECT\s+.*?\s+FROM\s+(\w+)/gi;

    let match;

    while ((match = insertPattern.exec(code)) !== null) {
      const tableName = match[1];
      const lowerName = tableName.toLowerCase();
      if (tableNamesLower.has(lowerName) && !affectedTables.some(t => t.tableName === tableNamesLower.get(lowerName) && t.operationType === 'INSERT')) {
        affectedTables.push({ tableName: tableNamesLower.get(lowerName)!, operationType: 'INSERT' });
      }
    }

    while ((match = updatePattern.exec(code)) !== null) {
      const tableName = match[1];
      const lowerName = tableName.toLowerCase();
      if (tableNamesLower.has(lowerName) && !affectedTables.some(t => t.tableName === tableNamesLower.get(lowerName) && t.operationType === 'UPDATE')) {
        affectedTables.push({ tableName: tableNamesLower.get(lowerName)!, operationType: 'UPDATE' });
      }
    }

    while ((match = deletePattern.exec(code)) !== null) {
      const tableName = match[1];
      const lowerName = tableName.toLowerCase();
      if (tableNamesLower.has(lowerName) && !affectedTables.some(t => t.tableName === tableNamesLower.get(lowerName) && t.operationType === 'DELETE')) {
        affectedTables.push({ tableName: tableNamesLower.get(lowerName)!, operationType: 'DELETE' });
      }
    }

    while ((match = selectPattern.exec(code)) !== null) {
      const tableName = match[1];
      const lowerName = tableName.toLowerCase();
      if (tableNamesLower.has(lowerName) && !affectedTables.some(t => t.tableName === tableNamesLower.get(lowerName) && t.operationType === 'SELECT')) {
        affectedTables.push({ tableName: tableNamesLower.get(lowerName)!, operationType: 'SELECT' });
      }
    }

    procedures.push({
      name: procName,
      schema,
      parameters: parameters.length > 0 ? parameters : undefined,
      returnType,
      language,
      code,
      affectedTables,
      comment: extractComment(stmt),
    });
  }

  if (tables.length === 0) {
    throw new Error('No se encontraron sentencias CREATE TABLE válidas. Revisa el DDL.');
  }

  return { tables, relationships, procedures };
}