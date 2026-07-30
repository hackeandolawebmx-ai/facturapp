/**
 * Cliente Supabase FALSO, solo para tests (Fase M4).
 *
 * ⚠️ No es Postgres real ni ejercita RLS/constraints/tipos de columna. Solo
 * implementa la porción exacta de la API que usan users.ts/invoices.ts
 * (schema().from().select().eq().maybeSingle()/single(), insert()), sobre
 * arrays en memoria. No hay conexión a un Supabase real disponible en este
 * entorno para probar contra Postgres de verdad — este fake es la mejor
 * verificación posible de la lógica de orquestación sin ella. El smoke
 * test manual post-deploy (ver README) es lo que valida contra Postgres
 * real.
 */

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export class FakeSupabaseClient {
  tables: Record<string, Row[]> = { users: [], invoices: [], chat_messages: [], debug_logs: [] };
  private nextId: Record<string, number> = { users: 1, invoices: 1 };

  /** Respuestas simuladas de `rpc()`, por nombre de función (Fase M8).
   *
   * Se simulan en vez de reimplementar la lógica SQL: `registrar_intento`
   * vive en Postgres (0006_rate_limit.sql) justo porque necesita atomicidad,
   * y una reimplementación en TypeScript no probaría eso — solo probaría la
   * reimplementación. Lo que sí se puede probar aquí es que el llamador
   * reaccione bien a cada respuesta posible. */
  rpcHandlers: Record<string, (args: Row) => { data: unknown; error: unknown }> = {};
  rpcLlamadas: Array<{ nombre: string; args: Row }> = [];

  schema(_name: string) {
    return this;
  }

  from(table: string) {
    return new FakeQueryBuilder(this, table);
  }

  // deno-lint-ignore require-await
  async rpc(nombre: string, args: Row) {
    this.rpcLlamadas.push({ nombre, args });
    const handler = this.rpcHandlers[nombre];
    if (!handler) return { data: null, error: { message: `rpc no simulada: ${nombre}` } };
    return handler(args);
  }
}

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private selectCols: string | null = null;
  private mode: "select" | "insert" | "update" = "select";
  private insertRow: Row | null = null;
  private updatePatch: Row | null = null;
  private orderBy: { col: string; ascending: boolean } | null = null;
  private limitN: number | null = null;

  constructor(private client: FakeSupabaseClient, private table: string) {}

  select(cols: string) {
    this.selectCols = cols;
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push([col, value]);
    return this;
  }

  order(col: string, options?: { ascending?: boolean }) {
    this.orderBy = { col, ascending: options?.ascending ?? true };
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  insert(row: Row) {
    this.mode = "insert";
    this.insertRow = row;
    return this;
  }

  update(patch: Row) {
    this.mode = "update";
    this.updatePatch = patch;
    return this;
  }

  private matchRows(): Row[] {
    const rows = this.client.tables[this.table].filter((row) =>
      this.filters.every(([col, val]) => row[col] === val)
    );
    if (this.orderBy) {
      const { col, ascending } = this.orderBy;
      rows.sort((a, b) => {
        if (a[col] < b[col]) return ascending ? -1 : 1;
        if (a[col] > b[col]) return ascending ? 1 : -1;
        return 0;
      });
    }
    return this.limitN !== null ? rows.slice(0, this.limitN) : rows;
  }

  private project(row: Row): Row {
    if (!this.selectCols) return row;
    const cols = this.selectCols.split(",").map((c) => c.trim());
    const out: Row = {};
    for (const c of cols) out[c] = row[c];
    return out;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.mode === "insert") throw new Error("maybeSingle() tras insert() no soportado en el fake");
    const rows = this.matchRows();
    return { data: rows.length > 0 ? this.project(rows[0]) : null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: null }> {
    if (this.mode === "insert" && this.insertRow) {
      const table = this.client.tables[this.table];
      const id = table.length + 1;
      const row = { id, ...this.insertRow };
      table.push(row);
      return { data: this.project(row), error: null };
    }
    const rows = this.matchRows();
    return { data: rows.length > 0 ? this.project(rows[0]) : null, error: null };
  }

  // insert(...) sin .select().single() encadenado (caso de invoices en
  // ingestInvoice) — el propio builder es "thenable" para poder hacer
  // `await supabase.from(...).insert({...})` directamente.
  then<T>(
    resolve: (value: { data: Row[] | null; error: null }) => T,
    // deno-lint-ignore no-explicit-any
    reject?: (reason: unknown) => any,
  ) {
    if (this.mode === "insert" && this.insertRow) {
      const table = this.client.tables[this.table];
      const id = table.length + 1;
      const row = { id, ...this.insertRow };
      table.push(row);
      return Promise.resolve({ data: [row], error: null }).then(resolve, reject);
    }
    if (this.mode === "update" && this.updatePatch) {
      const updated = this.matchRows();
      for (const row of updated) Object.assign(row, this.updatePatch);
      return Promise.resolve({ data: updated.map((r) => this.project(r)), error: null }).then(resolve, reject);
    }
    const rows = this.matchRows().map((r) => this.project(r));
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  }
}
