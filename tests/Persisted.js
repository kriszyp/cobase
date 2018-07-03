const { Persisted, Cached } = require('..')
const { Test, TestCached } = require('./model/TestCached')
suite.only('Persisted', function() {
	this.timeout(100000)
	suiteSetup(() => {
	})

	test('standalone table', () => {
		Test.for(10).put({ name: 'ten' }).then(() =>
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
