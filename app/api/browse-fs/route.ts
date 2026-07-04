import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const dirParam = req.nextUrl.searchParams.get('dir') || os.homedir();

  try {
    const entries = await fs.readdir(dirParam, { withFileTypes: true });

    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const files = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.sql'))
      .map((e) => e.name)
      .sort();

    return NextResponse.json({
      currentPath: dirParam,
      parentPath: path.dirname(dirParam),
      dirs,
      files,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}