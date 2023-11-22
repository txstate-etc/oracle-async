/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import db from '../src/db'

describe('basic tests', () => {
  it('should be able to create a couple test tables', async () => {
    await Promise.all([
      db.execute(`CREATE TABLE test (
        id INT NOT NULL PRIMARY KEY,
        name VARCHAR(100),
        modified TIMESTAMP WITH TIME ZONE
      )`),
      db.execute(`CREATE TABLE test2 (
        id INT NOT NULL PRIMARY KEY,
        name VARCHAR(100),
        modified TIMESTAMP WITH TIME ZONE
      )`)
    ])
    await db.execute('CREATE SEQUENCE testseq')
    await db.execute('CREATE SEQUENCE test2seq')
    await db.execute(`CREATE TRIGGER testtrigger BEFORE INSERT ON test FOR EACH ROW
    BEGIN
      :new.id := testseq.NEXTVAL;
    END;
    `)
    await db.execute(`CREATE TRIGGER test2trigger BEFORE INSERT ON test2 FOR EACH ROW
    BEGIN
      :new.id := test2seq.NEXTVAL;
    END;
    `)

    const count = await db.getval("SELECT COUNT(*) FROM user_tables WHERE table_name IN ('TEST', 'TEST2')")
    expect(count).to.be.greaterThan(0)
  }).timeout(10000)

  it('should be able to add test data', async () => {
    const thousand = Array.from(Array(1000))
    const values = `
    WITH insertrows AS (
      ${thousand.map((_, i) => `SELECT 'name ${i}', CURRENT_TIMESTAMP from dual`).join(' union all\n')}
    )
    SELECT * FROM insertrows
    `
    await db.insert(`INSERT INTO test (name, modified) ${values}`, {})
  }).timeout(10000)

  it('should be able to add more test data', async () => {
    const thousand = Array.from(Array(1000))
    const values = `
    WITH insertrows AS (
      ${thousand.map((_, i) => `SELECT 'name ${i}', CURRENT_TIMESTAMP from dual`).join(' union all\n')}
    )
    SELECT * FROM insertrows
    `
    await db.insert(`INSERT INTO test2 (name, modified) ${values}`, {})
  }).timeout(10000)

  it('should be able to select all rows', async () => {
    const rows = await db.getall('SELECT * FROM test')
    expect(rows?.length).to.equal(1000)
    expect(rows[0].name).to.be.a('string')
  })

  it('should be able to select all rows as arrays', async () => {
    const rows = await db.getallArray('SELECT name FROM test')
    expect(rows?.length).to.equal(1000)
    expect(rows[0][0]).to.be.a('string')
  })

  it('should be able to select a single row', async () => {
    const row = await db.getrow<{ name: string }>('SELECT * FROM test WHERE name=:name', { name: 'name 3' })
    expect(row?.name).to.equal('name 3')
  })

  it('should be able to select a single column in a single row', async () => {
    const name = await db.getval<string>('SELECT name FROM test WHERE name=:name', { name: 'name 3' })
    expect(name).to.equal('name 3')
  })

  it('should be able to select a single column in multiple rows', async () => {
    const names = await db.getvals<string>('SELECT * FROM (SELECT name FROM test ORDER BY name) WHERE ROWNUM <= 5')
    expect(names[3]).to.equal('name 100')
    expect(names).to.have.lengthOf(5)
  })

  it('should be able to update a row', async () => {
    const rows = await db.update('UPDATE test SET name=:newname WHERE name=:existing', { newname: 'name 1002', existing: 'name 999' })
    expect(rows).to.equal(1)
    const [newrow, oldrow] = await Promise.all([
      db.getrow('SELECT * FROM test WHERE name=:name', { name: 'name 1002' }),
      db.getrow('SELECT * FROM test WHERE name=:name', { name: 'name 999' })
    ])
    expect(newrow).to.exist
    expect(oldrow).to.be.undefined
  })

  it('should properly release connections back to the pool when a query has a syntax error', async () => {
    let errorthrown = false
    for (let i = 0; i < 15; i++) {
      try {
        const rows = await db.getall('SELECT * FROM test3 WHERE rownum <= 100')
      } catch (e) {
        errorthrown = true
      }
    }
    // if syntax errors eat connections then it will hang indefinitely after 10 transactions
    // getting this far means things are working
    expect(errorthrown).to.be.true
  })

  it('should help you construct IN queries', async () => {
    const params = {}
    const rows = await db.getall(`SELECT * FROM test WHERE name IN (${db.in(params, ['name 2', 'name 5'])}) OR name IN (${db.in(params, ['name 8', 'name 9'])})`, params)
    expect(rows).to.have.lengthOf(4)
  })

  it('should help you construct IN queries when params is an array', async () => {
    const params: any[] = []
    const rows = await db.getall(`SELECT * FROM test WHERE name IN (${db.in(params, ['name 2', 'name 5'])}) OR name IN (${db.in(params, ['name 8', 'name 9'])})`, params)
    expect(rows).to.have.lengthOf(4)
  })

  it('should help you construct IN queries involving tuples', async () => {
    let params: any[] = []
    let rows = await db.getall(`SELECT * FROM test WHERE (id, name) IN (${db.in(params, [[3, 'name 2'], [6, 'name 5']])}) OR (id, name) IN (${db.in(params, [[9, 'name 8'], [10, 'name 9']])})`, params)
    expect(rows).to.have.lengthOf(4)
    params = []
    rows = await db.getall(`SELECT * FROM test WHERE (id, name) IN (${db.in(params, [[4, 'name 2'], [6, 'name 5']])}) OR (id, name) IN (${db.in(params, [[9, 'name 8'], [10, 'name 9']])})`, params)
    expect(rows).to.have.lengthOf(3)
  })

  it('should help you construct IN queries with named parameters involving tuples', async () => {
    let params: Record<string, string> = {}
    let rows = await db.getall(`SELECT * FROM test WHERE (id, name) IN (${db.in(params, [[3, 'name 2'], [6, 'name 5']])}) OR (id, name) IN (${db.in(params, [[9, 'name 8'], [10, 'name 9']])})`, params)
    expect(rows).to.have.lengthOf(4)
    params = {}
    rows = await db.getall(`SELECT * FROM test WHERE (id, name) IN (${db.in(params, [[4, 'name 2'], [6, 'name 5']])}) OR (id, name) IN (${db.in(params, [[9, 'name 8'], [10, 'name 9']])})`, params)
    expect(rows).to.have.lengthOf(3)
  })

  it('should show the library consumer in the error stacktrace when a query errors', async () => {
    try {
      await db.getval('SELECT blah FROM test')
      expect(true).to.be.false('should have thrown for SQL error')
    } catch (e: any) {
      // NOTE: requires node 14
      expect(e.stack).to.match(/01\.basic\.ts/)
    }
  })
})
