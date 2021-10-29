# Overview
This library has a few core principles:
* Focus on promises and async iterators, do away with callbacks and event-emitting streams
* Make advanced usage optional but easy, e.g.:
  * transactions
  * streaming large result sets
  * prepared statements
* Make it difficult to make a mistake, e.g.:
  * Always use a connection pool
  * Hide everything having to do with acquiring/releasing connections

# Getting Started
## Standard connection
A Db instance represents a connection pool. You will want to make a single pool and export it so that it can
be imported all over your code.
```javascript
import Db from 'oracle-async'
export const db = new Db({
  // you may provide connectString as in oracledb, or you may provide these elements:
  server: 'yourhost',
  port: 1521,
  service: 'xe',
  // row objects will have lowercase keys instead of uppercase
  lowerCaseColumns: true
  ... // the rest of the options match oracledb library
})

async function main() {
  const row = await db.getrow('SELECT ...')
}
main().catch(e => console.error(e))
```
## Connect with environment variables
When working in docker, it's common to keep database configuration in environment variables. In order to
make that easy, this library provides a convenient way to import a singleton pool created with the following
environment variables:
```
  ORACLE_HOST (default 'oracle')
  ORACLE_DATABASE (default 'default_database')
  ORACLE_USER (default 'sa')
  ORACLE_PASS

  UV_THREADPOOL_SIZE (default 4)
  # This controls both the number of threads oracle client starts up with and max connections
  # in the pool, which should match unless you have multiple pools/database servers.
  # In that case, you should set ORACLE_POOL_SIZE to something smaller, and then make sure your
  # pools' max connections all add up to UV_THREADPOOL_SIZE or less

  ORACLE_LOWERCASE
  # If this is truthy, row objects will have lowercase keys instead of uppercase, just a quality
  # of life thing. You can also set this as a default at runtime with `db.setQueryOptions({ lowerCaseColumns: true })`
```
This way, connecting is very simple, and you don't have to worry about creating a singleton pool for the
rest of your codebase to import:
```javascript
import db from 'oracle-async/db'

async function main() {
  const row = await db.getrow('SELECT ...')
}
main().catch(e => console.error(e))
```

## CommonJS imports
You must refer to `.default` when importing with `require`:
```javascript
const db = require('oracle-async/db').default // or
const { default: db } = require('oracle-async/db') // or
const Db = require('oracle-async').default // or
const { default: Db } = require('oracle-async')
```

# Basic Usage
A lot of convenience methods are provided that allow you to specify the kind of operation you are about
to do and the kind of return data you expect.
## Querying
```javascript
const rows = await db.getall('SELECT name FROM mytable')
console.log(rows) // [{ name: 'John' }, { name: 'Maria' }, ...]
const row = await db.getrow('SELECT name FROM mytable WHERE name=:name', { name: 'John' })
console.log(row) // { name: 'John' }
const name = await db.getval('SELECT name FROM mytable WHERE name=:name', { name: 'John' })
console.log(name) // John
const names = await db.getvals('SELECT name FROM mytable WHERE name IN (:name1, :name2)',
  { name1: 'John', name2: 'Maria' })
console.log(names) // ['John', 'Maria']
const rows = await db.getallArray('SELECT name FROM mytable')
// returns rows as array instead of object, improves performance on huge datasets
console.log(rows) // [['John'],['Maria']]
```
## Mutating
```javascript
// Oracle cannot automatically determine the id column; it needs a RETURN...INTO instruction
// If you provide the column name as an option, `RETURN ${options.insertId} INTO :insertid`
// will be added to the query for you
// You can also add your own RETURN ... INTO :insertid
// If you do neither, db.insert will simply return 0
const insertId = await db.insert('INSERT INTO mytable (name) VALUES (:name)', { name: 'Mike' }, { insertId: 'id' })
const rowsUpdated = await db.update('UPDATE mytable SET name=:newname WHERE name=:oldname', { newname: 'Johnny', oldname: 'John' })
const success = await db.execute('CREATE TABLE anothertable ...')
```
## Raw Query
If the convenience methods are hiding something you need from oracle, you can use .query() to get
back whatever would have been returned by oracle.
```javascript
const result = await db.query('INSERT INTO mytable (name) VALUES (:name); UPDATE anothertable SET col1=:col1', { name: 'Mike', col1: 'Value' })
const rowsUpdated = result.rowsAffected
```
## IN helper
Writing queries with `IN` operators can be a little complicated when using named parameters.
A helper is provided that takes your existing bound parameters object and an array to be used for the `IN`.
It generates the SQL while also mutating your existing bound parameters, so that you can easily use it inline.
```javascript
const binds = { author: authorid }
const rows = db.getall(`
  SELECT * FROM mytable
  WHERE author = :author
  AND (
    genre IN (${db.in(binds, genres)}) OR
    title IN (${db.in(binds, titles)})
  )`, binds)
```
# Advanced Usage
## Streaming
### Async Iterable
The async iterable approach is by far the simplest. It works almost exactly like `.getall()`, except
the advantage here is that it does not load the entire result set into memory at one time, which will help
you avoid out-of-memory issues when dealing with thousands or millions of rows.
```javascript
const stream = db.stream('SELECT name FROM mytable')
for await (const row of stream) {
  // work on the row
}
```
`for await` is very safe, as `break`ing the loop or throwing an error inside the loop will clean up the stream appropriately.

Note that `.stream()` returns a node `Readable` in object mode, so you can easily do other things with
it like `.pipe()` it to another stream processor. When using the stream without `for await`, you must call `stream.destroy` if you do not want to finish processing it and carefully use `try {} finally {}` to destroy it in case your code throws an error. Failure to do so will leak a connection from the pool.
### Iterator .next()
Another available approach is to use the iterator pattern directly. This is a standard javascript iterator
that you would receive from anything that supports the async iterator pattern. Probably to be avoided unless
you are working with multiple result sets at the same time (e.g. syncing two tables).
```javascript
const iterator1 = db.iterator('SELECT name FROM mytable')
const iterator2 = db.iterator('SELECT * FROM anothertable')
while (true) {
  const { value: row1, done1 } = await iterator1.next()
  const { value: row2, done2 } = await iterator2.next()
  if (!done1 || !done2) {
    try {
      // do some work to sync the rows
    } catch (e) {
      await iterator1.return()
      await iterator2.return()
      throw e
    }
  } else {
    break
  }
}
```
As illustrated above, an iterator needs to be cleaned up when your code is aborted before reaching the end, or it will leak a connection. Remember to `await iterator.return()` if you are going to abandon the iterator, and inside try/catch/finally blocks in your row processing code. An SQL query error will show up on the first `await iterator.next()` and does not need to be cleaned up.
### streamArray
For very large datasets, you may want to avoid the work of converting rows to objects. You can use `.streamArray()` instead of `.stream()` to do so. Also see `.getallArray()` above.

You can access the column names by listening to the `metadata` event:
```javascript
const stream = db.streamArray('SELECT name FROM mytable')
let colnames = []
stream.on('metadata', metadata => {
  colnames = metadata.map(md => md.name)
})
for await (const row of stream) {
  // work on row
}
```
## Transactions
A method is provided to support working inside a transaction. Since the core Db object is an oracle pool, you
cannot send transaction commands without this method, as each command would end up on a different connection.

To start a transaction, provide a callback that MUST return a promise (just make it async). A new instance of
`db` is provided to the callback; it represents a single connection, inside a transaction. Remember to pass this along to any other functions you call during the transaction - __if you call a function that uses the global `db` object its work will happen outside the transaction!__

You do NOT send `START TRANSACTION`, `ROLLBACK`, or `COMMIT` as these are handled automatically.
```javascript
await db.transaction(async db => {
  // both of these queries happen in the same transaction
  const row = await db.getrow('SELECT * FROM ...')
  await db.update('UPDATE mytable SET ...')
})
```
If you need to roll back, simply throw an error. Similarly, any query that throws an error will trigger
a rollback.
```javascript
await db.transaction(async db => {
  const id = await db.insert('INSERT INTO user ...')
  throw new Error('oops!')
}) // the INSERT will be rolled back and will not happen
```
### Retrying Deadlocks
`db.transaction()` accepts an `options` parameter allowing you to set a maximum number of retries allowed upon deadlock:
```javascript
await db.transaction(async db => {
  const row = await db.getrow('SELECT * FROM ...')
  await db.update('UPDATE mytable SET ...')
}, { retries: 1 })
```
If this transaction is the loser of a deadlock, it will retry the whole transaction once, including refetching the `getrow` statement.
## Prepared Statements
Support for prepared statements is planned but not yet implemented. If you need it, you
can access the raw `Pool` object with `await db.rawpool()` and follow the `oracledb` documentation.

## Timezones
Working with timezones can be very confusing. Where possible you should use the `TIMESTAMP WITH TIME ZONE` type
so that the time zone is stored alongside every date.
## Typescript
This library is written in typescript and provides its own types. For added convenience, methods that return
rows or values will accept a generic so that you can specify the return type you expect:
```typescript
interface Book {
  id: number
  title: string
  isbn: string
}
const row = await db.getrow<Book>('SELECT id, title, isbn FROM books WHERE id=@id', { id: 5 })
// `row` is a `Book`
const rows = await db.getall<Book>('SELECT id, title, isbn FROM books')
// `rows` is a `Book[]`
const stream = db.stream<Book>('SELECT id, title, isbn FROM books')
for await (const row of stream) {
  // `row` is a `Book`
}
const insertId = await db.insert<string>('INSERT INTO mytable (name) VALUES (:name)', { name: 'Mike' }, { insertId: 'id' })
// insertId is a string (default is number)
```
