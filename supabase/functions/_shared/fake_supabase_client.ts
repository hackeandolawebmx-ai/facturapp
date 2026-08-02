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
  tables: Record<string, Row[]> = {
    users: [], invoices: [], chat_messages: [], debug_logs: [],
    user_rfcs: [], rate_limit_attempts: [], authorized_senders: [],
  };
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

  /** Storage simulado en memoria (Fase M13): `bucket/ruta` → bytes.
   *
   * Solo cubre upload y download, que es todo lo que usa pdf_storage.ts. */
  archivos: Record<string, Uint8Array> = {};

  storage = {
    from: (bucket: string) => ({
      // deno-lint-ignore require-await
      upload: async (ruta: string, contenido: Uint8Array, _opciones?: unknown) => {
        this.archivos[`${bucket}/${ruta}`] = contenido;
        return { data: { path: ruta }, error: null };
      },
      // deno-lint-ignore require-await
      download: async (ruta: string) => {
        const bytes = this.archivos[`${bucket}/${ruta}`];
        if (!bytes) return { data: null, error: { message: "no existe" } };
        // El cast evita la fricción entre ArrayBufferLike y ArrayBuffer en los
        // tipos de Deno; en tiempo de ejecución un Uint8Array es un BlobPart
        // perfectamente válido.
        return { data: new Blob([bytes as BlobPart]), error: null };
      },
      /** Fase M15 — lo usa eliminarPdf(). Igual que el Storage real: quitar
       * una ruta que no existe no es un error (es idempotente). */
      // deno-lint-ignore require-await
      remove: async (rutas: string[]) => {
        for (const ruta of rutas) delete this.archivos[`${bucket}/${ruta}`];
        return { data: rutas.map((path) => ({ name: path })), error: null };
      },
    }),
  };

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
  private negados: Array<[string, unknown]> = [];
  private selectCols: string | null = null;
  private mode: "select" | "insert" | "update" | "delete" = "select";
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

  /** Fase M11 — lo usa rfcTomadoPorOtro() para excluirse a sí mismo. */
  neq(col: string, value: unknown) {
    this.negados.push([col, value]);
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

  /** Fase M14 — lo usa eliminarRfc(). */
  delete() {
    this.mode = "delete";
    return this;
  }

  private matchRows(): Row[] {
    const rows = this.client.tables[this.table].filter((row) =>
      this.filters.every(([col, val]) => row[col] === val) &&
      this.negados.every(([col, val]) => row[col] !== val)
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

  /** Filas resultantes, aplicando el patch si el modo es update.
   *
   * Centraliza el efecto del update para que `maybeSingle()`, `single()` y
   * `then()` se comporten igual. Antes solo `then()` lo aplicaba, así que
   * `.update().select().maybeSingle()` —el patrón que usa updateUserRfc—
   * devolvía la fila SIN modificar y dejaba la tabla intacta. El fake decía
   * que el update funcionaba cuando no hacía nada. */
  private resolverFilas(): Row[] {
    const rows = this.matchRows();
    if (this.mode === "update" && this.updatePatch) {
      for (const row of rows) Object.assign(row, this.updatePatch);
    }
    if (this.mode === "delete") {
      const tabla = this.client.tables[this.table];
      for (const row of rows) {
        const i = tabla.indexOf(row);
        if (i !== -1) tabla.splice(i, 1);
      }
    }
    return rows;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.mode === "insert") throw new Error("maybeSingle() tras insert() no soportado en el fake");
    const rows = this.resolverFilas();
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
    const rows = this.resolverFilas();
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
    const rows = this.resolverFilas().map((r) => this.project(r));
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  }
}
