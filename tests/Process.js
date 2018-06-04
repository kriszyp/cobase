const { Persisted } = require('..')
const { TestProcess } = require('./model/TestProcess')
const { removeSync } = require('fs-extra')
suite('Process', () => {
	Persisted.dbFolder = 'tests/db'
//	Persistable.dbFolder = 'tests/db'
	suiteSetup(() => {
	})

	test('run-in-process', () => {
		TestProcess.for(10).put({ name: 'ten' })
		return TestProcess.for(10).then(value => {
			assert.equal(value.name, 'ten')
			return TestProcess.instanceIds.then(ids => {
				assert.deepEqual(ids, [10])
				TestProcess.for(10).delete()
				return TestProcess.for(10).then(value => {
					assert.isUndefined(value)
				})
			})
		})
	})

	/*
	suiteTeardown(() => {
		return Promise.all([
			Test2.db.close(),
			TestIndex.db.close()
		])
	})*/
})
