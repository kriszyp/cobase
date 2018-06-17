const { Persisted } = require('..')
const { TestProcess, TestProcessByName } = require('./model/TestProcess')
const { removeSync } = require('fs-extra')
suite.only('Process', () => {
	Persisted.dbFolder = 'tests/db'
//	Persistable.dbFolder = 'tests/db'
	suiteSetup(() => {
	})

	test('run-in-process', () => {
		TestProcess.for(10).put({ name: 'ten' })
		console.log('sent ten')
		return TestProcess.for(10).then(value => {
			console.log('got response')
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
	test('run-in-process with index', () => {
		TestProcess.for(10).put({ name: 'ten' }).then(() =>
			TestProcessByName.for('ten').then(value => {
				console.log('got response for index of ten')
				assert.equal(value[0].name, 'ten')
				return TestProcess.for(10).delete().then(() =>
					TestProcessByName.for('ten').then(value => {
						assert.equal(value.length, 0)
					})
				)
			})
		)
	})

	/*
	suiteTeardown(() => {
		return Promise.all([
			Test2.db.close(),
			TestIndex.db.close()
		])
	})*/
})
