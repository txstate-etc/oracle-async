import oracledb, { type BindParameters, type Connection, type ExecuteOptions, type Pool, type PoolAttributes } from 'oracledb'
import { Readable } from 'stream'

/**
 * A place to put SQL options that we want universally used with the connection.
 * This would apply to DDL as well as DML queries. */
export interface GlobalQueryOptions {
  lowerCaseColumns?: boolean
}

/**
 * A place to put SQL options specific to the DML queries we want to execute.
 * Currently used to control behavior that is custom to this library. */
export interface QueryOptions extends GlobalQueryOptions {
  /** Option to save the prepared statement for reuse. Not currently implemented. See `Db.rawpool()` for custom pool handling. */
  saveAsPrepared?: boolean

  /** This query should not be sent to a replica server, default false for reads, true for writes. */
  mainServer?: boolean

  /** Time in milliseconds to allow this query to execute before cancelling. Default is set in the pool options. */
  callTimeout?: number
}

/** Extention of QueryOptions and ExecuteOptions to include `rowsAsArrays?: boolean` to specify raw results vs the default of json'd results. */
export interface InternalOptions extends QueryOptions, ExecuteOptions {
  /**
   * Boolean designator. If true - return rows as they are rather than converting each record to a json object.
   * Useful if you want a smaller sized result without the coloumn name metadata interpolated into each record. */
  rowsAsArray?: boolean
}

/** Extention to QueryOptions that includes `highWaterMark?: number` and `rowsAsArrays?: boolean` for configuring stream buffer threshold and output style. */
export interface StreamOptions extends QueryOptions {
  /** The threshold number of objects to allow buffering for in the stream before pausing consumption from the underlying resource. */
  highWaterMark?: number

  /**
   * Boolean designator. If true - return rows as they are rather than converting each record to a json object.
   * Useful if you want a smaller sized result without the coloumn name metadata interpolated into each record. */
  rowsAsArray?: boolean
}

/**
 * Pool Status tracking for fallback capable PoolOptions
 * ```
 *       'up' - indicates primary connection pool is active.
 * 'readonly' - indicates the fallback/replica connection pool is active.
 *     'down' - indicates NO connection pools are active.
 * ``` */
export type PoolStatus = 'up' | 'down' | 'readonly'
/** On discussion of adding additional states for indicating status while awaiting a confirmed up or readonly connection we decided that keeping it simple
 * was desireable to prevent over complicating state handling and encumbering the PoolStatus setting with ultimately unnessary checks. */

/**
 * A custom extension of the oracledb.PoolAttributes interface used for specifying non-default oracledb.pool configuration properties and custom configuration
 * extensions of this API that aid in simplifying connection specific attributes.
 *
 * @remarks oracledb.PoolAttributes provides for the use of either `connectString` or `connectionString` - refferred to here as coonect[ion]String. oracledb.PoolAttributes
 * recommends sticking to one or the other. We will strive to stick with `connectString`.
 *
 * @remarks server, port, and service are technically not needed as they are individual parts of the composit Easy-Connect style string fields of
 * `oracledb.PoolAttributes.connectString`. However, they are extended here as as a convenience in the absense of a configured coonect[ion]String. In that event
 * a properly formated Easy-Connect string will be built using these optional extention attributes. */
export interface ConnectionOptions extends PoolAttributes {
  /** connectString?: string - Inherited from PoolAttributes. For discussion on using in conjunction with different specifier mechanisms see the following URL.
   * https://docs.oracle.com/en/database/oracle/oracle-database/18/ntcli/specifying-connection-by-using-empty-connect-string.html */
  server?: string
  port?: string | number
  service?: string
  /**
   * Sets the default callTimeout on each connection before sending a query.
   * See http://oracle.github.io/node-oracledb/doc/api.html#-412-connectioncalltimeout
   */
  callTimeout?: number
  sessionCallback?: (connection: Connection, requestedTag: string) => Promise<void>
}

/** An extention of the ConnectionOptions interface to provide for additional modifiers to how replica pools are used. */
export interface ReplicaOptions extends ConnectionOptions {
  /** Unimplemented behavior modifier. This library may be updated in the future to allow for multiple replica reader slave pools. In that event we may want to specify
   * if a pool is solely intended for failover purposes and not for multiple readers. */
  failoverOnly?: boolean
}

/** An extention of the ConnectionOptions interface that itself extends the oracledb.PoolAttributes interface. This extention is intended to provide configuration
 * options specific to managing the relationships and status between the primary pool and the replicas pools.
 *
 * @since 1.2.0
 * `replicas?: {...}` was added to allow for the specification of a fallback replicas pools to be used in the event the primary pool is unable to create a connection.
 *
 * @remarks Fallback replicas are used in conjunction with `PoolStatus` and a `recoveryTimer` to first try connecting to the fallback recovery instance if the main attributes
 * result in failed connections, and then to retry connections to the primary instance after the recoveryTimer interval has completed. In addtition, if the replica
 * attributes are used to successfully create a connection, in the scenario that the primary attributes fail, then subsequent failure of the replica attributes to work,
 * prior to the completion of the recoveryTimer interval, will start over attempts with the primary attributes and, if continued failure with those attributes, will
 * try again with the replicas attributes until a connection is made updating the PoolStatus and thus resetting the recoveryTimer interval OR the interval ends and
 * a succesful connection using the primary attributes succedes.
 */
export interface PoolOptions extends ConnectionOptions, GlobalQueryOptions {
  /** Configurable handler function that can be specified for extra handling, or logging, of PoolStatus state changes. */
  onStatus: (status: PoolStatus) => void | Promise<void>
  replicas?: ReplicaOptions[]
}

/** Used for BindParam support of generic types so long as they implement a toString() function. */
interface canBeStringed {
  toString: () => string
}
/** Allowable bind parameter/object types specification. */
type BindParam = number | string | null | Date | Buffer | canBeStringed | BindObject
// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
interface BindObject { [keys: string]: BindParam }

/** Allowable Oracle return types specification. */
type ColTypes = number | string | null | Date | Buffer
type DefaultReturnType = Record<string, ColTypes>

/** Colloquial reference to oracledb.BindParameters. */
type BindInput = BindParameters

/** Async friendly stream iteration type useful for handling very large result sets without the need for callbacks and event-emitting streams. */
interface StreamIterator <ReturnType> {
  [Symbol.asyncIterator]: () => StreamIterator<ReturnType>
  next: () => Promise<{ done?: false, value: ReturnType }>
  return: () => Promise<{ done: true, value: ReturnType }>
}
/** Async friendly stream iteration type useful for handling very large result sets without the need for callbacks and event-emitting streams. */
interface GenericReadable <T> extends Readable {
  [Symbol.asyncIterator]: () => StreamIterator<T>
}

/**
 * Utility function for converting any[], string[] pairs of arrays to a Record<string, any> object of corresponding fields.
 * Useful for converting SQL record results into JSON objects. */
function arrayToObject<ReturnType> (row: any[], colnames: string[]) {
  const obj: Record<string, any> = {}
  for (let i = 0; i < colnames.length; i++) {
    obj[colnames[i]] = row[i]
  }
  return obj as ReturnType
}

/** A base class implementing the logic specifically related to executing the different types of sql queries and getting their results in different formats. */
export class Queryable {
  constructor (protected conn?: Connection, protected queryOptions?: GlobalQueryOptions) {
  }

  /**
   * Executes the passed sql, with binds, using the conn connection and any passed options.
   * If the query executes without errors the promised result is returned. If errors are thrown the error stacktrace and sql will be logged before bubbling up the error.
   * @param conn oracledb.Connection - The connection to execute the query with.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options InternalOptions - Includes: rowsAsArray, mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns `Promise<ReturnType = DefaultReturnType>` - The result of the query.
   */
  async queryWithConn <ReturnType = DefaultReturnType> (conn: Connection, sql: string, binds?: BindInput, options?: InternalOptions) {
    try {
      let saveTimeout: number | undefined
      if (options?.callTimeout) {
        saveTimeout = conn.callTimeout
        conn.callTimeout = options.callTimeout
      }
      const result = await conn.execute<ReturnType>(sql, binds ?? {}, { autoCommit: options?.autoCommit ?? true, outFormat: oracledb.OUT_FORMAT_ARRAY })
      if (options?.callTimeout) conn.callTimeout = saveTimeout
      if (result.rows && result.metaData && !options?.rowsAsArray) {
        const colnames = options?.lowerCaseColumns ?? this.queryOptions?.lowerCaseColumns
          ? result.metaData.map(md => md.name.toLocaleLowerCase())
          : result.metaData.map(md => md.name)
        const ret: ReturnType[] = []
        for (const row of result.rows as any[]) ret.push(arrayToObject(row, colnames))
        result.rows = ret
      }
      return result
    } catch (e: any) {
      e.clientstack = e.stack
      e.stack = (new Error().stack ?? '')
      Error.captureStackTrace(e, this.queryWithConn)
      e.message = `${e.message as string}
${sql}`
      throw e
    }
  }

  /**
   * Checks for an active connection in the class and runs queryWithConn passing that connection. Throws an error if no active connections are defined in the class.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options InternalOptions - Includes: rowsAsArray, mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns `Promise<ReturnType = DefaultReturnType>` - The result of the query.
   */
  async query<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: InternalOptions) {
    if (!this.conn) throw new Error('Queryable was not given a connection. Query method must be overridden in subclass.')
    return await this.queryWithConn<ReturnType>(this.conn, sql, binds, { ...options, autoCommit: false })
  }

  /**
   * Calls query to execute the sql with binds and options passed and returns the first value of any returned results. Bubbles any errors thrown without catching.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options QueryOptions - Includes: mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns `Promise<ReturnType = ColTypes>` - The first value of any returned results.
   */
  async getval<ReturnType = ColTypes> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const result = await this.query<[ReturnType]>(sql, binds, { ...options, rowsAsArray: true })
    return result.rows?.[0]?.[0]
  }

  /**
   * Calls query to execute the sql with binds and options passed and returns an array of the first value in each row of the results. Bubbles any errors thrown without catching.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options QueryOptions - Includes: mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns `Promise<ReturnType = ColTypes>` - An array of the first value in each row of the results.
   */
  async getvals<ReturnType = ColTypes> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const result = await this.query<[ReturnType]>(sql, binds, { ...options, rowsAsArray: true })
    return result.rows?.map(r => r[0]) ?? []
  }

  /**
   * Calls getall to execute the sql with binds and options passed and returns the first row from any results. Bubbles any errors thrown without catching.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options QueryOptions - Includes: mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns `Promise<ReturnType = DefaultReturnType>` - The first row from any results.
   * @note - If there are no results, `undefined` will be the result of the return.
   */
  async getrow<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.getall<ReturnType>(sql, binds, options)
    if (results?.length > 0) return results?.[0]
  }

  /**
   * Calls query to execute the sql with binds and options passed and returns an array of the rows from any results. Bubbles any errors thrown without catching.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options QueryOptions - Includes: mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns `Promise<ReturnType = DefaultReturnType>` - An array of the rows from any results.
   * @note - If there are no results, an empty array will be the returned result.
   */
  async getall<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.query<ReturnType>(sql, binds, options)
    return results.rows ?? [] as ReturnType[]
  }

  /**
   * Calls query to execute the sql with binds and options passed and returns an array of the raw rows (doesn't convert to json) from any results.
   * Bubbles any errors thrown without catching.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options QueryOptions - Includes: mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns `Promise<ReturnType = DefaultReturnType>` - An array of the raw rows (doesn't convert to json) from any results.
   * @note - If there are no results, an empty array will be the returned result.
   */
  async getallArray<ReturnType = ColTypes[]> (sql: string, binds?: BindInput, options?: QueryOptions) {
    const results = await this.query<ReturnType>(sql, binds, { ...options, rowsAsArray: true })
    return results.rows ?? [] as ReturnType[]
  }

  /**
   * Calls query to execute the sql with binds and options passed and returns true if no errors are thrown. Bubbles any errors thrown without catching.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options QueryOptions - Includes: mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns Boolean true if no errors are thrown.
   * @note Even if you pass `options: { mainServer: false }` this will only execute against the primary pool and not any replica or failover pools.
   */
  async execute (sql: string, binds?: BindInput, options?: QueryOptions) {
    await this.query(sql, binds, { ...options, mainServer: true })
    return true
  }

  /**
   * Calls query to execute the sql with binds and options passed and returns an array of the rows from any results. Bubbles any errors thrown without catching.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options QueryOptions - Includes: mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns The number of rows affected.
   * @note Even if you pass `options: { mainServer: false }` this will only execute against the primary pool and not any replica or failover pools.
   */
  async update (sql: string, binds?: BindInput, options?: QueryOptions) {
    const result = await this.query(sql, binds, { ...options, mainServer: true })
    return result.rowsAffected
  }

  /**
   * Executes the `sql` string, with the optional `binds`, passed ensuring that a RETURN INTO is appended to the statement.
   * If passed an optional `options.insertId` string for `sql` lacking a RETURN INTO then the passed options.insertId value will be passed
   * to the query as the value to be returned in `outBinds.insertid`
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options QueryOptions - Includes: insertId, mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @param options.insertId string - An optional name passing for the outbind column name. If not specified db.insert will return 0.
   * @returns `<InsertType = number>` - TODO: I'm not following the documentation on this well enough to understand what to describe here.
   * @note Even if you pass `options: { mainServer: false }` this will only execute against the primary pool and not any replica or failover pools.
   */
  async insert <InsertType = number>(sql: string, binds?: BindInput, options?: QueryOptions & { insertId?: string }): Promise<InsertType> {
    if (!/RETURN .*? into :insertid$/i.test(sql) && options?.insertId) sql += ` RETURN ${options.insertId} INTO :insertid`
    if (/RETURN .*? into :insertid$/i.test(sql)) {
      const outbind = { type: oracledb.NUMBER, dir: oracledb.BIND_OUT }
      if (!binds) binds = {}
      if (Array.isArray(binds)) binds.push(outbind)
      else binds.insertid = outbind
    }
    const result = await this.query(sql, binds, { ...options, mainServer: true })
    const insertid = Array.isArray(result?.outBinds) ? result.outBinds[result.outBinds.length - 1] : result?.outBinds?.insertid
    return insertid?.[0] ?? 0
  }

  /** Internal function - saving review for documentation later. */
  protected feedStream<ReturnType> (conn: Connection, stream: GenericReadable<ReturnType>, sql: string, binds: BindInput, stacktrace: string | undefined, options: StreamOptions = {}) {
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

  /** Internal function - saving review for documentation later. */
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

  /** Overloaded function - saving review for documentation later. */
  stream<ReturnType = DefaultReturnType> (sql: string, options: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = DefaultReturnType> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    const { binds, queryOptions, stream, stacktrace } = this.handleStreamOptions<ReturnType>(sql, bindsOrOptions, options)
    this.feedStream(this.conn!, stream, sql, binds, stacktrace, queryOptions)
    return stream
  }

  /** Overloaded function - saving review for documentation later. */
  streamArray<ReturnType = ColTypes[]> (sql: string, options: StreamOptions): GenericReadable<ReturnType>
  streamArray<ReturnType = ColTypes[]> (sql: string, binds?: BindInput, options?: StreamOptions): GenericReadable<ReturnType>
  streamArray<ReturnType = ColTypes[]> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    return this.stream<ReturnType>(sql, bindsOrOptions, { ...options, rowsAsArray: true })
  }

  /** Overloaded function - saving review for documentation later. */
  iterator<ReturnType = DefaultReturnType> (sql: string, options: StreamOptions): StreamIterator<DefaultReturnType>
  iterator<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: StreamOptions): StreamIterator<DefaultReturnType>
  iterator<ReturnType = DefaultReturnType> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    const ret = this.stream<ReturnType>(sql, bindsOrOptions, options)[Symbol.asyncIterator]()
    return ret
  }

  /**
   * Helper function for handling the task of generating corresponding sql IN bind syntax along with adding the newbinds array to the passed in BindInput.
   * @param binds BindInput - The BindInput object to be used with the desired query. The elements of `newbinds` will be added to `binds` as the corresponding sql syntax is generated.
   * @param newbinds BindParam[] - The array of BindParam values to be added to `binds` and have corresponding sql sntax generated for it.
   * @returns The enclosed sql IN syntax needed to reference the `newbinds` values in `binds` when the generated sql statement is executed.
   * @example ```
   * const binds = { author: authorid }
   * const genres = ['fiction', 'biography', 'history']
   * const rows = db.getall(`
   *   SELECT * FROM mytable
   *    WHERE author = :author
   *      AND genre IN (${ db.in(binds, genres) })`, binds)
   * ``` */
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

/** An extention of the Queryable class handling the connection pooling, replica, failover, and recovery logic of managing the connection pools. */
export default class Db extends Queryable {
  protected pool?: Pool
  protected poolAttributes: PoolAttributes
  protected connectpromise!: Promise<void>
  public status: PoolStatus
  protected onStatus?: (status: PoolStatus) => void | Promise<void>
  protected replicas: (Promise<Pool> | undefined)[]
  protected replicaAttributes: PoolAttributes[]
  protected recoveryTimer?: NodeJS.Timeout

  constructor (config: Partial<PoolOptions> = {}) {
    super()
    this.status = 'up'
    this.onStatus = config?.onStatus
    const threads = parseInt(process.env.UV_THREADPOOL_SIZE ?? '4')
    const poolSizeString = process.env.ORACLE_POOL_SIZE ?? process.env.DB_POOL_SIZE ?? String(Math.max(3, Math.ceil(threads - 3)))
    const poolMax = Math.min(parseInt(poolSizeString), threads)
    /** Accepting the following variables from environment or config to build an Easy-Connect string to provide convenience of not needing to remember Easy-Connect syntax.
     * Note that other connectString formats can be used in conjunction with environment configurations that want to use other connection specifier formats such as Net Service Names or TNS. */
    const primaryHost = config?.server ?? process.env.ORACLE_HOST ?? process.env.ORACLE_SERVER ?? process.env.DB_HOST ?? process.env.DB_SERVER ?? 'oracle'
    const primaryPort = config?.port ?? parseInt(process.env.ORACLE_PORT ?? process.env.DB_PORT ?? '1521')
    const primaryService = config?.service ?? process.env.ORACLE_SERVICE ?? process.env.DB_SERVICE ?? 'xe'
    const primaryUser = config?.user ?? process.env.ORACLE_USER ?? process.env.DB_USER ?? 'system'
    const primaryPass = config?.password ?? process.env.ORACLE_PASS ?? process.env.ORACLE_PASSWORD ?? process.env.DB_PASS ?? process.env.DB_PASSWORD ?? 'oracle'
    const primaryTimeout = `${config?.connectTimeout ?? process.env.ORACLE_CONNECT_TIMEOUT ?? 15}`
    const primaryExternalAuth = config?.externalAuth ?? process.env.ORACLE_EXTERNAL_AUTH === 'true'
    const validityCheckSeconds = String(config?.expireTime ?? 2)
    const easyConnectString = `${primaryHost}:${primaryPort}/${primaryService}?connect_timeout=${primaryTimeout}&expire_time=${validityCheckSeconds}`
    const primaryConnectString = config?.connectString ?? process.env.ORACLE_CONNECT_STRING ?? easyConnectString
    this.poolAttributes = {
      queueMax: 1000,
      connectString: primaryConnectString,
      ...config,
      connectTimeout: parseInt(primaryTimeout, 10),
      expireTime: parseInt(validityCheckSeconds, 10),
      ...(primaryExternalAuth ? { externalAuth: true } : { user: primaryUser, password: primaryPass }),
      poolMax,
      sessionCallback: (connection, requestedTag, cb) => {
        console.info('Connected to Oracle instance: ', primaryConnectString)
        connection.callTimeout = config?.callTimeout ?? 0
        // Add any SESSION ALTER or connection tagging logic here.
        config?.sessionCallback?.(connection, requestedTag).then(() => { cb() }).catch(cb) ?? cb()
      }
    }
    this.queryOptions = {
      lowerCaseColumns: config?.lowerCaseColumns ?? !!process.env.ORACLE_LOWERCASE
    }
    this.replicas = []
    this.replicaAttributes = []
    // If optional replicas are passed in the config push them onto the standardized replicaAttributes array.
    if (config?.replicas?.length) {
      for (const replica of config?.replicas) {
        const timeout = `connect_timeout=${replica.connectTimeout ?? primaryTimeout}`
        const easyConnectString = `${replica.server ?? primaryHost}:${replica.port ?? primaryPort}/${replica.service ?? primaryService}?${timeout}&expire_time=${validityCheckSeconds}`
        const connectString = replica.connectString ?? easyConnectString
        this.replicaAttributes.push({
          ...this.poolAttributes,
          ...replica,
          connectString,
          sessionCallback: (connection, requestedTag, cb) => {
            console.info('Connected to Oracle replica instance: ', connectString)
            connection.callTimeout = replica?.callTimeout ?? config?.callTimeout ?? 0
            // Add any SESSION ALTER or connection tagging logic here.
            config?.sessionCallback?.(connection, requestedTag)
              .then(async () => await replica?.sessionCallback?.(connection, requestedTag))
              .then(() => { cb() })
              .catch(cb) ?? cb()
          }
        })
      }
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    } else if (process.env.ORACLE_REPLICA_SERVICE || process.env.ORACLE_REPLICA_CONNECT_STRING) {
      const timeout = `connect_timeout=${process.env.ORACLE_REPLICA_CONNECT_TIMEOUT ?? primaryTimeout}`
      const easyConnectString = `${process.env.ORACLE_REPLICA_HOST ?? primaryHost}:${process.env.ORACLE_REPLICA_PORT ?? primaryPort}/${process.env.ORACLE_REPLICA_SERVICE ?? primaryService}?${timeout}&expire_time=${validityCheckSeconds}`
      const connectString = process.env.ORACLE_REPLICA_CONNECT_STRING ?? easyConnectString
      const replicaUser = process.env.ORACLE_REPLICA_USER
      const replicaPasswd = process.env.ORACLE_REPLICA_PASS ?? process.env.ORACLE_REPLICA_PASSWORD
      const replicaExternalAuth = process.env.ORACLE_REPLICA_EXTERNAL_AUTH === 'true'
      this.replicaAttributes.push({
        ...this.poolAttributes,
        ...(replicaExternalAuth ? { externalAuth: true } : { ...(replicaUser ? { user: replicaUser } : {}), ...(replicaPasswd ? { password: replicaPasswd } : {}) }),
        connectString,
        sessionCallback: (connection, requestedTag, cb) => {
          console.info('Connected to Oracle replica instance: ', connectString)
          connection.callTimeout = config?.callTimeout ?? 0
          // Add any SESSION ALTER or connection tagging logic here.
          config?.sessionCallback?.(connection, requestedTag).then(() => { cb() }).catch(cb) ?? cb()
        }
      })
    }
  }

  /** Update the pool's `queryOptions` with the passed in `opts: GlobalQueryOptions`. */
  setQueryOptions (opts: GlobalQueryOptions) {
    this.queryOptions = { ...this.queryOptions, ...opts }
  }

  /**
   * Updates the pool's status to `status` if different. If updated it also clears the recoveryTimer interval used
   * to check for recovery when the `status` passed in is not the 'up' status. If the new `status` is not
   * 'up' it sets the recoveryTimer interval to call detectRecovery() in 60 seconds.
   * @param status - One of the `PoolStatus` states.
   * We can consider making this a configuration option at the root of the config. Has to be longer than the connect_timeout.
   * It's a can of worms to get the connect_timeout from all the different configuration options. Might not want to use the oracle-async default unless using the failover feature.
   */
  private setStatus (status: PoolStatus) {
    if (this.status !== status) {
      this.status = status
      if (this.recoveryTimer) clearInterval(this.recoveryTimer)
      if (status !== 'up') {
        this.recoveryTimer = setInterval(() => { this.detectRecovery().catch(e => {}) }, 60000)
      }
      try {
        this.onStatus?.(status)?.catch(console.error)
      } catch (e: any) {
        console.error(e.message)
      }
    }
  }

  /** Checks the primary connection pool to see if connections can now be made to it and updates the pool status using setStatus('up') if so. */
  private async detectRecovery () {
    const conn = await this.pool!.getConnection()
    // if the above line didn't throw, we're back online
    this.setStatus('up')
    await conn.close()
  }

  /**
   * Iterates through the replicaAttributes array attepting connections with the attributes specified.
   *  - Consoles Oracle errors if any errors are thrown trying.
   *  - Sets the pool status to 'readonly' and returns the connection to the first successful attempt.
   *  - If all iterations failed - sets the pool status to 'down' and throws a relevant error.
   * @returns an oracledb.Pool to the first available replica database described in the replicaAttributes array.
   */
  private async getReplicaConnection () {
    for (let i = 0; i < this.replicaAttributes.length; i++) {
      try {
        this.replicas[i] ??= oracledb.createPool(this.replicaAttributes[i])
        let pool: oracledb.Pool
        try {
          pool = await this.replicas[i]!
        } catch (e: any) {
          this.replicas[i] = undefined
          throw (e)
        }
        const conn = await pool.getConnection()
        if (this.status === 'down') this.setStatus('readonly')
        return conn
      } catch (e: any) {
        console.error(e.message)
      }
    }
    this.setStatus('down')
    throw new Error('Connection to replica database could not be established.')
  }

  /**
   * Attempts to instantiate a pool connection using the primary pool options/attributes. If unable, or primary pool is already determined
   * unavailable, it attempts the same with any replica pool attributes that have been defined. If no connection pools can be established
   * the PoolStatus is set to 'down' and an error is thrown in addition to a callback interval being setup to attempt recovery detection.
   * @param mainServer - Specifies that the connection MUST be to the primary instance and should not be used with replicas.
   * @returns an oracledb.Pool to the primary database or first available replica database described in the replicaAttributes array.
   */
  private async getConnection (mainServer: boolean | undefined) {
    if (!mainServer && this.status !== 'up' && this.replicas.length) {
      return await this.getReplicaConnection()
    } else {
      try {
        const conn = await this.pool!.getConnection()
        this.setStatus('up')
        return conn
      } catch (e: any) {
        if (this.replicaAttributes.length) {
          this.setStatus('readonly')
          if (!mainServer) return await this.getReplicaConnection()
        }
        throw e
      }
    }
  }

  /**
   * An overload of the Queryable.query function using QueryOptions instead of InternalOptions for the options parameter type.
   * Checks for an active connection in the class and runs queryWithConn passing that connection. Bubbles any thrown errors to the caller.
   * Finally, this closes the connection as cleanup regardless of a result being returned or an error thrown.
   * @param sql string - The sql query string to execute.
   * @param binds BindInput - The bind values to be used with the sql query string.
   * @param options QueryOptions - Includes: mainServer, saveAsPrepared, lowerCaseColumns and the options specified by the oracledb.ExecuteOption interface.
   * @returns `Promise<ReturnType = DefaultReturnType>` - The result of the query.
   * @note oracledb.ExecuteOption's autoCommit option is hard coded to boolean true.
   */
  async query<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: QueryOptions) {
    await this.wait()
    const conn = await this.getConnection(options?.mainServer)
    try {
      return await this.queryWithConn<ReturnType>(conn, sql, binds, { ...options, autoCommit: true })
    } finally {
      await conn.close()
    }
  }

  /**
   * Instantiates an oracledb.Pool object and loops every two seconds testing that a connection can be made with the
   * configuration supplied by the calling environment or optional config supplied at Db object construction. This
   * function will only return once a connection is successfully made to either the primary instance or any replica
   * instances. */
  async connect () {
    let errorcount = 0
    let mainServer = true
    while (true) {
      try {
        this.pool ??= await oracledb.createPool(this.poolAttributes) // Do we want to continue doing this here or break this out?
        const conn = await this.getConnection(mainServer)
        await conn.close()
        return
      } catch (e: any) {
        if (errorcount > 2) console.error(e.message)
        errorcount++
        // sleep and try again
        if (errorcount > 1) console.info('Unable to connect to Oracle database, trying again in 2 seconds.')
        if (errorcount > 30 && this.replicaAttributes.length) {
          // May want to make errorcount > 30 a configurable option for when we're testing or have different expectations of what's a reasonable number of attempts.
          console.info('Unable to connect to Oracle database for over a minute. Failing over to replica(s).')
          mainServer = false
        }
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  /** Closes the connections in the primary pool with a drain-stop/drainTime of 1 second. */
  async close () {
    await this.wait()
    await this.pool!.close(1)
  }

  /**
   * Passthrough method to return a direct reference to the DB.pool cast as a raw unmodified oracledb.Pool.
   * Intended for use in currently unimplemented Prepared Statements. */
  async rawpool () {
    await this.wait()
    return this.pool as Pool
  }

  /** Function that calls Db.connect() to ensure we're able to make a connection before proceeding. */
  async wait () {
    if (typeof this.connectpromise === 'undefined') this.connectpromise = this.connect()
    await this.connectpromise
  }

  /** Overloaded function - saving review for documentation later. */
  stream<ReturnType = DefaultReturnType> (sql: string, options: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = DefaultReturnType> (sql: string, binds?: BindInput, options?: StreamOptions): GenericReadable<ReturnType>
  stream<ReturnType = DefaultReturnType> (sql: string, bindsOrOptions: any, options?: StreamOptions) {
    const { binds, queryOptions, stream, stacktrace } = this.handleStreamOptions<ReturnType>(sql, bindsOrOptions, options)
    this.wait().then(async () => {
      const conn = await this.getConnection(options?.mainServer)
      if (stream.destroyed) await conn.close()
      else {
        stream.on('close', () => { conn.close().catch(e => { console.error(e) }) })
        this.feedStream(conn, stream, sql, binds, stacktrace, queryOptions)
      }
    }).catch(e => stream.emit('error', e))
    return stream
  }

  /** A utility function provided to create a transaction scope connection to be used for the actions scoped within the `callback` function
   * passed to the transaction function. An optional `options` object parameter can be passed to specify the number of recursive `{ retries: number }`
   * to make in the event of an error being thrown by any of the actions in the callback function.
   * @note There's no need to START, ROLLBACK, or COMMIT the transaction. That is all handled automatically by this transaction wrapper
   * function - according to results of the `callback` function's actions. */
  async transaction <ReturnType> (callback: (db: Queryable) => Promise<ReturnType>, options?: { retries?: number, retryPause?: number }): Promise<ReturnType> {
    await this.wait()
    let retries = options?.retries ?? 0
    const transaction = await this.getConnection(true)
    const db = new Queryable(transaction, this.queryOptions)
    try {
      while (true) {
        try {
          const ret = await callback(db)
          await transaction.commit()
          return ret
        } catch (e: any) {
          if (e.errorNum === 60 && retries > 0) { // deadlock and we will retry after a short pause
            retries--
            await transaction.rollback()
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (options?.retryPause ?? 100))))
          } else {
            throw e
          }
        }
      }
    } finally {
      await transaction.close()
    }
  }
}
