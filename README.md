# PostgreSQL Schema Visualizer 📊

A powerful, interactive database schema visualizer that parses PostgreSQL DDL and renders beautiful Entity-Relationship (ER) diagrams. Built with Next.js and React Flow, it features smart dynamic edge routing, `dbdiagram.io`-style cardinality badges, animated relationship flows, and a unique text-selection mode for easy copying.

## ✨ Key Features

- 🚀 **Instant Parsing:** Supports `CREATE TABLE`, `ALTER TABLE`, and `CREATE INDEX` statements directly from raw SQL text.
- 🎨 **Smart Routing:** Dynamic "floating handles" ensure connection lines always take the shortest path, avoiding messy overlaps.
- 🔢 **Clear Cardinalities:** Visual badges (`1`, `0..1`, `*`) with automatic vertical staggering to prevent overlapping on complex relationships.
-  **Focus Mode:** Click any table to dim unrelated entities and highlight specific foreign key paths.
-  **Text Selection Mode:** Hold `Ctrl`/`Cmd` to easily select and copy column names or data types directly from the canvas without disrupting the graph.
- 🔄 **Animated Flows:** Visual indicators showing the exact direction of Foreign Key relationships.

## 🛠️ Tech Stack

- **Framework:** [Next.js](https://nextjs.org/) (App Router)
- **Language:** [TypeScript](https://www.typescriptlang.org/)
- **Graph Engine:** [React Flow](https://reactflow.dev/)
- **Layout Algorithm:** [Dagre](https://github.com/dagrejs/dagre)
- **SQL Parser:** [pgsql-ast-parser](https://github.com/oguimbal/pgsql-ast-parser)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/)

## 🚀 Getting Started

First, install the dependencies:

```bash
npm install
npm run dev