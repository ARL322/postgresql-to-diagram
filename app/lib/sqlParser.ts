import { parse } from 'pgsql-ast-parser';
import { ParsedSchema, Table, Column, Relationship, IndexInfo, TriggerInfo, Procedure, ProcedureTableOperation, ProcedureVariable } from './types';

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

  // Capturar longitud o precisión si existen en el AST (ej. VARCHAR(255), NUMERIC(10,2))
  if (dataType.config && Array.isArray(dataType.config)) {
    const params = dataType.config.map((c: any) => c.value ?? c).filter(Boolean);
    if (params.length) return `${baseType}(${params.join(',')})`;
  } else if (dataType.length !== undefined) {
    return `${baseType}(${dataType.length})`;
  }
  return baseType;
}

// Best-effort rendering of a DEFAULT expression back to readable SQL text.
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
      if (expr.value !== undefined) return String(expr.value);
      if (expr.name) return getName(expr.name);
      return undefined;
  }
}

function extractComment(stmt: any): string | undefined {
  return stmt?.comment ? String(stmt.comment).trim() : undefined;
}

// Split a SQL script into individual top-level statements (on ';')
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

// ==================== VARIABLES INTERNAS (DECLARE) ====================
// Estas funciones extraen las variables declaradas dentro del bloque
// DECLARE ... BEGIN de un procedimiento/función PL/pgSQL. Son distintas
// de los parámetros: los parámetros vienen de la firma de la función
// (entre paréntesis), mientras que las variables se declaran en el
// cuerpo del código, antes del BEGIN principal.

// Elimina comentarios de línea (--) y de bloque (/* */) sin tocar el
// contenido de literales de cadena, para no confundir el parseo posterior.
function stripSqlComments(code: string): string {
  let result = '';
  let i = 0;
  let inSingleQuote = false;

  while (i < code.length) {
    const ch = code[i];

    if (inSingleQuote) {
      result += ch;
      if (ch === "'") {
        if (code[i + 1] === "'") {
          result += code[i + 1];
          i += 2;
          continue;
        }
        inSingleQuote = false;
      }
      i++;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === '-' && code[i + 1] === '-') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// Aísla el contenido del bloque DECLARE (entre la palabra clave DECLARE
// y el primer BEGIN principal del cuerpo). Devuelve null si no hay
// bloque DECLARE (p.ej. funciones sin variables internas).
function extractDeclareBlockText(code: string): string | null {
  const clean = stripSqlComments(code);
  const declareMatch = /\bDECLARE\b/i.exec(clean);
  if (!declareMatch) return null;

  const afterDeclare = clean.slice(declareMatch.index + declareMatch[0].length);
  const beginMatch = /\bBEGIN\b/i.exec(afterDeclare);
  if (!beginMatch) return null;

  return afterDeclare.slice(0, beginMatch.index);
}

// Separa una declaración normalizada del tipo `nombre [CONSTANT] tipo [NOT NULL] [(:= | DEFAULT) expr]`
// en su parte de nombre/tipo y, opcionalmente, su valor por defecto.
function splitDeclarationDefault(normalized: string): { namePart: string; defaultValue?: string } {
  const assignMatch = /:=/.exec(normalized);
  const defaultKeywordMatch = /\bDEFAULT\b/i.exec(normalized);

  let splitIdx = -1;
  let operatorLength = 0;

  if (assignMatch && (!defaultKeywordMatch || assignMatch.index < defaultKeywordMatch.index)) {
    splitIdx = assignMatch.index;
    operatorLength = 2; // ':='
  } else if (defaultKeywordMatch) {
    splitIdx = defaultKeywordMatch.index;
    operatorLength = defaultKeywordMatch[0].length; // 'DEFAULT'
  }

  if (splitIdx === -1) {
    return { namePart: normalized.trim() };
  }

  return {
    namePart: normalized.slice(0, splitIdx).trim(),
    defaultValue: normalized.slice(splitIdx + operatorLength).trim(),
  };
}

// Extrae las variables declaradas en el bloque DECLARE del cuerpo de un
// procedimiento/función, excluyendo cualquier nombre que ya sea un
// parámetro (para mantener ambos conceptos completamente separados).
export function extractDeclaredVariables(code: string, paramNames: string[] = []): ProcedureVariable[] {
  const block = extractDeclareBlockText(code || '');
  if (!block) return [];

  const paramNamesLower = new Set(paramNames.map((p) => p.toLowerCase()));
  const variables: ProcedureVariable[] = [];
  const seenNames = new Set<string>();

  // Separa por ';' respetando paréntesis anidados (tipos como NUMERIC(10,2))
  const rawDecls: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of block) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) {
      if (current.trim()) rawDecls.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) rawDecls.push(current.trim());

  for (const rawDecl of rawDecls) {
    const normalized = rawDecl.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;

    const { namePart, defaultValue } = splitDeclarationDefault(normalized);
    const namePartClean = namePart.replace(/\bNOT\s+NULL\b/i, '').trim();

    const nameTypeMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s+(CONSTANT\s+)?([\s\S]+)$/i.exec(namePartClean);
    if (!nameTypeMatch) continue;

    const name = nameTypeMatch[1];
    const nameLower = name.toLowerCase();

    // Nunca mezclar con parámetros, y evitar duplicados si aparece más de una vez
    if (paramNamesLower.has(nameLower) || seenNames.has(nameLower)) continue;

    const isConstant = Boolean(nameTypeMatch[2]);
    const type = nameTypeMatch[3].trim();
    if (!type) continue;

    seenNames.add(nameLower);
    variables.push({
      name,
      type: type.toUpperCase(),
      defaultValue,
      isConstant,
    });
  }

  return variables;
}

// Obtiene los nombres "puros" de los parámetros a partir de las cadenas
// formateadas (p.ej. "IN p_id_cliente INTEGER" o "p_id_cliente INTEGER"),
// para poder excluirlos al detectar variables internas.
function extractParamNames(parameters: string[] | undefined): string[] {
  if (!parameters || parameters.length === 0) return [];
  const modes = new Set(['IN', 'OUT', 'INOUT', 'VARIADIC']);

  return parameters
    .map((param) => {
      const tokens = param.trim().split(/\s+/);
      if (tokens.length === 0) return '';
      let idx = 0;
      if (modes.has(tokens[0]?.toUpperCase())) idx = 1;
      return tokens[idx] || '';
    })
    .filter(Boolean);
}

// Detecta a qué tablas afecta el cuerpo de un procedimiento/función
// (INSERT/UPDATE/DELETE/SELECT) y construye el objeto Procedure final.
// Se usa tanto para procedimientos parseados vía AST como para los
// capturados por el regex de respaldo (ver más abajo).
function buildProcedure(
  tables: Table[],
  procName: string,
  schema: string | undefined,
  parameters: string[],
  returnType: string | undefined,
  language: string,
  code: string,
  comment: string | undefined
): Procedure {
  const affectedTables: ProcedureTableOperation[] = [];
  const tableNamesLower = new Map(tables.map(t => [t.name.toLowerCase(), t.name]));

  const insertPattern = /INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const updatePattern = /UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const deletePattern = /DELETE\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const selectPattern = /FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;

  let match;

  while ((match = insertPattern.exec(code)) !== null) {
    const lowerName = match[1].toLowerCase();
    if (tableNamesLower.has(lowerName) && !affectedTables.some(t => t.tableName === tableNamesLower.get(lowerName) && t.operationType === 'INSERT')) {
      affectedTables.push({ tableName: tableNamesLower.get(lowerName)!, operationType: 'INSERT' });
    }
  }

  while ((match = updatePattern.exec(code)) !== null) {
    const lowerName = match[1].toLowerCase();
    if (tableNamesLower.has(lowerName) && !affectedTables.some(t => t.tableName === tableNamesLower.get(lowerName) && t.operationType === 'UPDATE')) {
      affectedTables.push({ tableName: tableNamesLower.get(lowerName)!, operationType: 'UPDATE' });
    }
  }

  while ((match = deletePattern.exec(code)) !== null) {
    const lowerName = match[1].toLowerCase();
    if (tableNamesLower.has(lowerName) && !affectedTables.some(t => t.tableName === tableNamesLower.get(lowerName) && t.operationType === 'DELETE')) {
      affectedTables.push({ tableName: tableNamesLower.get(lowerName)!, operationType: 'DELETE' });
    }
  }

  while ((match = selectPattern.exec(code)) !== null) {
    const lowerName = match[1].toLowerCase();
    if (tableNamesLower.has(lowerName) && !affectedTables.some(t => t.tableName === tableNamesLower.get(lowerName))) {
      affectedTables.push({ tableName: tableNamesLower.get(lowerName)!, operationType: 'SELECT' });
    }
  }

  // Variables internas (DECLARE), siempre separadas de los parámetros.
  const paramNames = extractParamNames(parameters);
  const variables = extractDeclaredVariables(code, paramNames);

  return {
    name: procName,
    schema,
    parameters: parameters.length > 0 ? parameters : undefined,
    variables: variables.length > 0 ? variables : undefined,
    returnType,
    language,
    code,
    affectedTables,
    comment,
  };
}

// Parseo de respaldo por regex para CREATE (OR REPLACE) PROCEDURE.
// pgsql-ast-parser no soporta de forma fiable la sintaxis PROCEDURE de
// Postgres (nace en PG11 y esta librería está enfocada en FUNCTION /
// PL/pgSQL parcial), así que parse() lanza una excepción para estas
// sentencias y se pierden silenciosamente si no las capturamos aquí.
const procedureRegex =
  /CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[\w"]+\.)?[\w"]+)\s*\(([\s\S]*?)\)\s*LANGUAGE\s+([\w"]+)[\s\S]*?AS\s*(\$[a-zA-Z_]*\$)([\s\S]*?)\4/gi;

function extractRegexProcedures(sql: string, alreadyHandledNames: Set<string>): {
  procName: string;
  schema: string | undefined;
  parameters: string[];
  returnType: string;
  language: string;
  code: string;
}[] {
  const results: ReturnType<typeof extractRegexProcedures> = [];

  for (const match of sql.matchAll(procedureRegex)) {
    const [, rawName, rawArgs, rawLanguage, , code] = match;

    const cleanName = rawName.replace(/"/g, '');
    const parts = cleanName.split('.');
    const schema = parts.length > 1 ? parts[0] : undefined;
    const procName = parts.length > 1 ? parts[1] : parts[0];

    if (alreadyHandledNames.has(procName.toLowerCase())) continue;

    // Divide la lista de parámetros respetando paréntesis anidados (tipos como NUMERIC(10,2))
    const parameters: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of rawArgs) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        if (current.trim()) parameters.push(current.trim().replace(/\s+/g, ' '));
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) parameters.push(current.trim().replace(/\s+/g, ' '));

    results.push({
      procName,
      schema,
      parameters,
      returnType: 'PROCEDURE',
      language: rawLanguage.toUpperCase(),
      code: code || '',
    });
  }

  return results;
}

export function parsePostgresSQL(sql: string): ParsedSchema {
  const tables: Table[] = [];
  const tablesByKey = new Map<string, Table>();
  const relationships: Relationship[] = [];
  const procedures: Procedure[] = [];

  const pendingIndexStatements: any[] = [];
  const pendingAlterStatements: any[] = [];
  const pendingTriggerStatements: any[] = [];
  const triggerFunctions = new Map<string, { name: string; code: string; returns: string }>();
  const pendingProcedureStatements: any[] = [];

  const statements = splitStatements(sql);

  for (const rawStmt of statements) {
    const stmtText = rawStmt.trim();
    if (!stmtText) continue;

    let stmtAst: any[];
    try {
      stmtAst = parse(stmtText) as any[];
    } catch {
      continue;
    }

    for (const stmt of stmtAst) {
      if (stmt.type === 'create table' || (stmt as any).type === 'create table if not exists') {
        const tableName = getName(stmt.name);
        const schema = stmt.name?.schema ? getName(stmt.name.schema) : undefined;
        const columns: Column[] = [];
        const indexes: IndexInfo[] = [];

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
      } else if (stmt.type === 'create function' || stmt.type === 'create procedure') {
        // CORRECCIÓN: Capturamos bajo la misma condición madre unificada
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
          pendingProcedureStatements.push(stmt);
        }
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

  const resolveTriggerFunctionCode = (rawFuncName: string): string | undefined => {
    const bare = rawFuncName.replace(/\(.*$/, '').trim();
    const unqualified = bare.includes('.') ? bare.split('.').pop()! : bare;
    return triggerFunctions.get(unqualified.toLowerCase())?.code;
  };

  // Fallback Regex-based trigger extractor
  const triggerRegex =
    /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)(?:\s+OR\s+(INSERT|UPDATE|DELETE))?(?:\s+OR\s+(INSERT|UPDATE|DELETE))?[\s\S]*?\s+ON\s+(?:[\w"]+\.)?(\w+)(?:[\s\S]*?\s+FOR\s+EACH\s+(ROW|STATEMENT))?[\s\S]*?\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([\w".]+)\s*\(/gi;

  const triggersHandledByRegex = new Set<string>();

  for (const match of sql.matchAll(triggerRegex)) {
    const [, triggerName, timingRaw, ev1, ev2, ev3, tableName, forEachRaw, rawFuncName] = match;

    const table = [...tablesByKey.values()].find(
      t => t.name.toLowerCase() === tableName.toLowerCase()
    );
    if (!table) continue;

    // Skip if already handled by AST processing
    if (table.triggers?.some(t => t.name && t.name.toLowerCase() === triggerName.toLowerCase())) {
      continue;
    }

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

  // Resolve ALTER TABLE ... ADD CONSTRAINT statements.
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
    // NOTA: pgsql-ast-parser expone los parámetros de CREATE FUNCTION bajo la
    // propiedad "arguments" (no "args"). Antes se leía "stmt.args", que
    // siempre era undefined para funciones parseadas vía AST, así que los
    // parámetros nunca se capturaban. Se mantiene "args" como fallback por
    // si alguna otra ruta los deja ahí.
    const parameters: string[] = [];
    const rawArgs = stmt.arguments || stmt.args;
    if (rawArgs && Array.isArray(rawArgs)) {
      for (const arg of rawArgs) {
        const paramName = arg.name ? getName(arg.name) : '';
        const paramType = getDataTypeString(arg.type || arg.dataType || arg);
        const mode = arg.mode ? String(arg.mode).toUpperCase() : 'IN';
        if (paramName || paramType !== 'UNKNOWN') {
          parameters.push(`${mode} ${paramName} ${paramType}`.trim());
        }
      }
    }

    // CORRECCIÓN CARDINAL: Si el AST no tiene tipo de retorno (es un PROCEDURE Puro), asignamos "PROCEDURE"
    let returnType: string | undefined = 'PROCEDURE';
    if (stmt.returns) {
      returnType = getDataTypeString(stmt.returns);
    }

    const language = stmt.language ? String(stmt.language).toUpperCase() : 'PLPGSQL';
    const code = stmt.code || stmt.body || '';

    procedures.push(
      buildProcedure(tables, procName, schema, parameters, returnType, language, code, extractComment(stmt))
    );
  }

  // Fallback: capturar por regex los CREATE PROCEDURE que pgsql-ast-parser
  // no pudo parsear (ver comentario en extractRegexProcedures). Evitamos
  // duplicar los que ya se resolvieron correctamente vía AST.
  const handledProcNames = new Set(procedures.map(p => p.name.toLowerCase()));
  for (const regexProc of extractRegexProcedures(sql, handledProcNames)) {
    procedures.push(
      buildProcedure(
        tables,
        regexProc.procName,
        regexProc.schema,
        regexProc.parameters,
        regexProc.returnType,
        regexProc.language,
        regexProc.code,
        undefined
      )
    );
  }

  if (tables.length === 0) {
    throw new Error('No se encontraron sentencias CREATE TABLE válidas. Revisa el DDL.');
  }

  return { tables, relationships, procedures };
}