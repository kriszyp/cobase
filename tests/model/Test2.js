const { Persisted, Persistable, Index, Reduced } = require('../..')
Persisted.dbFolder = 'tests/db'
Persistable.dbFolder = 'tests/db'
class Test2 extends Persisted {

}
Test2.version = 1
Test2.start()
class TestByType extends Index.from(Test2) {
	static indexBy(test) {
		return test.isEven ? 'even' : 'odd'
	}
}
TestByType.version = 1
TestByType.start()
let reduceCalls = 0
class SumOfNumbersByType extends Reduced.from(TestByType) {
	reduceBy(a, b) {
		reduceCalls++
		return {
			number: a.number + b.number
		}
	}
	transform(total) {
		return total.number
	}
	static get reduceCalls() {
		return reduceCalls
	}
}
SumOfNumbersByType.version = 1
SumOfNumbersByType.start()
exports.Test2 = Test2
exports.TestByType = TestByType
exports.SumOfNumbersByType = SumOfNumbersByType
