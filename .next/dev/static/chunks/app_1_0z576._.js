(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/app/lib/sqlParser.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "buildHandleId",
    ()=>buildHandleId,
    "parsePostgresSQL",
    ()=>parsePostgresSQL,
    "sanitizeId",
    ()=>sanitizeId
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$pgsql$2d$ast$2d$parser$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/pgsql-ast-parser/index.js [app-client] (ecmascript)");
;
//
function getName(name) {
    if (!name) return '';
    if (typeof name === 'string') return name.trim();
    if (name?.name) return String(name.name).trim();
    return String(name).trim();
}
function sanitizeId(str) {
    return str.replace(/[^a-zA-Z0-9_-]/g, '_');
}
function buildHandleId(nodeId, columnName, side) {
    return `${sanitizeId(`${nodeId}-${columnName}`).toLowerCase()}-${side}`;
}
// Qualified key used to match a table regardless of whether the schema
// prefix was used when referencing it later (e.g. in CREATE INDEX or FK).
function tableKey(schema, name) {
    return `${(schema ?? '').toLowerCase()}::${name.toLowerCase()}`;
}
function getDataTypeString(dataType) {
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
        const params = dataType.config.map((c)=>c.value ?? c).filter(Boolean);
        if (params.length) return `${baseType}(${params.join(',')})`;
    } else if (dataType.length !== undefined) {
        return `${baseType}(${dataType.length})`;
    }
    return baseType;
}
// Best-effort rendering of a DEFAULT expression back to readable SQL text.
// pgsql-ast-parser expression nodes vary a lot in shape, so this stays
// defensive and falls back gracefully instead of throwing.
function getDefaultValueString(expr) {
    if (expr === undefined || expr === null) return undefined;
    if (typeof expr === 'string') return expr;
    if (typeof expr === 'number' || typeof expr === 'boolean') return String(expr);
    switch(expr.type){
        case 'string':
            return `'${expr.value}'`;
        case 'numeric':
        case 'integer':
            return String(expr.value);
        case 'boolean':
            return String(expr.value);
        case 'null':
            return 'NULL';
        case 'call':
            {
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
function extractComment(stmt) {
    // pgsql-ast-parser doesn't always retain leading SQL comments on the
    // statement node itself, so this is intentionally tolerant.
    return stmt?.comment ? String(stmt.comment).trim() : undefined;
}
// Split a SQL script into individual top-level statements (on ';'),
// respecting single-quoted strings (with '' escaping), double-quoted
// identifiers, dollar-quoted strings ($$...$$ / $tag$...$tag$), and
// parenthesis nesting so semicolons inside those don't split early.
function splitStatements(sql) {
    const statements = [];
    let current = '';
    let i = 0;
    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let dollarTag = null;
    while(i < sql.length){
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
function parsePostgresSQL(sql) {
    const tables = [];
    // Map from "schema::table" (lowercased) -> Table, so CREATE INDEX /
    // ALTER TABLE statements that reference a table can find it later
    // regardless of statement order.
    const tablesByKey = new Map();
    const relationships = [];
    // CREATE INDEX statements are collected separately because they can
    // appear before or after the CREATE TABLE in the script.
    const pendingIndexStatements = [];
    // ALTER TABLE ... ADD CONSTRAINT (FK/UNIQUE/PK) added after table creation.
    const pendingAlterStatements = [];
    const statements = splitStatements(sql);
    for (const rawStmt of statements){
        const stmtText = rawStmt.trim();
        if (!stmtText) continue;
        let stmtAst;
        try {
            stmtAst = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$pgsql$2d$ast$2d$parser$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["parse"])(stmtText);
        } catch  {
            continue;
        }
        for (const stmt of stmtAst){
            if (stmt.type === 'create table') {
                const tableName = getName(stmt.name);
                const schema = stmt.name?.schema ? getName(stmt.name.schema) : undefined;
                const columns = [];
                const indexes = [];
                // Pass 1: extract columns + inline PK/FK/UNIQUE/NOT NULL/DEFAULT
                if (stmt.columns) {
                    for (const col of stmt.columns){
                        if (col.kind === 'column') {
                            let isPK = false;
                            let isFKSource = false;
                            let isUnique = false;
                            let isNullable = true;
                            let defaultValue;
                            const colName = getName(col.name);
                            if (col.constraints) {
                                for (const c of col.constraints){
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
                                        const targetTable = getName(c.foreignTable || c.references?.table || c.table);
                                        const targetCol = getName(c.foreignColumns?.[0] || c.references?.columns?.[0] || c.columns?.[0]);
                                        if (targetTable && targetCol) {
                                            relationships.push({
                                                sourceTable: tableName,
                                                sourceColumn: colName,
                                                targetTable,
                                                targetColumn: targetCol,
                                                constraintName: c.constraintName ? getName(c.constraintName) : undefined,
                                                onDelete: c.onDelete ? String(c.onDelete).toUpperCase() : undefined,
                                                onUpdate: c.onUpdate ? String(c.onUpdate).toUpperCase() : undefined
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
                                defaultValue
                            });
                            if (isUnique && !isPK) {
                                indexes.push({
                                    columns: [
                                        colName
                                    ],
                                    isUnique: true,
                                    fromConstraint: true
                                });
                            }
                        }
                    }
                }
                // Pass 2: table-level constraints (PK, FK, UNIQUE)
                if (stmt.constraints) {
                    for (const constraint of stmt.constraints){
                        const cAny = constraint;
                        if (cAny.type === 'foreign key' || cAny.type === 'foreign_key') {
                            const sourceCols = cAny.localColumns || cAny.columns || [];
                            const targetCols = cAny.foreignColumns || cAny.references?.columns || [];
                            const targetTable = getName(cAny.foreignTable || cAny.references?.table || cAny.table);
                            for(let i = 0; i < sourceCols.length; i++){
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
                                        onUpdate: cAny.onUpdate ? String(cAny.onUpdate).toUpperCase() : undefined
                                    });
                                    const col = columns.find((c)=>c.name === sourceColName);
                                    if (col) col.isFKSource = true;
                                }
                            }
                        } else if (cAny.type === 'primary key') {
                            const pkCols = cAny.columns || [];
                            const pkColNames = [];
                            for (const pkCol of pkCols){
                                const name = getName(pkCol);
                                pkColNames.push(name);
                                const col = columns.find((c)=>c.name === name);
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
                                    fromConstraint: true
                                });
                            }
                        } else if (cAny.type === 'unique') {
                            const uqCols = cAny.columns || [];
                            const uqColNames = uqCols.map(getName);
                            uqColNames.forEach((name)=>{
                                const col = columns.find((c)=>c.name === name);
                                if (col) col.isUnique = true;
                            });
                            indexes.push({
                                name: cAny.constraintName ? getName(cAny.constraintName) : undefined,
                                columns: uqColNames,
                                isUnique: true,
                                fromConstraint: true
                            });
                        }
                    }
                }
                const table = {
                    name: tableName,
                    schema,
                    columns,
                    indexes,
                    comment: extractComment(stmt)
                };
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
    for (const stmt of pendingIndexStatements){
        const sAny = stmt;
        const onTable = sAny.table || sAny.on;
        const schema = onTable?.schema ? getName(onTable.schema) : undefined;
        const tableName = getName(onTable);
        const table = tablesByKey.get(tableKey(schema, tableName)) ?? [
            ...tablesByKey.values()
        ].find((t)=>t.name.toLowerCase() === tableName.toLowerCase());
        if (!table) continue;
        const indexCols = sAny.expressions || sAny.columns || [];
        const columnNames = indexCols.map((e)=>getName(e.expression ?? e.name ?? e)).filter(Boolean);
        if (columnNames.length === 0) continue;
        const indexName = sAny.indexName || sAny.name ? getName(sAny.indexName || sAny.name) : undefined;
        const isUnique = Boolean(sAny.unique);
        table.indexes = table.indexes || [];
        table.indexes.push({
            name: indexName,
            columns: columnNames,
            isUnique
        });
        if (isUnique) {
            columnNames.forEach((name)=>{
                const col = table.columns.find((c)=>c.name === name);
                if (col) col.isUnique = true;
            });
        }
    }
    // Resolve ALTER TABLE ... ADD CONSTRAINT (FK / UNIQUE / PK) statements.
    for (const stmt of pendingAlterStatements){
        const schema = stmt.table?.schema ? getName(stmt.table.schema) : undefined;
        const tableName = getName(stmt.table);
        const table = tablesByKey.get(tableKey(schema, tableName)) ?? [
            ...tablesByKey.values()
        ].find((t)=>t.name.toLowerCase() === tableName.toLowerCase());
        const changes = stmt.changes || [];
        for (const change of changes){
            const constraint = change.constraint ?? change;
            if (!constraint || !constraint.type) continue;
            const typeStr = String(constraint.type).toLowerCase();
            if (typeStr === 'foreign key' || typeStr === 'foreign_key') {
                const sourceCols = constraint.localColumns || constraint.columns || [];
                const targetCols = constraint.foreignColumns || constraint.references?.columns || [];
                const targetTable = getName(constraint.foreignTable || constraint.references?.table || constraint.table);
                for(let i = 0; i < sourceCols.length; i++){
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
                            onUpdate: constraint.onUpdate ? String(constraint.onUpdate).toUpperCase() : undefined
                        });
                        if (table) {
                            const col = table.columns.find((c)=>c.name === sourceColName);
                            if (col) col.isFKSource = true;
                        }
                    }
                }
            } else if (typeStr === 'unique' && table) {
                const uqCols = constraint.columns || [];
                const uqColNames = uqCols.map(getName);
                uqColNames.forEach((name)=>{
                    const col = table.columns.find((c)=>c.name === name);
                    if (col) col.isUnique = true;
                });
                table.indexes = table.indexes || [];
                table.indexes.push({
                    name: constraint.constraintName ? getName(constraint.constraintName) : undefined,
                    columns: uqColNames,
                    isUnique: true,
                    fromConstraint: true
                });
            } else if (typeStr === 'primary key' && table) {
                const pkCols = constraint.columns || [];
                pkCols.forEach((pkCol)=>{
                    const name = getName(pkCol);
                    const col = table.columns.find((c)=>c.name === name);
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
    return {
        tables,
        relationships
    };
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/app/components/TableNode.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>TableNode
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@reactflow/core/dist/esm/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/app/lib/sqlParser.ts [app-client] (ecmascript)");
"use client";
;
;
;
function TableNode({ data }) {
    const displayName = data.label;
    const allIndexes = data.indexes ?? [];
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "bg-white rounded-md shadow-sm border border-gray-300 min-w-[280px]",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-300 rounded-t-md",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "flex items-center gap-2 overflow-hidden",
                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "font-semibold text-sm text-gray-800 truncate",
                        children: displayName
                    }, void 0, false, {
                        fileName: "[project]/app/components/TableNode.tsx",
                        lineNumber: 26,
                        columnNumber: 11
                    }, this)
                }, void 0, false, {
                    fileName: "[project]/app/components/TableNode.tsx",
                    lineNumber: 25,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/app/components/TableNode.tsx",
                lineNumber: 24,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "divide-y divide-gray-200",
                children: data.columns.map((col, idx)=>{
                    const targetHandleId = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["buildHandleId"])(data.nodeId, col.name, 'target');
                    const sourceHandleId = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["buildHandleId"])(data.nodeId, col.name, 'source');
                    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "relative flex items-center px-3 py-1.5 gap-2",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Handle"], {
                                type: "target",
                                position: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Left,
                                id: `${targetHandleId}__L`,
                                className: "!w-2 !h-2 !bg-indigo-500 !border-0 !opacity-0 hover:!opacity-100 transition-opacity",
                                style: {
                                    left: -4
                                }
                            }, void 0, false, {
                                fileName: "[project]/app/components/TableNode.tsx",
                                lineNumber: 42,
                                columnNumber: 15
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Handle"], {
                                type: "source",
                                position: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Left,
                                id: `${sourceHandleId}__L`,
                                className: "!w-2 !h-2 !bg-indigo-500 !border-0 !opacity-0 hover:!opacity-100 transition-opacity",
                                style: {
                                    left: -4
                                }
                            }, void 0, false, {
                                fileName: "[project]/app/components/TableNode.tsx",
                                lineNumber: 49,
                                columnNumber: 15
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "flex items-center gap-1.5 flex-1 min-w-0",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "flex items-center gap-0.5 text-xs text-gray-500 flex-shrink-0",
                                        children: [
                                            col.isPK && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                title: "Primary Key",
                                                children: "🔑"
                                            }, void 0, false, {
                                                fileName: "[project]/app/components/TableNode.tsx",
                                                lineNumber: 60,
                                                columnNumber: 32
                                            }, this),
                                            col.isFKSource && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                title: "Foreign Key",
                                                children: "🔗"
                                            }, void 0, false, {
                                                fileName: "[project]/app/components/TableNode.tsx",
                                                lineNumber: 61,
                                                columnNumber: 38
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/components/TableNode.tsx",
                                        lineNumber: 59,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: `text-xs font-mono truncate ${col.isPK ? 'font-bold text-gray-900' : 'text-gray-700'}`,
                                        children: col.name
                                    }, void 0, false, {
                                        fileName: "[project]/app/components/TableNode.tsx",
                                        lineNumber: 64,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-xs text-gray-400 font-mono truncate flex-shrink-0",
                                        children: col.type.toLowerCase()
                                    }, void 0, false, {
                                        fileName: "[project]/app/components/TableNode.tsx",
                                        lineNumber: 70,
                                        columnNumber: 17
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/components/TableNode.tsx",
                                lineNumber: 58,
                                columnNumber: 15
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Handle"], {
                                type: "target",
                                position: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Right,
                                id: `${targetHandleId}__R`,
                                className: "!w-2 !h-2 !bg-indigo-500 !border-0 !opacity-0 hover:!opacity-100 transition-opacity",
                                style: {
                                    right: -4
                                }
                            }, void 0, false, {
                                fileName: "[project]/app/components/TableNode.tsx",
                                lineNumber: 76,
                                columnNumber: 15
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Handle"], {
                                type: "source",
                                position: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Right,
                                id: `${sourceHandleId}__R`,
                                className: "!w-2 !h-2 !bg-indigo-500 !border-0 !opacity-0 hover:!opacity-100 transition-opacity",
                                style: {
                                    right: -4
                                }
                            }, void 0, false, {
                                fileName: "[project]/app/components/TableNode.tsx",
                                lineNumber: 83,
                                columnNumber: 15
                            }, this)
                        ]
                    }, idx, true, {
                        fileName: "[project]/app/components/TableNode.tsx",
                        lineNumber: 37,
                        columnNumber: 13
                    }, this);
                })
            }, void 0, false, {
                fileName: "[project]/app/components/TableNode.tsx",
                lineNumber: 31,
                columnNumber: 7
            }, this),
            allIndexes.length > 0 && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "border-t border-gray-300 bg-gray-50 rounded-b-md px-3 py-2",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "text-xs font-medium text-gray-500 mb-1",
                        children: [
                            "Indexes (",
                            allIndexes.length,
                            ")"
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/components/TableNode.tsx",
                        lineNumber: 98,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "flex flex-col gap-1 max-h-[120px] overflow-y-auto",
                        children: allIndexes.map((idx, i)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "flex items-center gap-1.5 text-xs",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-gray-400",
                                        children: idx.isUnique ? '💎' : '⚡'
                                    }, void 0, false, {
                                        fileName: "[project]/app/components/TableNode.tsx",
                                        lineNumber: 104,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "font-mono text-gray-600 truncate",
                                        children: idx.name
                                    }, void 0, false, {
                                        fileName: "[project]/app/components/TableNode.tsx",
                                        lineNumber: 105,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-gray-400 font-mono text-xs",
                                        children: [
                                            "(",
                                            idx.columns.join(', '),
                                            ")"
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/components/TableNode.tsx",
                                        lineNumber: 106,
                                        columnNumber: 17
                                    }, this)
                                ]
                            }, i, true, {
                                fileName: "[project]/app/components/TableNode.tsx",
                                lineNumber: 103,
                                columnNumber: 15
                            }, this))
                    }, void 0, false, {
                        fileName: "[project]/app/components/TableNode.tsx",
                        lineNumber: 101,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/components/TableNode.tsx",
                lineNumber: 97,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/app/components/TableNode.tsx",
        lineNumber: 20,
        columnNumber: 5
    }, this);
}
_c = TableNode;
var _c;
__turbopack_context__.k.register(_c, "TableNode");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/app/components/CustomEdge.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>CustomEdge
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@reactflow/core/dist/esm/index.mjs [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
;
function CustomEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style = {}, label, data, animated = false }) {
    _s();
    const [isHovered, setIsHovered] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    // Extraemos las propiedades de control enviadas desde page.tsx
    const isFocused = data?.isFocused ?? false;
    const isDimmed = data?.isDimmed ?? false;
    const useStepLine = data?.styleType === 'step';
    const edgeOffset = data?.offset ?? 0;
    const cardinalityLabels = data?.cardinalityLabels ?? {
        source: '*',
        target: '1'
    };
    // NUEVO: Offsets verticales para evitar superposición de badges
    const sourceBadgeOffsetY = data?.sourceBadgeOffsetY ?? 0;
    const targetBadgeOffsetY = data?.targetBadgeOffsetY ?? 0;
    // Decidir el algoritmo geométrico de la línea
    const [edgePath, labelX, labelY] = useStepLine ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getSmoothStepPath"])({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 12,
        offset: 35 + edgeOffset
    }) : (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getBezierPath"])({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition
    });
    // ¿La curva va de derecha a izquierda? Si seguimos ese mismo trazado para
    // el texto, los glifos quedarían boca abajo/espejados (textPath sigue la
    // dirección del path). Para evitarlo, cuando esto pasa generamos un
    // segundo path -solo para el texto-, con la misma forma pero recorrido en
    // sentido inverso (izquierda -> derecha), así el texto siempre se lee bien.
    const isPathRightToLeft = sourceX > targetX;
    const [textPath] = isPathRightToLeft ? useStepLine ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getSmoothStepPath"])({
        sourceX: targetX,
        sourceY: targetY,
        sourcePosition: targetPosition,
        targetX: sourceX,
        targetY: sourceY,
        targetPosition: sourcePosition,
        borderRadius: 12,
        offset: 35 + edgeOffset
    }) : (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getBezierPath"])({
        sourceX: targetX,
        sourceY: targetY,
        sourcePosition: targetPosition,
        targetX: sourceX,
        targetY: sourceY,
        targetPosition: sourcePosition
    }) : [
        edgePath
    ];
    // Definición de colores y grosores según el estado interactivo
    let strokeColor = style.stroke || '#4f46e5';
    let strokeWidth = 2;
    let dotColor = '#4f46e5';
    if (isFocused) {
        strokeColor = '#16a34a';
        dotColor = '#16a34a';
        strokeWidth = 3.5;
    } else if (isHovered) {
        strokeColor = '#4338ca';
        dotColor = '#4338ca';
        strokeWidth = 3;
    }
    // Clases CSS dinámicas
    const edgeClassName = `react-flow__edge-path ${isDimmed ? 'edge-dimmed' : ''}`;
    // Mostrar el texto flotante horizontal si está en hover o si la tabla padre está seleccionada
    const showHorizontalLabel = isHovered || isFocused;
    // Solo animar si está habilitado y no está atenuado
    const shouldAnimate = animated && !isDimmed;
    // Posición de las píldoras de cardinalidad: pegadas a cada tabla,
    // desplazadas hacia afuera del nodo (mismo criterio L/R que el resto
    // del componente) y un poco hacia arriba de la línea para no taparla.
    // NUEVO: se aplica el offset vertical (badgeOffsetY) para evitar
    // superposición cuando múltiples líneas convergen en el mismo handle.
    const sourceBadgeDir = sourcePosition === __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Left ? -1 : 1;
    const targetBadgeDir = targetPosition === __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Left ? -1 : 1;
    const badgeDistance = 22;
    const sourceBadgeX = sourceX + sourceBadgeDir * badgeDistance;
    const targetBadgeX = targetX + targetBadgeDir * badgeDistance;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Fragment"], {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                id: id,
                className: edgeClassName,
                d: edgePath,
                style: {
                    ...style,
                    stroke: strokeColor,
                    strokeWidth: strokeWidth,
                    fill: 'none',
                    transition: 'stroke 0.2s, stroke-width 0.2s, opacity 0.2s',
                    cursor: 'pointer'
                },
                onMouseEnter: ()=>setIsHovered(true),
                onMouseLeave: ()=>setIsHovered(false)
            }, void 0, false, {
                fileName: "[project]/app/components/CustomEdge.tsx",
                lineNumber: 120,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["EdgeLabelRenderer"], {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "cardinality-badge",
                        style: {
                            transform: `translate(-50%, -50%) translate(${sourceBadgeX}px, ${sourceY - 9 + sourceBadgeOffsetY}px)`,
                            borderColor: strokeColor,
                            color: strokeColor,
                            opacity: isDimmed ? 0.12 : 1
                        },
                        children: cardinalityLabels.source
                    }, void 0, false, {
                        fileName: "[project]/app/components/CustomEdge.tsx",
                        lineNumber: 138,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "cardinality-badge",
                        style: {
                            transform: `translate(-50%, -50%) translate(${targetBadgeX}px, ${targetY - 9 + targetBadgeOffsetY}px)`,
                            borderColor: strokeColor,
                            color: strokeColor,
                            opacity: isDimmed ? 0.12 : 1
                        },
                        children: cardinalityLabels.target
                    }, void 0, false, {
                        fileName: "[project]/app/components/CustomEdge.tsx",
                        lineNumber: 149,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/components/CustomEdge.tsx",
                lineNumber: 137,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: edgePath,
                fill: "none",
                stroke: "transparent",
                strokeWidth: 15,
                style: {
                    cursor: 'pointer'
                },
                onMouseEnter: ()=>setIsHovered(true),
                onMouseLeave: ()=>setIsHovered(false)
            }, void 0, false, {
                fileName: "[project]/app/components/CustomEdge.tsx",
                lineNumber: 163,
                columnNumber: 7
            }, this),
            shouldAnimate && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                r: "5",
                fill: dotColor,
                opacity: "0.9",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("animateMotion", {
                    dur: "2s",
                    repeatCount: "indefinite",
                    path: edgePath
                }, void 0, false, {
                    fileName: "[project]/app/components/CustomEdge.tsx",
                    lineNumber: 176,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/app/components/CustomEdge.tsx",
                lineNumber: 175,
                columnNumber: 9
            }, this),
            label && !isDimmed && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Fragment"], {
                children: [
                    showHorizontalLabel && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["EdgeLabelRenderer"], {
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "custom-edge-label-renderer",
                            style: {
                                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`
                            },
                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `horizontal-edge-label ${isFocused ? 'active-green' : ''}`,
                                children: label.toString()
                            }, void 0, false, {
                                fileName: "[project]/app/components/CustomEdge.tsx",
                                lineNumber: 195,
                                columnNumber: 17
                            }, this)
                        }, void 0, false, {
                            fileName: "[project]/app/components/CustomEdge.tsx",
                            lineNumber: 189,
                            columnNumber: 15
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/app/components/CustomEdge.tsx",
                        lineNumber: 188,
                        columnNumber: 13
                    }, this),
                    !showHorizontalLabel && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["EdgeLabelRenderer"], {
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "absolute inset-0 pointer-events-none overflow-visible",
                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
                                className: "w-full h-full overflow-visible absolute inset-0",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                                        id: `path-${id}`,
                                        d: textPath,
                                        fill: "none",
                                        className: "pointer-events-none"
                                    }, void 0, false, {
                                        fileName: "[project]/app/components/CustomEdge.tsx",
                                        lineNumber: 207,
                                        columnNumber: 19
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                                        dy: "-6",
                                        className: "select-none font-mono font-bold text-[10px] fill-indigo-950/80",
                                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("textPath", {
                                            href: `#path-${id}`,
                                            startOffset: "50%",
                                            textAnchor: "middle",
                                            children: label.toString()
                                        }, void 0, false, {
                                            fileName: "[project]/app/components/CustomEdge.tsx",
                                            lineNumber: 209,
                                            columnNumber: 21
                                        }, this)
                                    }, void 0, false, {
                                        fileName: "[project]/app/components/CustomEdge.tsx",
                                        lineNumber: 208,
                                        columnNumber: 19
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/components/CustomEdge.tsx",
                                lineNumber: 206,
                                columnNumber: 17
                            }, this)
                        }, void 0, false, {
                            fileName: "[project]/app/components/CustomEdge.tsx",
                            lineNumber: 205,
                            columnNumber: 15
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/app/components/CustomEdge.tsx",
                        lineNumber: 204,
                        columnNumber: 13
                    }, this)
                ]
            }, void 0, true)
        ]
    }, void 0, true);
}
_s(CustomEdge, "FPQn8a98tPjpohC7NUYORQR8GJE=");
_c = CustomEdge;
var _c;
__turbopack_context__.k.register(_c, "CustomEdge");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/app/lib/layout.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "getLayoutedElements",
    ()=>getLayoutedElements,
    "getNodeHeight",
    ()=>getNodeHeight
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$dagre$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/dagre/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@reactflow/core/dist/esm/index.mjs [app-client] (ecmascript)");
;
;
//
const NODE_WIDTH = 320; // Sincronizado exactamente con el componente TableNode
const COL_HEIGHT = 37; // Incrementado milimétricamente para dar holgura a las filas
const HEADER_HEIGHT = 50; // Altura real del header textificado de la tabla
const INDEX_ROW_HEIGHT = 44; // Espacio asignado por cada tarjeta de índice en el footer
const INDEX_HEADER_HEIGHT = 32; // Separación del título de la sección de índices
function visibleIndexCount(node) {
    const indexes = node.data.indexes;
    if (!indexes || indexes.length === 0) return 0;
    return indexes.length;
}
function getNodeHeight(columnCount, indexCount = 0) {
    const indexSection = indexCount > 0 ? INDEX_HEADER_HEIGHT + indexCount * INDEX_ROW_HEIGHT : 0;
    return HEADER_HEIGHT + columnCount * COL_HEIGHT + indexSection + 16;
}
function getLayoutedElements(nodes, edges, direction = 'LR') {
    const isHorizontal = direction === 'LR';
    const dagreGraph = new __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$dagre$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"].graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(()=>({}));
    // Modificamos ranksep y nodesep para ensanchar el pasillo por donde cruzan las conexiones (Edges)
    dagreGraph.setGraph({
        rankdir: direction,
        ranksep: 220,
        nodesep: 110 // Más separación vertical para dar holgura a conexiones complejas
    });
    nodes.forEach((node)=>{
        const colCount = node.data.columns?.length ?? 1;
        const idxCount = visibleIndexCount(node);
        dagreGraph.setNode(node.id, {
            width: NODE_WIDTH,
            height: getNodeHeight(colCount, idxCount)
        });
    });
    edges.forEach((edge)=>{
        dagreGraph.setEdge(edge.source, edge.target);
    });
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$dagre$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"].layout(dagreGraph);
    const layoutedNodes = nodes.map((node)=>{
        const pos = dagreGraph.node(node.id);
        const colCount = node.data.columns?.length ?? 1;
        const idxCount = visibleIndexCount(node);
        return {
            ...node,
            targetPosition: isHorizontal ? __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Left : __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Top,
            sourcePosition: isHorizontal ? __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Right : __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Position"].Bottom,
            position: {
                x: pos.x - NODE_WIDTH / 2,
                y: pos.y - getNodeHeight(colCount, idxCount) / 2
            }
        };
    });
    return {
        nodes: layoutedNodes,
        edges
    };
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/app/page.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>Home
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__ReactFlow__as__default$3e$__ = __turbopack_context__.i("[project]/node_modules/@reactflow/core/dist/esm/index.mjs [app-client] (ecmascript) <export ReactFlow as default>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$background$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@reactflow/background/dist/esm/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$controls$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@reactflow/controls/dist/esm/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$minimap$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@reactflow/minimap/dist/esm/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@reactflow/core/dist/esm/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$components$2f$TableNode$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/app/components/TableNode.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$components$2f$CustomEdge$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/app/components/CustomEdge.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/app/lib/sqlParser.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$layout$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/app/lib/layout.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
;
;
;
;
;
;
;
const nodeTypes = {
    tableNode: __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$components$2f$TableNode$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"]
};
const edgeTypes = {
    customEdge: __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$components$2f$CustomEdge$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"]
};
// Ancho de respaldo si React Flow aún no midió el nodo (antes del primer render)
const FALLBACK_NODE_WIDTH = 320;
/**
 * Simple Floating Edges (adaptado a handles por columna):
 * en lugar de recalcular geométricamente el punto de intersección sobre el
 * borde del nodo (como en el ejemplo clásico de node-a-node), aquí cada
 * columna ya tiene un handle "target" y un handle "source" en AMBOS lados
 * (ver TableNode.tsx, sufijos __L / __R). Esta función sólo decide, según
 * la posición X real de los dos nodos, qué lado debe quedar activo en cada
 * extremo del edge para que la línea nunca tenga que "rodear" la tabla.
 */ function getDynamicHandleSides(sourceNode, targetNode) {
    const sourceWidth = sourceNode.width ?? FALLBACK_NODE_WIDTH;
    const targetWidth = targetNode.width ?? FALLBACK_NODE_WIDTH;
    const sourceCenterX = sourceNode.position.x + sourceWidth / 2;
    const targetCenterX = targetNode.position.x + targetWidth / 2;
    // Caso normal (como hasta ahora): la tabla origen está a la izquierda
    // de la tabla destino -> sale por su derecha, entra por la izquierda del destino.
    if (sourceCenterX <= targetCenterX) {
        return {
            sourceSide: 'R',
            targetSide: 'L'
        };
    }
    // La tabla origen quedó a la derecha de la tabla destino (p. ej. el usuario
    // la arrastró al otro lado) -> invertimos: sale por su izquierda, entra
    // por la derecha del destino.
    return {
        sourceSide: 'L',
        targetSide: 'R'
    };
}
/**
 * Devuelve el edge con sourceHandle/targetHandle recalculados para el frame
 * actual, a partir de los handles "base" (sin sufijo) guardados en edge.data.
 * Si todavía no encontramos ambos nodos (no debería pasar) devolvemos el
 * edge tal cual, sin tocar sus handles.
 */ function withFloatingHandles(edge, nodesById) {
    const baseSourceHandle = edge.data?.baseSourceHandle;
    const baseTargetHandle = edge.data?.baseTargetHandle;
    if (!baseSourceHandle || !baseTargetHandle) return edge;
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode || !targetNode) return edge;
    const { sourceSide, targetSide } = getDynamicHandleSides(sourceNode, targetNode);
    return {
        ...edge,
        sourceHandle: `${baseSourceHandle}__${sourceSide}`,
        targetHandle: `${baseTargetHandle}__${targetSide}`
    };
}
/**
 * Determina las etiquetas de cardinalidad de una relación, igual que
 * dbdiagram.io: se basan únicamente en la columna que tiene la FK
 * (rel.sourceColumn) y su definición real en el esquema parseado.
 *
 * Si esa columna es PK o tiene UNIQUE -> relación 1:1
 *   lado FK   : "1" (obligatoria) o "0..1" (si la columna es NULLABLE)
 *   lado ref. : igual, "1" o "0..1"
 *
 * Si no -> relación normal 1:N
 *   lado FK   : "*" (muchas filas pueden compartir la misma referencia)
 *   lado ref. : "1" (obligatoria) o "0..1" (si la FK es NULLABLE, la
 *               referencia es opcional)
 */ function getCardinalityLabels(tables, sourceTable, sourceColumn) {
    const table = tables.find((t)=>t.name.toLowerCase() === sourceTable.toLowerCase());
    const col = table?.columns.find((c)=>c.name.toLowerCase() === sourceColumn.toLowerCase());
    const isUniqueOnThisSide = col?.isUniqueColumn === true || col?.isUnique === true;
    const isNullable = col?.isNullable !== false;
    if (isUniqueOnThisSide) {
        const label = isNullable ? '0..1' : '1';
        return {
            source: label,
            target: label
        }; // 1:1 o 0..1:0..1
    }
    // Relación normal 1:N
    return {
        source: '*',
        target: isNullable ? '0..1' : '1'
    };
}
const DEFAULT_SQL = `-- ============================================
-- EJEMPLOS DE RELACIONES EN POSTGRESQL
-- ============================================
-- 1. RELACIÓN UNO A MUCHOS (1:N) - La más común
-- Un usuario puede tener muchos posts, pero cada post pertenece a un solo usuario
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT,
  author_id INTEGER NOT NULL,
  published_at TIMESTAMPTZ,
  -- Foreign Key con ON DELETE CASCADE
  -- Si se elimina el usuario, se eliminan todos sus posts
  FOREIGN KEY (author_id) REFERENCES users(id)
  ON DELETE CASCADE
  ON UPDATE CASCADE
);

-- 2. RELACIÓN UNO A MUCHOS con SET NULL
-- Una categoría puede tener muchos productos
-- Si se elimina la categoría, los productos quedan sin categoría
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  category_id INTEGER,
  -- ON DELETE SET NULL: Si se elimina la categoría,
  -- el producto permanece pero sin categoría
  FOREIGN KEY (category_id) REFERENCES categories(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE
);

-- 3. RELACIÓN MUCHOS A MUCHOS (N:M)
-- Un post puede tener muchas etiquetas y una etiqueta puede estar en muchos posts
CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  color VARCHAR(7) DEFAULT '#000000'
);

-- Tabla intermedia (junction table)
CREATE TABLE post_tags (
  post_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  -- Composite Primary Key
  PRIMARY KEY (post_id, tag_id),
  -- Foreign Keys con restricciones
  FOREIGN KEY (post_id) REFERENCES posts(id)
  ON DELETE CASCADE
  ON UPDATE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id)
  ON DELETE CASCADE
  ON UPDATE CASCADE
);

-- 4. RELACIÓN UNO A UNO (1:1)
-- Cada usuario tiene un único perfil
CREATE TABLE user_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL,  -- UNIQUE es clave aquí
  bio TEXT,
  avatar_url VARCHAR(500),
  birth_date DATE,
  -- Relación 1:1 con users
  FOREIGN KEY (user_id) REFERENCES users(id)
  ON DELETE CASCADE
  ON UPDATE CASCADE
);

-- 5. RELACIÓN UNO A MUCHOS con RESTRICT
-- Un departamento tiene muchos empleados
-- RESTRICT impide eliminar el departamento si tiene empleados
CREATE TABLE departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  budget DECIMAL(12, 2)
);

CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  department_id INTEGER NOT NULL,
  hire_date DATE DEFAULT CURRENT_DATE,
  salary DECIMAL(10, 2),
  -- ON DELETE RESTRICT (o NO ACTION):
  -- No se puede eliminar el departamento si tiene empleados
  FOREIGN KEY (department_id) REFERENCES departments(id)
  ON DELETE RESTRICT
  ON UPDATE CASCADE
);

-- 6. RELACIÓN AUTORREFERENCIADA (Self-referencing)
-- Un empleado puede tener un supervisor que también es empleado
CREATE TABLE employees_hierarchy (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  position VARCHAR(100),
  supervisor_id INTEGER,
  -- Foreign Key que referencia a la misma tabla
  FOREIGN KEY (supervisor_id) REFERENCES employees_hierarchy(id)
  ON DELETE SET NULL
  ON UPDATE CASCADE
);

-- 7. RELACIÓN CON MÚLTIPLES FOREIGN KEYS
-- Una orden tiene múltiples direcciones (envío y facturación)
CREATE TABLE addresses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  street VARCHAR(200) NOT NULL,
  city VARCHAR(100) NOT NULL,
  country VARCHAR(100) NOT NULL,
  postal_code VARCHAR(20),
  FOREIGN KEY (user_id) REFERENCES users(id)
  ON DELETE CASCADE
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  order_date TIMESTAMPTZ DEFAULT NOW(),
  shipping_address_id INTEGER NOT NULL,
  billing_address_id INTEGER NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  total_amount DECIMAL(10, 2),
  FOREIGN KEY (user_id) REFERENCES users(id)
  ON DELETE CASCADE,
  FOREIGN KEY (shipping_address_id) REFERENCES addresses(id)
  ON DELETE RESTRICT,
  FOREIGN KEY (billing_address_id) REFERENCES addresses(id)
  ON DELETE RESTRICT
);

-- 8. RELACIÓN CON CLAVE FORÁNEA COMPUESTA
-- Un estudiante puede estar inscrito en muchos cursos
CREATE TABLE students (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL
);

CREATE TABLE courses (
  id SERIAL PRIMARY KEY,
  course_code VARCHAR(20) UNIQUE NOT NULL,
  course_name VARCHAR(200) NOT NULL,
  credits INTEGER NOT NULL
);

CREATE TABLE enrollments (
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  enrollment_date DATE DEFAULT CURRENT_DATE,
  grade DECIMAL(4, 2),
  PRIMARY KEY (student_id, course_id),
  FOREIGN KEY (student_id) REFERENCES students(id)
  ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id)
  ON DELETE CASCADE
);

-- 9. RELACIÓN CON ACCIONES DIFERENTES EN DELETE Y UPDATE
CREATE TABLE publishers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  founded_year INTEGER
);

CREATE TABLE books (
  id SERIAL PRIMARY KEY,
  title VARCHAR(300) NOT NULL,
  isbn VARCHAR(13) UNIQUE,
  publisher_id INTEGER NOT NULL,
  published_date DATE,
  -- UPDATE CASCADE mantiene la integridad
  -- DELETE SET DEFAULT asigna un publisher por defecto
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
  ON DELETE SET DEFAULT
  ON UPDATE CASCADE
);

-- ============================================
-- EJEMPLOS DE INSERCIÓN DE DATOS
-- ============================================
-- Insertar usuarios
INSERT INTO users (username, email) VALUES
('john_doe', 'john@example.com'),
('jane_smith', 'jane@example.com');

-- Insertar posts (relación 1:N)
INSERT INTO posts (title, content, author_id) VALUES
('Mi primer post', 'Contenido del post...', 1),
('Aprendiendo SQL', 'SQL es genial...', 1),
('Post de Jane', 'Otro contenido...', 2);

-- Insertar tags (relación N:M)
INSERT INTO tags (name, color) VALUES
('sql', '#3498db'),
('database', '#2ecc71'),
('tutorial', '#e74c3c');

-- Insertar post_tags (relación N:M)
INSERT INTO post_tags (post_id, tag_id) VALUES
(1, 1),  -- Post 1 tiene tag sql
(1, 3),  -- Post 1 tiene tag tutorial
(2, 1),  -- Post 2 tiene tag sql
(2, 2);  -- Post 2 tiene tag database

-- Insertar user_profiles (relación 1:1)
INSERT INTO user_profiles (user_id, bio, avatar_url) VALUES
(1, 'Desarrollador backend', 'https://example.com/avatar1.jpg');

-- ============================================
-- CONSULTAS EJEMPLO CON JOINS
-- ============================================
-- Obtener todos los posts con su autor
SELECT
  p.id,
  p.title,
  p.content,
  u.username as author,
  u.email
FROM posts p
INNER JOIN users u ON p.author_id = u.id;

-- Obtener posts con sus tags (relación N:M)
SELECT
  p.title as post_title,
  t.name as tag_name,
  t.color
FROM posts p
INNER JOIN post_tags pt ON p.id = pt.post_id
INNER JOIN tags t ON pt.tag_id = t.id
ORDER BY p.title, t.name;

-- Obtener usuario con su perfil (relación 1:1)
SELECT
  u.username,
  u.email,
  up.bio,
  up.avatar_url
FROM users u
LEFT JOIN user_profiles up ON u.id = up.user_id;

-- Contar posts por usuario
SELECT
  u.username,
  COUNT(p.id) as total_posts
FROM users u
LEFT JOIN posts p ON u.id = p.author_id
GROUP BY u.id, u.username
ORDER BY total_posts DESC;

-- ============================================
-- OPCIONES DE FOREIGN KEY
-- ============================================
/*
ON DELETE:
  CASCADE: Elimina las filas hijas cuando se elimina la padre
  SET NULL: Establece la FK como NULL cuando se elimina la padre
  SET DEFAULT: Establece la FK al valor por defecto
  RESTRICT: Rechaza la eliminación si hay filas hijas (verifica inmediatamente)
  NO ACTION: Rechaza la eliminación si hay filas hijas (verifica al final)

ON UPDATE:
  CASCADE: Actualiza las FK cuando cambia la PK padre
  SET NULL: Establece la FK como NULL cuando se actualiza la PK
  SET DEFAULT: Establece la FK al valor por defecto
  RESTRICT: Rechaza la actualización si hay filas hijas
  NO ACTION: Rechaza la actualización si hay filas hijas
*/`;
function Home() {
    _s();
    const [sqlInput, setSqlInput] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(DEFAULT_SQL);
    const [nodes, setNodes, onNodesChange] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useNodesState"])([]);
    const [edges, setEdges, onEdgesChange] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEdgesState"])([]);
    const [error, setError] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [stats, setStats] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [selectedTableId, setSelectedTableId] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [isTextSelectionMode, setIsTextSelectionMode] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [isSidebarOpen, setIsSidebarOpen] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    const handleGenerate = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "Home.useCallback[handleGenerate]": ()=>{
            setError(null);
            setSelectedTableId(null);
            try {
                const { tables, relationships } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["parsePostgresSQL"])(sqlInput);
                const flowNodes = tables.map({
                    "Home.useCallback[handleGenerate].flowNodes": (table)=>{
                        const nodeId = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["sanitizeId"])(table.name);
                        return {
                            id: nodeId,
                            type: 'tableNode',
                            data: {
                                label: table.name,
                                nodeId,
                                schema: table.schema,
                                columns: table.columns,
                                indexes: table.indexes,
                                comment: table.comment
                            },
                            position: {
                                x: 0,
                                y: 0
                            }
                        };
                    }
                }["Home.useCallback[handleGenerate].flowNodes"]);
                const edgeCountMap = {};
                // Mapas para contar cuántas líneas apuntan a un handle específico
                // Esto nos permite saber si necesitamos separar las etiquetas
                const targetHandleCounts = {};
                const sourceHandleCounts = {};
                // Primera pasada: contar ocurrencias para asignar turnos
                relationships.forEach({
                    "Home.useCallback[handleGenerate]": (rel)=>{
                        const sHandle = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["buildHandleId"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["sanitizeId"])(rel.sourceTable), rel.sourceColumn, 'source');
                        const tHandle = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["buildHandleId"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["sanitizeId"])(rel.targetTable), rel.targetColumn, 'target');
                        targetHandleCounts[tHandle] = (targetHandleCounts[tHandle] || 0) + 1;
                        sourceHandleCounts[sHandle] = (sourceHandleCounts[sHandle] || 0) + 1;
                    }
                }["Home.useCallback[handleGenerate]"]);
                // Contadores de estado actual para asignar posiciones (se resetean por handle)
                const currentTargetCounts = {};
                const currentSourceCounts = {};
                const flowEdges = relationships.map({
                    "Home.useCallback[handleGenerate].flowEdges": (rel, i)=>{
                        const sourceNodeId = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["sanitizeId"])(rel.sourceTable);
                        const targetNodeId = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["sanitizeId"])(rel.targetTable);
                        const sHandle = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["buildHandleId"])(sourceNodeId, rel.sourceColumn, 'source');
                        const tHandle = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$sqlParser$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["buildHandleId"])(targetNodeId, rel.targetColumn, 'target');
                        const edgeKey = `${sHandle}->${tHandle}`;
                        if (edgeCountMap[edgeKey] === undefined) {
                            edgeCountMap[edgeKey] = 0;
                        } else {
                            edgeCountMap[edgeKey]++;
                        }
                        const currentCount = edgeCountMap[edgeKey];
                        const offsetSign = currentCount % 2 === 0 ? 1 : -1;
                        const calculatedOffset = Math.ceil(currentCount / 2) * 18 * offsetSign;
                        // --- NUEVO: Cálculo de Badge Offset Y (Vertical) ---
                        // Si hay más de una línea apuntando al MISMO destino, desplazamos las etiquetas verticalmente
                        const isTargetCrowded = targetHandleCounts[tHandle] > 1;
                        let targetBadgeOffsetY = 0;
                        if (isTargetCrowded) {
                            const currentTIdx = currentTargetCounts[tHandle] || 0;
                            // Escalonamiento: 0, -22, +22, -44, +44...
                            targetBadgeOffsetY = (currentTIdx % 2 === 0 ? 1 : -1) * Math.ceil((currentTIdx + 1) / 2) * 22;
                            currentTargetCounts[tHandle] = currentTIdx + 1;
                        }
                        // Si hay más de una línea saliendo del MISMO origen, desplazamos las etiquetas
                        const isSourceCrowded = sourceHandleCounts[sHandle] > 1;
                        let sourceBadgeOffsetY = 0;
                        if (isSourceCrowded) {
                            const currentSIdx = currentSourceCounts[sHandle] || 0;
                            sourceBadgeOffsetY = (currentSIdx % 2 === 0 ? 1 : -1) * Math.ceil((currentSIdx + 1) / 2) * 22;
                            currentSourceCounts[sHandle] = currentSIdx + 1;
                        }
                        // ---------------------------------------------
                        const actionSuffix = [
                            rel.onDelete && `ON DELETE ${rel.onDelete}`,
                            rel.onUpdate && `ON UPDATE ${rel.onUpdate}`
                        ].filter(Boolean).join(' · ');
                        const cleanLabel = actionSuffix ? `${rel.sourceColumn} → ${rel.targetColumn}  (${actionSuffix})` : `${rel.sourceColumn} → ${rel.targetColumn}`;
                        // Cardinalidad estilo dbdiagram.io: "1" / "0..1" / "*" según si la
                        // columna FK es PK/UNIQUE y si admite NULL.
                        const cardinalityLabels = getCardinalityLabels(tables, rel.sourceTable, rel.sourceColumn);
                        return {
                            id: `e-${i}-${sourceNodeId}-${rel.sourceColumn}-${targetNodeId}-${rel.targetColumn}`,
                            source: sourceNodeId,
                            target: targetNodeId,
                            // Valores iniciales (comportamiento "normal": origen -> derecha, destino -> izquierda).
                            // Se recalculan en cada render vía withFloatingHandles/displayEdges.
                            sourceHandle: `${sHandle}__R`,
                            targetHandle: `${tHandle}__L`,
                            type: 'customEdge',
                            animated: true,
                            style: {
                                stroke: '#4f46e5'
                            },
                            label: cleanLabel,
                            data: {
                                sourceTable: sourceNodeId,
                                targetTable: targetNodeId,
                                offset: calculatedOffset,
                                // Handles base (sin sufijo __L/__R), usados para resolver
                                // dinámicamente el lado correcto según la posición de las tablas.
                                baseSourceHandle: sHandle,
                                baseTargetHandle: tHandle,
                                // Etiquetas de cardinalidad ("1", "0..1", "*") mostradas como
                                // píldoras junto a cada tabla, igual que en dbdiagram.io.
                                cardinalityLabels,
                                // NUEVO: Offsets verticales para evitar superposición de badges
                                sourceBadgeOffsetY,
                                targetBadgeOffsetY
                            }
                        };
                    }
                }["Home.useCallback[handleGenerate].flowEdges"]);
                const { nodes: ln, edges: le } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$lib$2f$layout$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getLayoutedElements"])(flowNodes, flowEdges, 'LR');
                const layoutedEdges = le.map({
                    "Home.useCallback[handleGenerate].layoutedEdges": (edge)=>{
                        if (!edge.data?.isFocused) return edge;
                        const sourceNode = ln.find({
                            "Home.useCallback[handleGenerate].layoutedEdges.sourceNode": (n)=>n.id === edge.source
                        }["Home.useCallback[handleGenerate].layoutedEdges.sourceNode"]);
                        const targetNode = ln.find({
                            "Home.useCallback[handleGenerate].layoutedEdges.targetNode": (n)=>n.id === edge.target
                        }["Home.useCallback[handleGenerate].layoutedEdges.targetNode"]);
                        if (sourceNode && targetNode) {
                            const yDiff = targetNode.position.y - sourceNode.position.y;
                            const dynamicOffset = yDiff > 0 ? 30 : -30;
                            return {
                                ...edge,
                                data: {
                                    ...edge.data,
                                    offset: dynamicOffset
                                }
                            };
                        }
                        return edge;
                    }
                }["Home.useCallback[handleGenerate].layoutedEdges"]);
                setNodes(ln);
                setEdges(layoutedEdges);
                const indexCount = tables.reduce({
                    "Home.useCallback[handleGenerate].indexCount": (acc, t)=>acc + (t.indexes?.length ?? 0)
                }["Home.useCallback[handleGenerate].indexCount"], 0);
                setStats({
                    tables: tables.length,
                    relations: relationships.length,
                    indexes: indexCount
                });
            } catch (err) {
                setError(err.message ?? 'Error inesperado al procesar el código SQL.');
                setNodes([]);
                setEdges([]);
                setStats(null);
            }
        }
    }["Home.useCallback[handleGenerate]"], [
        sqlInput,
        setNodes,
        setEdges
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "Home.useEffect": ()=>{
            handleGenerate();
        }
    }["Home.useEffect"], [
        handleGenerate
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "Home.useEffect": ()=>{
            const handleKeyDown = {
                "Home.useEffect.handleKeyDown": (e)=>{
                    if (e.key === 'Control' || e.key === 'Meta') {
                        setIsTextSelectionMode(true);
                    }
                }
            }["Home.useEffect.handleKeyDown"];
            const handleKeyUp = {
                "Home.useEffect.handleKeyUp": (e)=>{
                    if (e.key === 'Control' || e.key === 'Meta') {
                        setIsTextSelectionMode(false);
                    }
                }
            }["Home.useEffect.handleKeyUp"];
            window.addEventListener('keydown', handleKeyDown);
            window.addEventListener('keyup', handleKeyUp);
            return ({
                "Home.useEffect": ()=>{
                    window.removeEventListener('keydown', handleKeyDown);
                    window.removeEventListener('keyup', handleKeyUp);
                }
            })["Home.useEffect"];
        }
    }["Home.useEffect"], []);
    const onNodeClick = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "Home.useCallback[onNodeClick]": (_, node)=>{
            setSelectedTableId(node.id);
        }
    }["Home.useCallback[onNodeClick]"], []);
    const onPaneClick = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "Home.useCallback[onPaneClick]": ()=>{
            setSelectedTableId(null);
        }
    }["Home.useCallback[onPaneClick]"], []);
    const displayNodes = nodes.map((node)=>{
        if (!selectedTableId) return node;
        const isCurrent = node.id === selectedTableId;
        const isConnected = edges.some((e)=>e.source === selectedTableId && e.target === node.id || e.target === selectedTableId && e.source === node.id);
        return {
            ...node,
            className: isCurrent || isConnected ? '' : 'node-dimmed'
        };
    });
    const nodesById = new Map(nodes.map((n)=>[
            n.id,
            n
        ]));
    const displayEdges = edges.map((edge)=>{
        const floatingEdge = withFloatingHandles(edge, nodesById);
        if (!selectedTableId) return floatingEdge;
        const belongsToSelection = edge.source === selectedTableId || edge.target === selectedTableId;
        return {
            ...floatingEdge,
            animated: belongsToSelection,
            data: {
                ...floatingEdge.data,
                isFocused: belongsToSelection,
                styleType: 'bezier',
                isDimmed: !belongsToSelection
            }
        };
    });
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("main", {
        className: "h-screen w-screen flex bg-slate-100 overflow-hidden text-slate-900 antialiased font-sans",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("aside", {
                className: `flex-shrink-0 flex flex-col gap-3.5 p-5 border-r border-slate-200 bg-white shadow-xl z-10 transition-all duration-300 ease-in-out ${isSidebarOpen ? 'w-[390px] opacity-100' : 'w-0 opacity-0 overflow-hidden border-r-0'}`,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "pb-1 border-b border-slate-100",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("h1", {
                                className: "text-lg font-bold tracking-tight text-slate-900 flex items-center gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-2xl",
                                        children: "📊"
                                    }, void 0, false, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 650,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        children: [
                                            "Schema ",
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "text-indigo-600",
                                                children: "Visualizer"
                                            }, void 0, false, {
                                                fileName: "[project]/app/page.tsx",
                                                lineNumber: 651,
                                                columnNumber: 26
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 651,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/page.tsx",
                                lineNumber: 649,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "text-xs text-slate-400 mt-0.5",
                                children: "Ingresa tu código estructurado DDL de PostgreSQL"
                            }, void 0, false, {
                                fileName: "[project]/app/page.tsx",
                                lineNumber: 653,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/page.tsx",
                        lineNumber: 648,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("textarea", {
                        className: "flex-1 p-3.5 border border-slate-200 rounded-xl font-mono text-[11px] leading-relaxed focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-none bg-slate-50/50 text-slate-800 placeholder-slate-300 transition-colors",
                        value: sqlInput,
                        onChange: (e)=>setSqlInput(e.target.value),
                        placeholder: "-- Pega tus sentencias CREATE TABLE e INDEX aquí...",
                        spellCheck: false
                    }, void 0, false, {
                        fileName: "[project]/app/page.tsx",
                        lineNumber: 658,
                        columnNumber: 9
                    }, this),
                    error && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg font-medium animate-pulse",
                        children: [
                            "⚠️ ",
                            error
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/page.tsx",
                        lineNumber: 667,
                        columnNumber: 11
                    }, this),
                    stats && !error && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "grid grid-cols-3 gap-2 text-center text-[11px] border border-slate-100 rounded-xl p-2.5 bg-slate-50/50",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "p-2.5 bg-white border border-slate-100 rounded-lg shadow-sm",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "block text-base font-extrabold text-slate-950",
                                        children: stats.tables
                                    }, void 0, false, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 675,
                                        columnNumber: 15
                                    }, this),
                                    " tablas"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/page.tsx",
                                lineNumber: 674,
                                columnNumber: 13
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "p-2.5 bg-white border border-slate-100 rounded-lg shadow-sm",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "block text-base font-extrabold text-indigo-600",
                                        children: stats.relations
                                    }, void 0, false, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 678,
                                        columnNumber: 15
                                    }, this),
                                    " relaciones"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/page.tsx",
                                lineNumber: 677,
                                columnNumber: 13
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "p-2.5 bg-white border border-slate-100 rounded-lg shadow-sm",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "block text-base font-extrabold text-amber-600",
                                        children: stats.indexes
                                    }, void 0, false, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 681,
                                        columnNumber: 15
                                    }, this),
                                    " índices"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/page.tsx",
                                lineNumber: 680,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/page.tsx",
                        lineNumber: 673,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                        onClick: handleGenerate,
                        className: "bg-indigo-600 text-white py-3 rounded-xl font-semibold text-sm hover:bg-indigo-700 active:scale-[0.99] transition-all shadow-md shadow-indigo-200",
                        children: "Generar Diagrama de Entidades"
                    }, void 0, false, {
                        fileName: "[project]/app/page.tsx",
                        lineNumber: 686,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "text-[10px] text-slate-400 flex flex-col gap-2 border-t border-slate-100 pt-3.5",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "font-semibold text-slate-500 uppercase tracking-wider text-[9px]",
                                children: "💡 Tips de Navegación"
                            }, void 0, false, {
                                fileName: "[project]/app/page.tsx",
                                lineNumber: 694,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "text-slate-500 leading-normal",
                                children: [
                                    "Haz ",
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("strong", {
                                        children: "clic sobre una tabla"
                                    }, void 0, false, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 696,
                                        columnNumber: 17
                                    }, this),
                                    " para resaltar sus relaciones. Las líneas mantendrán su estilo curvo original. Haz clic en el fondo para restaurar el esquema completo."
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/page.tsx",
                                lineNumber: 695,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "text-slate-500 leading-normal",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("strong", {
                                        children: "Para copiar texto:"
                                    }, void 0, false, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 699,
                                        columnNumber: 13
                                    }, this),
                                    " Mantén presionada la tecla ",
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("kbd", {
                                        className: "px-1.5 py-0.5 bg-slate-200 rounded text-[9px] font-mono",
                                        children: "Ctrl"
                                    }, void 0, false, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 699,
                                        columnNumber: 76
                                    }, this),
                                    " (o ",
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("kbd", {
                                        className: "px-1.5 py-0.5 bg-slate-200 rounded text-[9px] font-mono",
                                        children: "⌘ Cmd"
                                    }, void 0, false, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 699,
                                        columnNumber: 163
                                    }, this),
                                    " en Mac) y el cursor cambiará a texto. Ahora puedes seleccionar y copiar normalmente."
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/page.tsx",
                                lineNumber: 698,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "text-slate-500 leading-normal",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("strong", {
                                        children: "🎯 Animación:"
                                    }, void 0, false, {
                                        fileName: "[project]/app/page.tsx",
                                        lineNumber: 702,
                                        columnNumber: 13
                                    }, this),
                                    " Los círculos animados viajan a lo largo de las líneas mostrando la dirección de las relaciones Foreign Key, desde la tabla que tiene la FK hacia la tabla referenciada."
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/page.tsx",
                                lineNumber: 701,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/page.tsx",
                        lineNumber: 693,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/page.tsx",
                lineNumber: 643,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                onClick: ()=>setIsSidebarOpen(!isSidebarOpen),
                className: `absolute top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-8 h-16 bg-white border border-slate-200 shadow-lg hover:shadow-xl hover:bg-indigo-50 hover:border-indigo-300 transition-all duration-300 group ${isSidebarOpen ? 'left-[390px] -translate-x-1/2 rounded-r-xl border-l-0' : 'left-0 rounded-r-xl'}`,
                title: isSidebarOpen ? 'Ocultar panel lateral' : 'Mostrar panel lateral',
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
                    className: `w-4 h-4 text-slate-500 group-hover:text-indigo-600 transition-all duration-300 ${isSidebarOpen ? 'rotate-180' : 'rotate-0'}`,
                    fill: "none",
                    stroke: "currentColor",
                    viewBox: "0 0 24 24",
                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                        strokeLinecap: "round",
                        strokeLinejoin: "round",
                        strokeWidth: 2,
                        d: "M15 19l-7-7 7-7"
                    }, void 0, false, {
                        fileName: "[project]/app/page.tsx",
                        lineNumber: 725,
                        columnNumber: 11
                    }, this)
                }, void 0, false, {
                    fileName: "[project]/app/page.tsx",
                    lineNumber: 717,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/app/page.tsx",
                lineNumber: 708,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: `flex-1 h-full relative transition-all duration-300 ${isTextSelectionMode ? 'text-select-mode' : ''}`,
                children: nodes.length > 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__ReactFlow__as__default$3e$__["default"], {
                    nodes: displayNodes,
                    edges: displayEdges,
                    onNodesChange: onNodesChange,
                    onEdgesChange: onEdgesChange,
                    nodeTypes: nodeTypes,
                    edgeTypes: edgeTypes,
                    onNodeClick: onNodeClick,
                    onPaneClick: onPaneClick,
                    fitView: true,
                    fitViewOptions: {
                        padding: 0.2
                    },
                    className: "bg-slate-50",
                    proOptions: {
                        hideAttribution: true
                    },
                    panOnDrag: !isTextSelectionMode,
                    nodesDraggable: !isTextSelectionMode,
                    nodesConnectable: !isTextSelectionMode,
                    selectionMode: isTextSelectionMode ? __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectionMode"].Full : __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SelectionMode"].Partial,
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$background$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Background"], {
                            color: "#94a3b8",
                            gap: 20,
                            size: 1,
                            style: {
                                opacity: 0.3
                            }
                        }, void 0, false, {
                            fileName: "[project]/app/page.tsx",
                            lineNumber: 755,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$controls$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Controls"], {
                            className: "!bg-white !shadow-xl !border-slate-100 !rounded-xl !p-1"
                        }, void 0, false, {
                            fileName: "[project]/app/page.tsx",
                            lineNumber: 756,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$minimap$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["MiniMap"], {
                            className: "!bg-white !shadow-xl !border-slate-100 !rounded-xl !overflow-hidden",
                            nodeColor: "#e0e7ff",
                            nodeStrokeColor: "#a5b4fc",
                            maskColor: "rgba(15, 23, 42, 0.03)",
                            zoomable: true,
                            pannable: true
                        }, void 0, false, {
                            fileName: "[project]/app/page.tsx",
                            lineNumber: 757,
                            columnNumber: 13
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/app/page.tsx",
                    lineNumber: 737,
                    columnNumber: 11
                }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "flex flex-col items-center justify-center h-full gap-3 text-slate-400 select-none bg-slate-50",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            className: "text-6xl",
                            children: "📐"
                        }, void 0, false, {
                            fileName: "[project]/app/page.tsx",
                            lineNumber: 768,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                            className: "text-base font-semibold text-slate-800",
                            children: "El espacio de trabajo está vacío"
                        }, void 0, false, {
                            fileName: "[project]/app/page.tsx",
                            lineNumber: 769,
                            columnNumber: 13
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/app/page.tsx",
                    lineNumber: 767,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/app/page.tsx",
                lineNumber: 735,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/app/page.tsx",
        lineNumber: 641,
        columnNumber: 5
    }, this);
}
_s(Home, "aX2gpUrBOEt/8hYzFOFxCKtAi5I=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useNodesState"],
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$reactflow$2f$core$2f$dist$2f$esm$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEdgesState"]
    ];
});
_c = Home;
var _c;
__turbopack_context__.k.register(_c, "Home");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=app_1_0z576._.js.map