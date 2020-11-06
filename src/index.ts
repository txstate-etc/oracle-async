import oracledb, { BindParameter, BindParameters, Connection, ExecuteOptions, Pool, PoolAttributes } from 'oracledb'
import { Readable } from 'stream'

export interface GlobalQueryOptions {
  lowerCaseColumns?: boolean
}

export interface PoolOptions extends PoolAttributes, GlobalQueryOptions {
  server?: string
  port?: string|number
  service?: string
}

export interface QueryOptions extends GlobalQueryOptions {
  /* currently does nothing */
  saveAsPrepared?: boolean
}

export interface StreamOptions extends QueryOptions {
  highWaterMark?: number
}

interface canBeStringed {
  toString: () => string
}
interface BindObject { [keys: string]: BindParam }
type BindParam = number|string|null|Date|Buffer|canBeStringed|BindObject
type ColTypes = BindParam
interface DefaultReturnType { [keys: string]: ColTypes }
type BindInput = BindParameters

interface StreamIterator <ReturnType> {
  [Symbol.asyncIterator]: () => StreamIterator<ReturnType>
  next: () => Promise<{ done: boolean, value: ReturnType }>
  return: () => Promise<{ done: boolean, value: ReturnType }>
}

interface GenericReadable<T> extends Readable {
  [Symbol.asyncIterator]: () => StreamIterator<T>
}

function lowerCaseRow <T> (row: T) {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.toLowerCase(), v])
  ) as T
}

export class Queryable {
  constructor (protected conn?: Connection, protected queryOptions?: GlobalQueryOptions) {
  }

  async queryWithConn <ReturnType = DefaultReturnType> (conn: Connection, sql: string, binds?: BindInput, options?: ExecuteOptions) {
    try {
      return await conn.execute<ReturnType>(sql, binds ?? {}, { ...options, outFormat: oracledb.OUT_FORMAT_OBJECT })
    } catch (e) {
      e.clientstack = e.stack
      e.stack = (new Error().stack ?? '')
      Error.captureStackTrace(e, this.queryWithConn)
      e.message = `${e.message as string}
${sql}`
      throw e
    }
  }

  async query<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    if (!this.conn) throw new Error('Queryable was not given a connection. Query method must be overridden in subclass.')
    return await this.queryWithConn<ReturnType>(this.conn, sql, binds, { autoCommit: false })
  }

  async getval<ReturnType = ColTypes> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const row = await this.getrow<[ReturnType]>(sql, binds, options)
    if (row) return Object.values(row)[0]
  }

  async getvals<ReturnType = ColTypes> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const rows = await this.getall<[ReturnType]>(sql, binds, options)
    return rows.map(r => Object.values(r)[0])
  }

  async getrow<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.getall<ReturnType>(sql, binds, options)
    if (results?.length > 0) return results?.[0]
  }

  async getall<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.query<ReturnType>(sql, binds, options)
    if (options?.lowerCaseColumns ?? this.queryOptions?.lowerCaseColumns) {
      return (results.rows ?? []).map(r => lowerCaseRow(r))
    }
    return results.rows ?? [] as ReturnType[]
  }

  async execute (sql: string, binds?: BindInput, options?: QueryOptions) {
    await this.query(sql, binds, options)
    return true
  }

  async update (sql: string, binds?: BindInput, options?: QueryOptions) {
    const result = await this.query(sql, binds, options)
    return result.rowsAffected
  }

  async insert <InsertType = number>(sql: string, binds?: BindInput, options?: QueryOptions & { insertId?: string }): Promise<InsertType> {
    if (!/RETURN .*? into :insertid$/i.test(sql) && options?.insertId) sql += ` RETURN ${options.insertId} INTO :insertid`
    if (/RETURN .*? into :insertid$/i.test(sql)) {
      const outbind = { type: oracledb.NUMBER, dir: oracledb.BIND_OUT }
      if (!binds) binds = {}
      if (Array.isArray(binds)) binds.push(outbind)
      else binds.insertid = outbind
    }
    const result = await this.query(sql, binds, options)
    const insertid = Array.isArray(result?.outBinds) ? result.outBinds[result.outBinds.length - 1] : result?.outBinds?.insertid
    return insertid?.[0] ?? 0
  }

  protected feedStream<ReturnType> (conn: Connection, stream: GenericReadable<ReturnType>, sql: string, binds: BindInput, stacktrace: string|undefined, options: QueryOptions = {}) {
    if (stream.destroyed) return

    const req = conn.queryStream(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT })

    let canceled = false
    stream._read = () => {
      req.resume()
    }
    stream._destroy = (err: Error, cb) => {
      if (err) stream.emit('error', err)
      canceled = true
      req.resume()
      cb()
    }
    req.on('data', row => {
      if (options?.lowerCaseColumns ?? this.queryOptions?.lowerCaseColumns) row = lowerCaseRow(row)
      if (canceled) return
      if (!stream.push(row)) {
        req.pause()
      }
    })
    req.on('error', (err) => {
      if (canceled) return
      (err as any).clientstack = err.stack
      err.stack = (stacktrace ?? '').replace(/^Error:/, `Error: ${err.message ?? ''}`)
      stream.emit('error', err)
    })
    req.on('end', () => {
      if (canceled) return
      stream.push(null)
    })
  }

  protected handleStreamOptions<ReturnType> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    let binds
    if (!options && (bindsOrOptions?.highWaterMark || bindsOrOptions?.objectMode)) {
      options = bindsOrOptions
      binds = []
    } else {
      binds = bindsOrOptions
    }
    const queryOptions = {
      saveAsPrepared: options?.saveAsPrepared
    }
    const streamOptions = {
      highWaterMark: options?.highWaterMark
    }
    const stream = new Readable({ ...streamOptions, objectMode: true }) as GenericReadable<ReturnType>
    stream._read = () => {}
    stream._destroy = (err: Error, cb) => {
      if (err) stream.emit('error', err)
      stream.emit('close')
      cb()
    }
    const stacktraceError: { stack?: string } = {}
    Error.captureStackTrace(stacktraceError, this.handleStreamOptions)
    return { binds, queryOptions, stream, stacktrace: stacktraceError.stack }
  }

  stream<ReturnType = DefaultReturnType> (sql: string, options: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = DefaultReturnType> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    const { binds, queryOptions, stream, stacktrace } = this.handleStreamOptions<ReturnType>(sql, bindsOrOptions, options)
    this.feedStream(this.conn!, stream, sql, binds, stacktrace, queryOptions)
    return stream
  }

  iterator<ReturnType = DefaultReturnType> (sql: string, options: StreamOptions): StreamIterator<DefaultReturnType>
  iterator<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: StreamOptions): StreamIterator<DefaultReturnType>
  iterator<ReturnType = DefaultReturnType> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    const ret = this.stream<ReturnType>(sql, bindsOrOptions, options)[Symbol.asyncIterator]()
    return ret
  }

  in (binds: BindInput, newbinds: BindParam[]) {
    let startindex = 0
    if (Array.isArray(binds)) {
      startindex = binds.length
      binds.push(...newbinds as any[])
    } else {
      startindex = Object.keys(binds).length
      for (let i = 0; i < newbinds.length; i++) {
        binds[String(i + startindex)] = newbinds[i]?.toString ? newbinds[i]?.toString() : newbinds[i] as Exclude<BindParam, canBeStringed>
      }
    }
    return Array.from({ length: newbinds.length }, (v, k) => k + startindex).map(n => `:${n}`).join(',')
  }
}

export default class Db extends Queryable {
  protected pool?: Pool
  protected pooloptions: PoolAttributes
  protected connectpromise!: Promise<void>

  constructor (config?: Partial<PoolOptions>) {
    super()
    let poolSizeString = process.env.ORACLE_POOL_SIZE ?? process.env.DB_POOL_SIZE ?? process.env.UV_THREADPOOL_SIZE
    if (process.env.UV_THREADPOOL_SIZE) poolSizeString = String(Math.min(parseInt(poolSizeString!), parseInt(process.env.UV_THREADPOOL_SIZE)))
    const host = config?.server ?? process.env.ORACLE_HOST ?? process.env.ORACLE_SERVER ?? process.env.DB_HOST ?? process.env.DB_SERVER ?? 'oracle'
    const port = config?.port ?? parseInt(process.env.ORACLE_PORT ?? process.env.DB_PORT ?? '1521')
    const service = config?.service ?? process.env.ORACLE_SERVICE ?? process.env.DB_SERVICE ?? 'xe'
    this.pooloptions = {
      queueMax: 1000,
      ...config,
      connectString: `${host}:${port}/${service}`,
      user: config?.user ?? process.env.ORACLE_USER ?? process.env.DB_USER ?? 'system',
      password: config?.password ?? process.env.ORACLE_PASS ?? process.env.ORACLE_PASSWORD ?? process.env.DB_PASS ?? process.env.DB_PASSWORD ?? 'oracle',
      ...(poolSizeString ? { poolMax: parseInt(poolSizeString) } : {})
    }
    this.queryOptions = {
      lowerCaseColumns: config?.lowerCaseColumns ?? !!process.env.ORACLE_LOWERCASE
    }
  }

  async query<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    await this.wait()
    const conn = await this.pool!.getConnection()
    const ret = await this.queryWithConn<ReturnType>(conn, sql, binds, { autoCommit: true })
    await conn.close()
    return ret
  }

  async connect () {
    let errorcount = 0
    while (true) {
      try {
        this.pool = await oracledb.createPool(this.pooloptions)
        await this.pool.getConnection()
        return
      } catch (error) {
        if (errorcount > 2) console.error(error.message)
        errorcount++
        // sleep and try again
        if (errorcount > 1) console.log('Unable to connect to Oracle database, trying again in 2 seconds.')
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  async close () {
    await this.wait()
    await this.pool!.close(1)
  }

  async rawpool () {
    await this.wait()
    return this.pool as Pool
  }

  async wait () {
    if (typeof this.connectpromise === 'undefined') this.connectpromise = this.connect()
    return await this.connectpromise
  }

  stream<ReturnType = DefaultReturnType> (sql: string, options: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = DefaultReturnType> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    const { binds, queryOptions, stream, stacktrace } = this.handleStreamOptions<ReturnType>(sql, bindsOrOptions, options)
    this.wait().then(async () => {
      const conn = await this.pool!.getConnection()
      stream.on('end', () => { conn.close().catch(e => console.error(e)) })
      stream.on('error', () => { conn.close().catch(e => console.error(e)) })
      stream.on('close', () => { conn.close().catch(e => console.error(e)) })
      if (stream.destroyed) await conn.close()
      this.feedStream(conn, stream, sql, binds, stacktrace, queryOptions)
    }).catch(e => stream.emit('error', e))
    return stream
  }

  async transaction <ReturnType> (callback: (db: Queryable) => Promise<ReturnType>, options?: { retries?: number }): Promise<ReturnType> {
    await this.wait()
    const transaction = await this.pool!.getConnection()
    const db = new Queryable(transaction, this.queryOptions)
    try {
      const ret = await callback(db)
      await transaction.commit()
      await transaction.close()
      return ret
    } catch (e) {
      if (e.errorNum === 60 && options?.retries) { // deadlock
        await transaction.close()
        return await this.transaction(callback, { ...options, retries: options.retries - 1 })
      } else {
        // rollback unnecessary on deadlock, in fact it throws a new error, which is problematic
        if (e.errorNum !== 60) await transaction.rollback()
        await transaction.close()
        throw e
      }
    }
  }
}
