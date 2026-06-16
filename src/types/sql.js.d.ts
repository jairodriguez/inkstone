declare module 'sql.js' {
  export interface Database {
    run(sql: string, params?: Array<string | number | Uint8Array | null | bigint>): Database;
    exec(sql: string, params?: Array<string | number | Uint8Array | null | bigint>): QueryResult[];
    export(): Uint8Array;
    close(): void;
    prepare(sql: string): Statement;
    getRowsModified(): number;
  }

  export interface Statement {
    bind(params?: Array<string | number | Uint8Array | null | bigint> | Record<string, unknown>): boolean;
    step(): boolean;
    get(): unknown[];
    getAsObject(): Record<string, unknown>;
    free(): boolean;
    reset(): boolean;
  }

  export interface QueryResult {
    columns: string[];
    values: unknown[][];
  }

  export type SqlJsStatic = {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  };

  export default function initSqlJs(config?: { locateFile?: (filename: string) => string }): Promise<SqlJsStatic>;
}
