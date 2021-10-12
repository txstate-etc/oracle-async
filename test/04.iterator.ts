/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import db from '../src/db'

describe('iterator tests', () => {
  it('should be able to return an AsyncIterableIterator', async () => {
    const iter = db.iterator('SELECT * FROM test')
    let finished = false
    let count = 0
    while (!finished) {
      const result = await iter.next()
      finished = result.done ?? false
      if (!finished) {
        expect(result?.value?.name).to.match(/^name \d+$/)
        count++
      }
    }
    expect(count).to.equal(1001)
  })
  it('should throw an error on the first iterator.next() if the query errors', async () => {
    const iter = db.iterator('SELECT blah FROM test')
    try {
      await iter.next()
      expect(true).to.be.false('next() should have errored')
    } catch (e: any) {
      expect(e.errorNum).to.be.greaterThan(0)
    }
  })
  it('should properly release connections back to the pool with iterator syntax', async () => {
    for (let i = 0; i < 15; i++) {
      const iterator = db.iterator('SELECT * FROM test WHERE rownum <= 100')
      while (true) {
        const { done, value: row } = await iterator.next()
        if (done) break
        expect(row?.name).to.match(/name \d+/)
      }
    }
    // if iterators eat connections then it will hang indefinitely after 10 transactions
    // getting this far means things are working
    expect(true).to.be.true
  })
  it('should properly release connections back to the pool if an iterator errors', async () => {
    for (let i = 0; i < 15; i++) {
      try {
        const iterator = db.iterator('SELECT blah FROM test')
        while (true) {
          const { done, value: row } = await iterator.next()
          if (done) break
        }
      } catch (e) {
        // do nothing
      }
    }
    // if iterators eat connections then it will hang indefinitely after 10 transactions
    // getting this far means things are working
    expect(true).to.be.true
  })
  it('should properly release connections back to the pool if an iterator stops processing', async () => {
    for (let i = 0; i < 15; i++) {
      const iterator = db.iterator('SELECT * FROM test WHERE rownum <= 100')
      let loopcount = 0
      for (let { done, value: row } = await iterator.next(); !done; { done, value: row } = await iterator.next()) {
        loopcount++
        expect(row?.name).to.match(/name \d+/)
        await iterator.return()
      }
      expect(loopcount).to.equal(1)
    }
    // if canceled iterators eat connections then it will hang indefinitely after 10 transactions
    // getting this far means things are working
    expect(true).to.be.true
  })
})
