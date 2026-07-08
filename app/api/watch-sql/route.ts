// app/api/watch-sql/route.ts
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Separador que se inserta entre el contenido de cada archivo combinado,
// dejando claro de dónde viene cada bloque de SQL dentro del editor.
function buildHeader(filePath: string) {
  return `-- ============================================================\n-- Archivo: ${filePath}\n-- ============================================================\n`;
}

export async function GET(req: NextRequest) {
  // Soporta múltiples archivos: ?path=a.sql&path=b.sql&path=c.sql
  // Se mantiene compatibilidad retro con la forma anterior de un solo `path`.
  const filePaths = req.nextUrl.searchParams.getAll('path').filter(Boolean);

  if (filePaths.length === 0) {
    return new Response('No se especificó ningún archivo', { status: 400 });
  }

  const missing = filePaths.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    return new Response(`Archivo(s) no encontrado(s): ${missing.join(', ')}`, { status: 404 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      // Lee y concatena el contenido actual de todos los archivos vinculados,
      // en el mismo orden en que fueron seleccionados/enviados.
      const buildCombinedContent = () => {
        const parts: string[] = [];
        for (const filePath of filePaths) {
          try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            parts.push(`${buildHeader(filePath)}\n${raw}`);
          } catch {
            // guardado atómico: el archivo puede desaparecer un instante;
            // se omite ese archivo en esta ronda y se reintentará en el
            // siguiente evento de cambio.
          }
        }
        return parts.join('\n\n');
      };

      const send = () => {
        if (closed) return;
        const content = buildCombinedContent();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
      };

      send(); // contenido inicial combinado

      // Se vigila cada CARPETA involucrada (no cada archivo individualmente),
      // así seguimos enterándonos aunque el editor borre y recree el archivo
      // al guardar. Varios archivos vinculados pueden compartir carpeta, así
      // que solo se crea un watcher por carpeta única.
      const watchedDirs = new Map<string, Set<string>>();
      for (const filePath of filePaths) {
        const dir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        if (!watchedDirs.has(dir)) watchedDirs.set(dir, new Set());
        watchedDirs.get(dir)!.add(fileName);
      }

      const watchers: fs.FSWatcher[] = [];
      for (const [dir, fileNames] of watchedDirs) {
        try {
          const watcher = fs.watch(dir, { persistent: true }, (_eventType, changedFile) => {
            if (changedFile && fileNames.has(changedFile)) send();
          });
          watchers.push(watcher);
        } catch {
          // Si una carpeta puntual no se puede vigilar (permisos, unidad de
          // red desmontada, etc.) seguimos con el resto sin romper el stream.
        }
      }

      req.signal.addEventListener('abort', () => {
        closed = true;
        watchers.forEach((w) => w.close());
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}