// this provides a weak-valued map to ensure we only have a single instance of an object per id, but can still be GC-ed
try {
	let NativeWeakValueMap = require('weakvaluemap')
	let allInstances = []
	function WeakValueMap() {
		let map = new NativeWeakValueMap()
		allInstances.push(map)
		return map
	}
	WeakValueMap.getStatus = function() {
		let mapStats = []
		for (let map of allInstances) {
			let size = 0
			let count = 0
			for (let key of map.keys()) {
				let value = map.get(key)
				size += value && value.approximateSize || 100
				count++
			}
			if (count > 0) {
				mapStats.push({
					name: map.name,
					size,
					count
				})
			}
		}
		return mapStats
	}
	exports.default = WeakValueMap
} catch (error) {
	console.warn('No weak value map available, this can be used for development, but weak value maps should be enabled for production use', error.toString())
	exports.default = Map
	Map.getStatus = function() {
		return 'WeakValueMap failed to load'
	}
}
exports.WeakValueMap = exports.default
