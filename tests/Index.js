const { Persisted, Persistable, Index } = require('..')
const { removeSync } = require('fs-extra')
suite('Index', () => {
	Persisted.dbFolder = 'tests/db'
	Persistable.dbFolder = 'tests/db'
	class Test2 extends Persisted {

	}
	class TestIndex extends Index.from(Test2) {
		static indexBy(test) {
			console.log('indexing test', test)
			return [{
				key: test.name,
				value: test
			}]
		}
	}
	suiteSetup(() => {
		return Promise.all([
			Test2.register({ version: 1 }),
			TestIndex.register({ version: 1 })
		]).then(() => {
			Test2.for(10).put({ name: 'ten' })
			return Test2.whenFullyReadable
		})
	})

	test('index', () => {
		return TestIndex.for('ten').then(value => {
			assert.equal(value[0].name, 'ten')
		})
	})/*
	suiteTeardown(() => {
		return Promise.all([
			Test2.db.close(),
			TestIndex.db.close()
		])
	})*/
})
