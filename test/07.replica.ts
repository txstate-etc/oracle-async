import { expect } from 'chai'
import Db from '../src'

const db = new Db({
  port: 3333,
  replicas: [{
    port: 1521
  }]
})

describe('connecting to replica servers', () => {
  it('eventually connects to the replica server', async () => {
    await db.getval('SELECT 1 FROM test')
    expect(db.status).to.equal('readonly')
  }).timeout(100000)
  it('should error trying to write to replica server', async () => {
    try {
      await db.update('UPDATE test SET name="never"')
      expect.fail('should have thrown')
    } catch (e: any) {
      expect(e.message).to.match(/no listener/i)
    }
  })
  it('should error trying to open a transaction on the replica server', async () => {
    try {
      await db.transaction(async db => {
        await db.getval('SELECT 1 FROM test')
      })
      expect.fail('should have thrown')
    } catch (e: any) {
      expect(e.message).to.match(/no listener/i)
    }
  })
})
