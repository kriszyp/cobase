const { Persisted, Cached } = require('../..')
Persisted.updatingProcessModule = 'tests/updating-process'
Cached.updatingProcessModule = 'tests/updating-process'
class Test extends Persisted {
}
exports.Test = Test
Test.version = 1
Test.ready
class TestCached extends Cached.from(Test) {
	transform(test) {
		return {
			upperName: test.name.toUpperCase()
		}
	}
}
TestCached.version = 1
exports.TestCached = TestCached
TestCached.ready
