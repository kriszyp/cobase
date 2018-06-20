const { Persisted, Cached } = require('..')
const { Test, TestCached } = require('./model/TestCached')
const { removeSync } = require('fs-extra')
removeSync('tests/db')
suite.only('Persisted', () => {
	Persisted.dbFolder = 'tests/db'
	Cached.dbFolder = 'tests/db'
	suiteSetup(() => {
	})

	test('standalone table', () => {
		return Test.for(10).put({ name: 'ten' }).then(() =>
			Test.for(10).then(value => {
				assert.equal(value.name, 'ten')
				return Test.instanceIds.then(ids => {
					assert.deepEqual(ids, [10])
				})
			})
		)
	})
	test('cached transform', () => {
		return TestCached.for(10).then(value => {
			assert.equal(value.upperName, 'TEN')
		})
	})

	/*
	suiteTeardown(() => {
		console.log('teardown persisted')
		return Promise.all([
			Test.db.close(),
			TestCached.db.close()
		])
	})*/
})
