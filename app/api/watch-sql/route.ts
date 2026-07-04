// app/api/watch-sql/route.ts
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get('path');
  if (!filePath || !fs.existsSync(filePath)) {
    return new Response('Archivo no encontrado', { status: 404 });
  }

  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const send = () => {
        if (closed) return;
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
        } catch {
          // guardado atómico: el archivo puede desaparecer un instante
        }
      };

      send(); // contenido inicial

      // Se vigila la CARPETA, no el archivo: así seguimos enterándonos
      // aunque el editor borre y recree el archivo al guardar.
      const watcher = fs.watch(dir, { persistent: true }, (_eventType, changedFile) => {
        if (changedFile === fileName) send();
      });

      req.signal.addEventListener('abort', () => {
        closed = true;
        watcher.close();
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