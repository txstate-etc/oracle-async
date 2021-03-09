import oracledb, { BindParameters, Connection, ExecuteOptions, Pool, PoolAttributes } from 'oracledb'
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

export interface InternalOptions extends QueryOptions, ExecuteOptions {
  rowsAsArray?: boolean
}

export interface StreamOptions extends QueryOptions {
  highWaterMark?: number
  rowsAsArray?: boolean
}

interface canBeStringed {
  toString: () => string
}
interface BindObject { [keys: string]: BindParam }
type BindParam = number|string|null|Date|Buffer|canBeStringed|BindObject
type ColTypes = number|string|null|Date|Buffer
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

function arrayToObject<ReturnType> (row: any[], colnames: string[]) {
  const obj: Record<string, any> = {}
  for (let i = 0; i < colnames.length; i++) {
    obj[colnames[i]] = row[i]
  }
  return obj as ReturnType
}

export class Queryable {
  constructor (protected conn?: Connection, protected queryOptions?: GlobalQueryOptions) {
  }

  async queryWithConn <ReturnType = DefaultReturnType> (conn: Connection, sql: string, binds?: BindInput, options?: InternalOptions) {
    try {
      const result = await conn.execute<ReturnType>(sql, binds ?? {}, { autoCommit: options?.autoCommit ?? true, outFormat: oracledb.OUT_FORMAT_ARRAY })
      if (result.rows && result.metaData && !options?.rowsAsArray) {
        const colnames = options?.lowerCaseColumns ?? this.queryOptions?.lowerCaseColumns
          ? result.metaData.map(md => md.name.toLocaleLowerCase())
          : result.metaData.map(md => md.name)
        const ret: ReturnType[] = []
        for (const row of result.rows as any[]) ret.push(arrayToObject(row, colnames))
        result.rows = ret
      }
      return result
    } catch (e) {
      e.clientstack = e.stack
      e.stack = (new Error().stack ?? '')
      Error.captureStackTrace(e, this.queryWithConn)
      e.message = `${e.message as string}
${sql}`
      throw e
    }
  }

  async query<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: InternalOptions) {
    if (!this.conn) throw new Error('Queryable was not given a connection. Query method must be overridden in subclass.')
    return await this.queryWithConn<ReturnType>(this.conn, sql, binds, { ...options, autoCommit: false })
  }

  async getval<ReturnType = ColTypes> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const result = await this.query<[ReturnType]>(sql, binds, { ...options, rowsAsArray: true })
    return result.rows?.[0]?.[0]
  }

  async getvals<ReturnType = ColTypes> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const result = await this.query<[ReturnType]>(sql, binds, { ...options, rowsAsArray: true })
    return result.rows?.map(r => r[0]) ?? []
  }

  async getrow<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.getall<ReturnType>(sql, binds, options)
    if (results?.length > 0) return results?.[0]
  }

  async getall<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.query<ReturnType>(sql, binds, options)
    return results.rows ?? [] as ReturnType[]
  }

  async getallArray<ReturnType = ColTypes[]> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.query<ReturnType>(sql, binds, { ...options, rowsAsArray: true })
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

  protected feedStream<ReturnType> (conn: Connection, stream: GenericReadable<ReturnType>, sql: string, binds: BindInput, stacktrace: string|undefined, options: StreamOptions = {}) {
    const req = conn.queryStream(sql, binds, { outFormat: oracledb.OUT_FORMAT_ARRAY })

    stream._read = () => {
      req.resume()
    }
    stream._destroy = (err: Error, cb) => {
      if (err) stream.emit('error', err)
      req.destroy()
      cb()
    }
    if (!options.rowsAsArray) {
      let colnames: string[] = []
      req.on('metadata', (metadata: oracledb.Metadata<ReturnType>[]) => {
        colnames = options?.lowerCaseColumns ?? this.queryOptions?.lowerCaseColumns
          ? metadata.map(md => md.name.toLocaleLowerCase())
          : metadata.map(md => md.name)
      })
      req.on('data', row => {
        if (!stream.push(arrayToObject<ReturnType>(row, colnames))) req.pause()
      })
    } else {
      req.on('data', row => {
        if (!stream.push(row)) req.pause()
      })
    }
    req.on('metadata', (metadata: oracledb.Metadata<ReturnType>[]) => stream.emit('metadata', metadata))
    req.on('error', (err) => {
      (err as any).clientstack = err.stack
      err.stack = (stacktrace ?? '').replace(/^Error:/, `Error: ${err.message ?? ''}`)
      stream.destroy(err)
    })
    req.on('end', () => {
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
      saveAsPrepared: options?.saveAsPrepared,
      rowsAsArray: options?.rowsAsArray
    }
    const streamOptions = {
      highWaterMark: options?.highWaterMark
    }
    const stream = new Readable({ ...streamOptions, objectMode: true, autoDestroy: true }) as GenericReadable<ReturnType>
    stream._read = () => {}
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

  streamArray<ReturnType = ColTypes[]> (sql: string, options: StreamOptions): GenericReadable<ReturnType>
  streamArray<ReturnType = ColTypes[]> (sql: string, binds?: BindInput, options?: StreamOptions): GenericReadable<ReturnType>
  streamArray<ReturnType = ColTypes[]> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    return this.stream<ReturnType>(sql, bindsOrOptions, { ...options, rowsAsArray: true })
  }

  iterator<ReturnType = DefaultReturnType> (sql: string, options: StreamOptions): StreamIterator<DefaultReturnType>
  iterator<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: StreamOptions): StreamIterator<DefaultReturnType>
  iterator<ReturnType = DefaultReturnType> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    const ret = this.stream<ReturnType>(sql, bindsOrOptions, options)[Symbol.asyncIterator]()
    return ret
  }

  in (binds: BindInput, newbinds: BindParam[]) {
    const inElements: string[] = []
    if (Array.isArray(binds)) {
      for (const bind of newbinds) {
        if (Array.isArray(bind)) { // tuple
          inElements.push(`(${bind.map((b, i) => `:${binds.length + i}`).join(',')})`)
          binds.push(...bind)
        } else { // normal
          inElements.push(`:${binds.length}`)
          binds.push(bind as any)
        }
      }
    } else {
      let startindex = Object.keys(binds).length
      for (const bind of newbinds) {
        if (Array.isArray(bind)) { // tuple
          inElements.push(`(${bind.map((str, i) => `:${i + startindex}`).join(',')})`)
          for (let i = 0; i < bind.length; i++) {
            binds[`${i + startindex}`] = bind[i]
          }
          startindex += bind.length
        } else { // normal
          inElements.push(`:${startindex}`)
          binds[`${startindex}`] = bind as any
          startindex++
        }
      }
    }
    return inElements.join(',')
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
      connectString: `${host}:${port}/${service}`,
      ...config,
      user: config?.user ?? process.env.ORACLE_USER ?? process.env.DB_USER ?? 'system',
      password: config?.password ?? process.env.ORACLE_PASS ?? process.env.ORACLE_PASSWORD ?? process.env.DB_PASS ?? process.env.DB_PASSWORD ?? 'oracle',
      ...(poolSizeString ? { poolMax: parseInt(poolSizeString) } : {})
    }
    this.queryOptions = {
      lowerCaseColumns: config?.lowerCaseColumns ?? !!process.env.ORACLE_LOWERCASE
    }
  }

  setQueryOptions (opts: GlobalQueryOptions) {
    this.queryOptions = { ...this.queryOptions, ...opts }
  }

  async query<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    await this.wait()
    const conn = await this.pool!.getConnection()
    try {
      return await this.queryWithConn<ReturnType>(conn, sql, binds, { ...options, autoCommit: true })
    } finally {
      await conn.close()
    }
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
      if (stream.destroyed) await conn.close()
      else {
        stream.on('close', () => { conn.close().catch(e => console.error(e)) })
        this.feedStream(conn, stream, sql, binds, stacktrace, queryOptions)
      }
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
