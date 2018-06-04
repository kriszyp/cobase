const { Persisted, Cached } = require('..')
const { removeSync } = require('fs-extra')
removeSync('tests/db')
suite('Persisted', () => {
	Persisted.dbFolder = 'tests/db'
	Cached.dbFolder = 'tests/db'
	class Test extends Persisted {
	}
	Test.version = 1
	class TestCached extends Cached.from(Test) {
		transform(test) {
			return {
				upperName: test.name.toUpperCase()
			}
		}
	}
	TestCached.version = 1
	suiteSetup(() => {
	})

	test('standalone table', () => {
		Test.for(10).put({ name: 'ten' })
		return Test.for(10).then(value => {
			assert.equal(value.name, 'ten')
			return Test.instanceIds.then(ids => {
				assert.deepEqual(ids, [10])
			})
		})
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
