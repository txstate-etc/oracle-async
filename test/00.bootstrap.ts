/* global before */
import Db from '../src'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
chai.use(chaiAsPromised)

before(async function () {
  this.timeout(100000)
  const db = new Db()
  const count = await db.getval("SELECT COUNT(*) FROM user_tables WHERE table_name IN ('TEST', 'TEST2')")
  if (count) {
    await db.execute('DROP TABLE test')
    await db.execute('DROP SEQUENCE testseq')
    await db.execute('DROP TABLE test2')
    await db.execute('DROP SEQUENCE test2seq')
  }
})
